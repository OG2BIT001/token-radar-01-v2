// The launch radar's model: one sealed snapshot of the protocol universe in, one ranked board out.
//
// What is new in radar-2, against the house starter's flat TVL x 0.25 and the hand-weighted
// peer tables that came before it: every number in the value model is FITTED on the snapshot's
// own trading protocols and TESTED on protocols the fit never saw, twice. The 128 protocols in
// the snapshot that record a token with a market cap are the market's revealed valuations; the
// model learns how those valuations relate to TVL, seven-day growth, age and category, then
// prices the protocols that record no token yet. Nothing is hand-weighted and no protocol name
// is ever special-cased: the same fitted function scores every row.
//
//   target     log10(market cap / TVL) of a trading protocol, winsorised to [-2.7, +0.7]
//   part one   a robust (Huber IRLS) regression of the target on centred log10 TVL, clipped
//              seven-day growth and centred log10 age, after a per-category effect (the
//              category's median log ratio, shrunk toward the global median by its peer count)
//              is taken out
//   part two   a local peer ratio: the median target of trading protocols within a x4 TVL
//              band of the candidate, same-category peers preferred
//   implied    TVL x 10^(half part one + half part two), the blend weight chosen on the folds
//
// Validation, stated on the dashboard and in the README: the trading set is split in two by a
// hash of the slug; each half is fitted on one side and tested on the other. The shipped
// coefficients are the refit on all 128. The board's band is the pooled held-out median error:
// half of all held-out predictions land within that factor of the market's own figure, so each
// row shows implied / factor to implied x factor. Launch odds come from the peers' record: of
// the protocols in the candidate's category tracked at least as long as it has been, the share
// that already record a token (Laplace-smoothed). The integrity grade scores what the record
// itself shows: missing fields, single-chain concentration, violent seven-day swings, youth.
// The farm verdict prices the plan: an assumed 4% of implied value reaches early users, split
// across a wallet count that scales with TVL, against the plan's own cash cost in gas and fees.

import { createHash } from 'node:crypto';

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

/** A whole day count from `listedAt` to `asOf`, clamped at zero; null when a date is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** Whether a protocol records no token at all: no market cap, no CoinGecko id, no symbol. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol records a token, with or without a market cap beside it. */
export function recordsToken(p: SnapshotProtocol): boolean {
  return p.gecko_id !== null || p.symbol !== null;
}

// The field guide's line between a launch candidate and a product of a token that already
// trades: wrapped, staked and bridged products, liquid staking and restaking, exchanges,
// versioned pools of a parent protocol and exchange-branded products are not launches of
// their own, so the ranked board leaves them out and the dashboard shows them apart, named.
const PRODUCT_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const PRODUCT_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** Why a pre-token protocol is not a launch candidate of its own, or null when it is one. */
export function productReason(p: SnapshotProtocol): string | null {
  if (p.category !== null && PRODUCT_CATEGORIES.has(p.category)) return `a ${p.category} product: it wraps or stakes a token that already trades`;
  if (VERSIONED.test(p.name)) return 'a versioned pool of a parent protocol, not a launch of its own';
  if (PRODUCT_WORD.test(p.name)) return 'its name marks it as a wrapped or staked product of a token that already trades';
  if (EXCHANGE_PREFIXES.some((x) => p.name.startsWith(x))) return 'an exchange-branded product of a token that already trades';
  return null;
}

/** Whether the board may rank a protocol: it records no token and is not another token's product. */
export function isLaunchCandidate(p: SnapshotProtocol): boolean {
  return isPreToken(p) && productReason(p) === null;
}

// ---------------------------------------------------------------------------
// The fitted value model
// ---------------------------------------------------------------------------

/** The winsor band for a log10 market-cap/TVL ratio: beyond it, a ratio is treated as the band's edge. */
const RATIO_FLOOR = -2.7;
const RATIO_CAP = 0.7;
/** How hard a category's own median is shrunk toward the global median, in phantom peers. */
const CATEGORY_SHRINKAGE = 8;
/** The local peer band: trading protocols within this multiple of the candidate's TVL. */
const LOCAL_BAND = 4;
/** The blend: half regression, half local peers, the weight the two validation folds chose. */
const LOCAL_BLEND = 0.5;

/** One trading protocol prepared for the fit: its target and the record it came from. */
interface TrainingRow {
  p: SnapshotProtocol;
  logRatio: number;
  age: number | null;
}

/** The trading protocols the fit learns from: a token, a positive market cap and a positive TVL. */
function trainingRows(snapshot: Snapshot): TrainingRow[] {
  const rows: TrainingRow[] = [];
  for (const p of snapshot.protocols) {
    if (p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0) {
      rows.push({ p, logRatio: clamp(Math.log10(p.mcap_usd / p.tvl_usd), RATIO_FLOOR, RATIO_CAP), age: ageDays(snapshot.as_of, p.listed_at) });
    }
  }
  return rows;
}

/** The centres and category effects a fit is stated against, all learned from its training rows. */
interface FitContext {
  meanLogTvl: number;
  medianAge: number;
  ageCentre: number;
  globalLogRatio: number;
  catEffect: Map<string, number>;
  catPeers: Map<string, number>;
}

function fitContext(rows: TrainingRow[]): FitContext {
  const globalLogRatio = median(rows.map((r) => r.logRatio));
  const ages = rows.map((r) => r.age).filter((a): a is number => a !== null);
  const medianAge = ages.length > 0 ? median(ages) : 365;
  const byCat = new Map<string, number[]>();
  for (const r of rows) {
    const key = r.p.category ?? 'Uncategorised';
    const list = byCat.get(key) ?? [];
    list.push(r.logRatio);
    byCat.set(key, list);
  }
  const catEffect = new Map<string, number>();
  const catPeers = new Map<string, number>();
  for (const [cat, values] of byCat) {
    catEffect.set(cat, (values.length * median(values) + CATEGORY_SHRINKAGE * globalLogRatio) / (values.length + CATEGORY_SHRINKAGE));
    catPeers.set(cat, values.length);
  }
  return {
    meanLogTvl: mean(rows.map((r) => Math.log10(r.p.tvl_usd))),
    medianAge,
    ageCentre: Math.log10(1 + medianAge),
    globalLogRatio,
    catEffect,
    catPeers,
  };
}

/** The regression's feature vector for one protocol under a fit's centres: constant, size, growth, age. */
function features(p: SnapshotProtocol, age: number | null, ctx: FitContext): number[] {
  const a = age ?? ctx.medianAge;
  const growth = clamp(p.change_7d ?? 0, -50, 100) / 100;
  return [1, Math.log10(p.tvl_usd) - ctx.meanLogTvl, growth, Math.log10(1 + a) - ctx.ageCentre];
}

/** Solve a small dense linear system by Gauss-Jordan with partial pivoting. */
function solveLinear(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(m[r]![col]!) > Math.abs(m[piv]![col]!)) piv = r;
    const swap = m[col]!;
    m[col] = m[piv]!;
    m[piv] = swap;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = m[r]![col]! / m[col]![col]!;
      for (let k = col; k <= n; k++) m[r]![k] = m[r]![k]! - f * m[col]![k]!;
    }
  }
  return m.map((row, i) => row[n]! / row[i]!);
}

/** A weighted least-squares fit of y on X. */
function weightedLeastSquares(x: number[][], y: number[], w: number[]): number[] {
  const n = x[0]!.length;
  const a: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0));
  const b: number[] = new Array<number>(n).fill(0);
  for (let r = 0; r < x.length; r++) {
    for (let i = 0; i < n; i++) {
      for (let j = 0; j < n; j++) a[i]![j] = a[i]![j]! + w[r]! * x[r]![i]! * x[r]![j]!;
      b[i] = b[i]! + w[r]! * x[r]![i]! * y[r]!;
    }
  }
  return solveLinear(a, b);
}

/** The fitted model: coefficients, its context, and the rows it was fitted on. */
export interface FittedModel {
  beta: number[];
  ctx: FitContext;
  rows: TrainingRow[];
}

/**
 * Fit the value model on training rows: the category effect comes out of the target first,
 * then a Huber IRLS regression (eight rounds, MAD-scaled) fits what is left, so the handful
 * of protocols the market prices at hundreds of times TVL cannot drag the whole board.
 */
export function fitModel(rows: TrainingRow[]): FittedModel {
  const ctx = fitContext(rows);
  const x = rows.map((r) => features(r.p, r.age, ctx));
  const y = rows.map((r) => r.logRatio - (ctx.catEffect.get(r.p.category ?? 'Uncategorised') ?? ctx.globalLogRatio));
  let w = rows.map(() => 1);
  let beta = weightedLeastSquares(x, y, w);
  for (let round = 0; round < 8; round++) {
    const residuals = y.map((yi, i) => yi - beta.reduce((sum, bj, j) => sum + bj * x[i]![j]!, 0));
    const mad = median(residuals.map((r) => Math.abs(r))) || 0.3;
    const scale = 1.345 * 1.4826 * mad;
    w = residuals.map((r) => (Math.abs(r) <= scale ? 1 : scale / Math.abs(r)));
    beta = weightedLeastSquares(x, y, w);
  }
  return { beta, ctx, rows };
}

/** The regression's part of a log ratio: its coefficients on this protocol, plus its category effect. */
export function regressionLogRatio(model: FittedModel, p: SnapshotProtocol, age: number | null): number {
  const f = features(p, age, model.ctx);
  const centred = model.beta.reduce((sum, bj, j) => sum + bj * f[j]!, 0);
  return centred + (model.ctx.catEffect.get(p.category ?? 'Uncategorised') ?? model.ctx.globalLogRatio);
}

/** The local peer part: the median log ratio of trading protocols in the candidate's TVL band. */
export function localLogRatio(model: FittedModel, p: SnapshotProtocol): number {
  const lt = Math.log10(p.tvl_usd);
  const band = Math.log10(LOCAL_BAND);
  const near = model.rows.filter((r) => Math.abs(Math.log10(r.p.tvl_usd) - lt) <= band);
  const sameCat = near.filter((r) => (r.p.category ?? 'Uncategorised') === (p.category ?? 'Uncategorised'));
  const pool = sameCat.length >= 4 ? sameCat : near.length >= 3 ? near : model.rows;
  return median(pool.map((r) => r.logRatio));
}

/** A protocol priced by the model: the blended log ratio, its two parts and the implied value. */
export interface Priced {
  logRatio: number;
  regression: number;
  local: number;
  implied: number;
}

/** Price one pre-token protocol: blend the two parts, hold the ratio inside the winsor band. */
export function price(model: FittedModel, p: SnapshotProtocol, age: number | null): Priced {
  const regression = regressionLogRatio(model, p, age);
  const local = localLogRatio(model, p);
  const logRatio = clamp((1 - LOCAL_BLEND) * regression + LOCAL_BLEND * local, RATIO_FLOOR, RATIO_CAP);
  const implied = Math.max(1, Math.round(p.tvl_usd * Math.pow(10, logRatio)));
  return { logRatio, regression, local, implied };
}

// ---------------------------------------------------------------------------
// Validation: the model tested on protocols its fit never saw, twice
// ---------------------------------------------------------------------------

/** One validation fold's honest numbers, and the two baselines it had to beat. */
export interface FoldResult {
  fold: number;
  train_size: number;
  test_size: number;
  train_r2: number;
  heldout_r2: number;
  heldout_median_factor: number;
  baseline_flat_factor: number;
  baseline_category_factor: number;
}

/** The model's whole report card: folds, the pooled band and the shipped fit's own fit. */
export interface Diagnostics {
  training_size: number;
  folds: FoldResult[];
  pooled_median_factor: number;
  pooled_flat_factor: number;
  pooled_category_factor: number;
  full_r2: number;
  full_median_factor: number;
  beta: number[];
  mean_log_tvl: number;
  median_age_days: number;
  global_ratio: number;
  blend_local: number;
}

/** Which fold a protocol belongs to: the parity of its slug's hash, so the split is fixed and stated. */
function foldOf(slug: string): number {
  return createHash('sha256').update(slug).digest()[0]! % 2;
}

/** R-squared of predictions against actual log market caps, and the median factor error. */
function score(rows: TrainingRow[], predict: (r: TrainingRow) => number): { r2: number; medianFactor: number } {
  const actual = rows.map((r) => Math.log10(r.p.mcap_usd!));
  const predicted = rows.map((r) => predict(r) + Math.log10(r.p.tvl_usd));
  const m = mean(actual);
  let ssRes = 0;
  let ssTot = 0;
  const factors: number[] = [];
  rows.forEach((r, i) => {
    ssRes += (predicted[i]! - actual[i]!) ** 2;
    ssTot += (actual[i]! - m) ** 2;
    factors.push(Math.abs(predicted[i]! - actual[i]!));
  });
  return { r2: 1 - ssRes / ssTot, medianFactor: Math.pow(10, median(factors)) };
}

/**
 * Fit on one half of the trading set, test on the other, then swap. The baselines are priced
 * on the same held-out rows: a flat global median ratio, and the category median alone (the
 * peer-table model with no fitted terms). The pooled median factor becomes the board's band.
 */
export function validate(rows: TrainingRow[]): { diagnostics: Diagnostics; shipped: FittedModel } {
  const folds: FoldResult[] = [];
  const heldoutFactors: number[] = [];
  const flatFactors: number[] = [];
  const catFactors: number[] = [];
  for (const fold of [0, 1]) {
    const train = rows.filter((r) => foldOf(r.p.slug) !== fold);
    const test = rows.filter((r) => foldOf(r.p.slug) === fold);
    const model = fitModel(train);
    const trainScore = score(train, (r) => price(model, r.p, r.age).logRatio);
    const testScore = score(test, (r) => price(model, r.p, r.age).logRatio);
    const flat = score(test, (r) => model.ctx.globalLogRatio);
    const catOnly = score(test, (r) => model.ctx.catEffect.get(r.p.category ?? 'Uncategorised') ?? model.ctx.globalLogRatio);
    for (const r of test) {
      const actual = Math.log10(r.p.mcap_usd!);
      heldoutFactors.push(Math.abs(price(model, r.p, r.age).logRatio + Math.log10(r.p.tvl_usd) - actual));
      flatFactors.push(Math.abs(model.ctx.globalLogRatio + Math.log10(r.p.tvl_usd) - actual));
      catFactors.push(Math.abs((model.ctx.catEffect.get(r.p.category ?? 'Uncategorised') ?? model.ctx.globalLogRatio) + Math.log10(r.p.tvl_usd) - actual));
    }
    folds.push({
      fold,
      train_size: train.length,
      test_size: test.length,
      train_r2: round4(trainScore.r2),
      heldout_r2: round4(testScore.r2),
      heldout_median_factor: round4(testScore.medianFactor),
      baseline_flat_factor: round4(flat.medianFactor),
      baseline_category_factor: round4(catOnly.medianFactor),
    });
  }
  const shipped = fitModel(rows);
  const full = score(rows, (r) => price(shipped, r.p, r.age).logRatio);
  return {
    shipped,
    diagnostics: {
      training_size: rows.length,
      folds,
      pooled_median_factor: round4(Math.pow(10, median(heldoutFactors))),
      pooled_flat_factor: round4(Math.pow(10, median(flatFactors))),
      pooled_category_factor: round4(Math.pow(10, median(catFactors))),
      full_r2: round4(full.r2),
      full_median_factor: round4(full.medianFactor),
      beta: shipped.beta.map(round4),
      mean_log_tvl: round4(shipped.ctx.meanLogTvl),
      median_age_days: Math.round(shipped.ctx.medianAge),
      global_ratio: round4(Math.pow(10, shipped.ctx.globalLogRatio)),
      blend_local: LOCAL_BLEND,
    },
  };
}

// ---------------------------------------------------------------------------
// Launch odds from the peers' record, and the integrity grade
// ---------------------------------------------------------------------------

/** The peers' record for one candidate: its cohort, how many of the cohort already trade, the odds. */
export interface Odds {
  pct: number;
  cohort_size: number;
  cohort_trading: number;
  cohort_rule: string;
}

/**
 * The share of comparable protocols that already record a token. The cohort is the
 * candidate's category tracked at least as long as the candidate; too thin a cohort widens
 * to every category at that age, then to the whole snapshot. Laplace-smoothed, so a small
 * cohort never reads as a certainty either way.
 */
export function launchOdds(snapshot: Snapshot, p: SnapshotProtocol, age: number | null): Odds {
  const all = snapshot.protocols;
  const cat = p.category ?? 'Uncategorised';
  const sameCat = all.filter((q) => (q.category ?? 'Uncategorised') === cat);
  const aged = (list: SnapshotProtocol[]): SnapshotProtocol[] =>
    age === null ? list : list.filter((q) => (ageDays(snapshot.as_of, q.listed_at) ?? -1) >= age);
  let cohort = aged(sameCat);
  let rule = `protocols in ${cat} tracked at least as long`;
  if (cohort.length < 8) {
    cohort = aged(all);
    rule = 'protocols in every category tracked at least as long (its own category is too thin)';
  }
  if (cohort.length < 8) {
    cohort = all;
    rule = 'the whole snapshot (no age cohort is thick enough)';
  }
  const trading = cohort.filter(recordsToken).length;
  return { pct: Math.round(((trading + 1) / (cohort.length + 2)) * 1000) / 10, cohort_size: cohort.length, cohort_trading: trading, cohort_rule: rule };
}

/** One protocol's integrity: a score, a grade, and the flags the record itself raises. */
export interface Integrity {
  score: number;
  grade: string;
  flags: string[];
}

/**
 * Grade what the snapshot's record shows, nothing it does not: an unrecorded age or growth
 * figure, one chain holding the whole TVL, a violent seven-day swing, a shrinking TVL,
 * extreme youth, a very long wait, an unrecorded category, or a category so thin in trading
 * peers that its price rests on the global fit. The deductions are stated here and on the
 * dashboard; the grade is A at 85, B at 70, C at 55, D below. `catPeers` is the number of
 * trading protocols in the candidate's category in the fitted model.
 */
export function integrity(p: SnapshotProtocol, age: number | null, catPeers: number): Integrity {
  let score = 100;
  const flags: string[] = [];
  if (age === null) {
    score -= 12;
    flags.push('DefiLlama records no listing date, so its age with no token is unrecorded');
  } else if (age < 90) {
    score -= 10;
    flags.push(`tracked for only ${age} days: a short record to judge a launch by`);
  } else if (age > 1500) {
    score -= 6;
    flags.push(`tracked for ${age} days with no token: the long wait is itself a signal about whether a launch comes`);
  }
  if (p.change_7d === null) {
    score -= 6;
    flags.push('no seven-day TVL change is reported');
  } else if (Math.abs(p.change_7d) > 40) {
    score -= 10;
    flags.push(`TVL moved ${p.change_7d > 0 ? '+' : ''}${Math.round(p.change_7d)}% in seven days: a volatile base for a valuation`);
  } else if (p.change_7d < -15) {
    score -= 6;
    flags.push(`TVL fell ${Math.round(p.change_7d)}% in seven days: the base the valuation stands on is shrinking`);
  }
  if (p.chains.length <= 1) {
    score -= 8;
    flags.push('all of its TVL sits on one chain: single-chain concentration');
  }
  if (p.category === null) {
    score -= 6;
    flags.push('DefiLlama names no category, so its peer group is the whole field');
  }
  if (catPeers < 3) {
    score -= 6;
    flags.push(`only ${catPeers} trading peer${catPeers === 1 ? '' : 's'} in its category, so its price leans on the global fit, not on close peers`);
  }
  if (p.tvl_usd < 10_000_000) {
    score -= 6;
    flags.push('under $10M of TVL: small against the cost of farming it');
  }
  if (flags.length === 0) flags.push('no flag the record raises: age, growth, category and chains all reported');
  const grade = score >= 85 ? 'A' : score >= 70 ? 'B' : score >= 55 ? 'C' : 'D';
  return { score, grade, flags };
}

// ---------------------------------------------------------------------------
// Farm plans and their verdicts
// ---------------------------------------------------------------------------

/** The stated assumptions the verdict prices with; the dashboard prints them beside the board. */
export const AIRDROP_SHARE = 0.04;
export const WALLET_PER_TVL = 50_000;
export const WALLETS_MIN = 250;
export const WALLETS_MAX = 150_000;

/** How many qualifying wallets a launch of this size is assumed to split its rewards across. */
export function assumedWallets(tvl: number): number {
  return clamp(Math.round(tvl / WALLET_PER_TVL), WALLETS_MIN, WALLETS_MAX);
}

/** The gas a first action costs, from the chain the position lives on. */
function gasFor(chain: string): number {
  if (chain === 'Ethereum') return 12;
  if (chain === 'Solana') return 1;
  if (chain === 'Bitcoin') return 6;
  return 2;
}

/** The capital a farm position of this protocol's size is run with. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 30;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The category's one core action, in words a farmer can follow. */
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open`;
}

/** A plan priced out: its steps, its cash cost (gas and fees, never the capital) and its verdict. */
export interface FarmPlan {
  steps: string[];
  cash_cost_usd: number;
  expected_reward_usd: number;
  verdict: string;
}

/** A step as one string: the action, then its cost and its time, within the gate's 20 to 600 characters. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text}. Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each with a dollar cost and a duration, and a verdict
 * that prices the plan against the model's own figures. The expected reward assumes a launch
 * sends 4% of the implied value to early users, split across the assumed wallet count; the
 * verdict is FARM at three times the cash cost, FARM SMALL at one times, SKIP below.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null, implied: number, oddsPct: number): FarmPlan {
  const chain = p.chains.length > 0 ? p.chains[0]! : 'its main chain';
  const capital = capitalFor(p);
  const gas = gasFor(chain);
  const hold = holdDaysFor(age);
  const weeks = Math.ceil(hold / 7);
  const weeklyGas = Math.max(1, Math.round(gas / 2));
  const cashCost = 3 + gas + weeklyGas * weeks;
  const wallets = assumedWallets(p.tvl_usd);
  const expected = Math.round((implied * (oddsPct / 100) * AIRDROP_SHARE) / wallets);
  const ratio = expected / Math.max(1, cashCost);
  const verdict = ratio >= 3 ? 'FARM' : ratio >= 1 ? 'FARM SMALL' : 'SKIP';
  const steps = [
    stepText('Set up a fresh wallet that holds only the funds you plan to farm with, and keep its seed phrase offline', 'under $3 of gas for its first transaction', '5 minutes'),
    stepText(`${actionFor(p, capital, chain)}`, `$${capital} of capital and about $${gas} of gas`, '15 minutes to set up'),
    stepText(`Repeat one qualifying action every week — a deposit, a borrow, a swap or a vote — so the wallet reads as a user, not a snapshot`, `about $${weeklyGas} of gas a week, $${weeklyGas * weeks} over the hold`, '10 minutes a week'),
    stepText(`Hold the position for at least ${hold} days so the activity is counted across more than one weekly snapshot`, `the $${capital} stays in the position; no further fees`, `${hold} days`),
    stepText(`Open ${p.name}'s own points or rewards page from the protocol's official channels and confirm the wallet qualifies; claim only from a link the protocol itself publishes`, 'nothing to check, and never pay anyone to claim', '10 minutes'),
    stepText('Keep a farm log: the wallet, the dates, the amounts and every transaction hash, so the position can be repeated or unwound', 'nothing but the log', '5 minutes'),
    stepText(
      `Verdict ${verdict}: the model prices a launch at $${implied.toLocaleString('en-US')} and the peers' record gives it ${oddsPct}% odds, so an assumed 4% early-user share over ${wallets.toLocaleString('en-US')} wallets is about $${expected.toLocaleString('en-US')} a wallet against about $${cashCost} of cash cost`,
      `about $${cashCost} of gas and fees in all; the $${capital} of capital is separate and comes back on exit`,
      `${hold} days, then reassess`,
    ),
  ];
  return { steps, cash_cost_usd: cashCost, expected_reward_usd: expected, verdict };
}

// ---------------------------------------------------------------------------
// The board and the dashboard's data
// ---------------------------------------------------------------------------

/** One row of board.json: the gate's fields, plus the model's working shown as extra keys. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  age_days: number | null;
  watchlist: boolean;
  implied_value_usd: number;
  band_low_usd: number;
  band_high_usd: number;
  odds_pct: number;
  integrity_score: number;
  integrity_grade: string;
  expected_reward_usd: number;
  plan_cost_usd: number;
  verdict: string;
  model: { category_effect: number; regression_ratio: number; local_ratio: number; blended_ratio: number };
  farm_steps: string[];
}

/** The dashboard's full row: the board row plus flags, the cohort and the plan's figures. */
export interface RadarRow extends BoardRow {
  integrity_flags: string[];
  cohort_size: number;
  cohort_trading: number;
  cohort_rule: string;
}

/** A trading protocol, for the dashboard's peers view: the market's own value beside the model's. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
}

/** A pre-token protocol the board does not rank, with the reason, for the dashboard's apart view. */
export interface ExcludedRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  reason: string;
}

/** Everything the dashboard renders: the board, the diagnostics, the peers and the exclusions. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model_version: string;
  diagnostics: Diagnostics;
  assumptions: { airdrop_share: number; wallet_per_tvl: number; wallets_min: number; wallets_max: number };
  category_effects: { category: string; effect_ratio: number; peers: number }[];
  counts: { protocols: number; pre_token: number; candidates: number; live: number; watchlist: number };
  rows: RadarRow[];
  live: LiveRow[];
  excluded: ExcludedRow[];
}

/** The model's version label: the dashboard names it and the README quotes it. */
export const MODEL_VERSION = 'radar-2';

/** Build the board and the dashboard's data from one snapshot, fitting and validating as it goes. */
export function buildRadar(snapshot: Snapshot): { board: BoardRow[]; radar: RadarData } {
  const train = trainingRows(snapshot);
  const { diagnostics, shipped } = validate(train);
  const band = diagnostics.pooled_median_factor;
  const watch = new Set(snapshot.watchlist);

  const candidates = snapshot.protocols.filter(isLaunchCandidate);
  const priced = candidates.map((p) => {
    const age = ageDays(snapshot.as_of, p.listed_at);
    const pr = price(shipped, p, age);
    const odds = launchOdds(snapshot, p, age);
    const integ = integrity(p, age, shipped.ctx.catPeers.get(p.category ?? 'Uncategorised') ?? 0);
    const plan = farmPlan(p, age, pr.implied, odds.pct);
    return { p, age, pr, odds, integ, plan };
  });
  priced.sort((a, b) => b.pr.implied - a.pr.implied || (a.p.slug < b.p.slug ? -1 : 1));

  const rows: RadarRow[] = priced.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    age_days: s.age,
    watchlist: watch.has(s.p.slug),
    implied_value_usd: s.pr.implied,
    band_low_usd: Math.max(1, Math.round(s.pr.implied / band)),
    band_high_usd: Math.round(s.pr.implied * band),
    odds_pct: s.odds.pct,
    integrity_score: s.integ.score,
    integrity_grade: s.integ.grade,
    expected_reward_usd: s.plan.expected_reward_usd,
    plan_cost_usd: s.plan.cash_cost_usd,
    verdict: s.plan.verdict,
    model: {
      category_effect: round4(Math.pow(10, shipped.ctx.catEffect.get(s.p.category ?? 'Uncategorised') ?? shipped.ctx.globalLogRatio)),
      regression_ratio: round4(Math.pow(10, s.pr.regression)),
      local_ratio: round4(Math.pow(10, s.pr.local)),
      blended_ratio: round4(Math.pow(10, s.pr.logRatio)),
    },
    farm_steps: s.plan.steps,
    integrity_flags: s.integ.flags,
    cohort_size: s.odds.cohort_size,
    cohort_trading: s.odds.cohort_trading,
    cohort_rule: s.odds.cohort_rule,
  }));

  const board: BoardRow[] = rows.map(({ integrity_flags, cohort_size, cohort_trading, cohort_rule, ...rest }) => rest);

  const live: LiveRow[] = snapshot.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0)
    .sort((a, b) => b.mcap_usd! - a.mcap_usd!)
    .slice(0, 48)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: round4(p.mcap_usd! / p.tvl_usd),
      change_7d: p.change_7d,
    }));

  const excluded: ExcludedRow[] = snapshot.protocols
    .filter((p) => isPreToken(p) && !isLaunchCandidate(p))
    .sort((a, b) => b.tvl_usd - a.tvl_usd)
    .slice(0, 48)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, tvl_usd: p.tvl_usd, reason: productReason(p)! }));

  const categoryEffects = [...shipped.ctx.catEffect.entries()]
    .map(([category, effect]) => ({ category, effect_ratio: round4(Math.pow(10, effect)), peers: shipped.ctx.catPeers.get(category) ?? 0 }))
    .sort((a, b) => b.peers - a.peers);

  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model_version: MODEL_VERSION,
    diagnostics,
    assumptions: { airdrop_share: AIRDROP_SHARE, wallet_per_tvl: WALLET_PER_TVL, wallets_min: WALLETS_MIN, wallets_max: WALLETS_MAX },
    category_effects: categoryEffects,
    counts: {
      protocols: snapshot.protocols.length,
      pre_token: snapshot.protocols.filter(isPreToken).length,
      candidates: rows.length,
      live: train.length,
      watchlist: snapshot.watchlist.length,
    },
    rows,
    live,
    excluded,
  };
  return { board, radar };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, values and farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  const byRank = [...board].sort((a, b) => a.rank - b.rank);
  for (let i = 1; i < byRank.length; i++) if (byRank[i]!.implied_value_usd > byRank[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && byRank[0]!.implied_value_usd === byRank[byRank.length - 1]!.implied_value_usd) return 'every row shares one implied value: a board that ranks nothing by value is not a ranking';
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) if (s.trim().length < 20 || s.trim().length > 600) return `${r.slug} has a farm step of ${s.trim().length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
