// Launch Radar (model radar-2): the board, a detail view for every protocol, the model page.
//
// Everything on this page is computed by main.ts from the sealed snapshot and shipped in
// data.js as window.RADAR; this file only renders it. The model in one paragraph: the 128
// protocols in the snapshot that already trade give the market's revealed valuations. A
// robust regression of log10(market cap / TVL) on size, seven-day growth and age, with a
// per-category effect taken out first, is blended half-and-half with the median ratio of
// trading peers in the same TVL band; the blend prices every protocol that records no token
// yet. The fit was tested on protocols it never saw, twice (two hash folds), and the pooled
// held-out median error is the band printed beside every implied value. Launch odds are the
// peers' record: of the protocols in a candidate's category tracked at least as long as it
// has been, the share that already record a token. The integrity grade scores only what the
// record shows. The verdict prices each farm plan against the model's own figures.

const R = window.RADAR;
const rows = R.rows;
const bySlug = new Map(rows.map((r) => [r.slug, r]));

/** Escape a snapshot string for HTML. */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** $1,966,542,738 -> $1.97B; $18,044,257 -> $18.0M; $842,113 -> $842K; below that, whole. */
function fmtUsd(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${(n / 1e3).toFixed(0)}K`;
  return `$${n}`;
}
const fmtFull = (n) => `$${n.toLocaleString('en-US')}`;
const fmtPct = (v) => (v === null || v === undefined ? '—' : `${v > 0 ? '+' : ''}${Math.round(v * 10) / 10}%`);
const fmtAge = (d) => (d === null || d === undefined ? 'unrecorded' : d >= 365 ? `${(d / 365).toFixed(1)}y` : `${d}d`);
const gradeChip = (g) => `<span class="chip g${g}">${g}</span>`;
const verdictChip = (v) =>
  v === 'FARM' ? '<span class="chip farm">FARM</span>' : v === 'FARM SMALL' ? '<span class="chip small">FARM SMALL</span>' : '<span class="chip skip">SKIP</span>';

/** The page frame: title, what this is, and the view nav. */
function frame(active, body) {
  const c = R.counts;
  return `
  <header class="top">
    <h1>Launch <span class="radar">Radar</span></h1>
    <span class="sub">Pre-token protocols ranked by implied launch value · model ${esc(R.model_version)}, fitted on the snapshot's ${c.live} trading protocols · data as of ${esc(R.as_of)} (DefiLlama, sealed snapshot)</span>
    <nav class="views">
      <a href="#/" class="${active === 'board' ? 'on' : ''}">Board</a>
      <a href="#/model" class="${active === 'model' ? 'on' : ''}">The model</a>
      <a href="#/live" class="${active === 'live' ? 'on' : ''}">Trading peers</a>
      <a href="#/excluded" class="${active === 'excluded' ? 'on' : ''}">Not launches</a>
    </nav>
  </header>${body}
  <footer>Implied values are this model's own claim, fitted on the snapshot and stated with its held-out error; a protocol here records no token on DefiLlama, which is a record, not proof that none exists. Farm verdicts price the plan against stated assumptions on the model page.</footer>`;
}

/** The integrity strip: the board's vital signs, with the grade distribution as bars. */
function strip() {
  const totalImplied = rows.reduce((a, r) => a + r.implied_value_usd, 0);
  const odds = rows.map((r) => r.odds_pct).sort((a, b) => a - b);
  const medOdds = odds[Math.floor(odds.length / 2)];
  const grades = { A: 0, B: 0, C: 0, D: 0 };
  for (const r of rows) grades[r.integrity_grade]++;
  const maxG = Math.max(...Object.values(grades));
  const farms = rows.filter((r) => r.verdict !== 'SKIP').length;
  const bar = (g, colour) => `<span><i style="height:${Math.max(3, Math.round((grades[g] / maxG) * 24))}px;background:${colour}"></i></span>`;
  return `<section class="strip">
    <div class="cell"><div class="k">Candidates ranked</div><div class="v">${rows.length} <small>${R.counts.watchlist} on the watchlist</small></div></div>
    <div class="cell"><div class="k">Implied value, all rows</div><div class="v">${fmtUsd(totalImplied)}</div></div>
    <div class="cell"><div class="k">Median launch odds</div><div class="v">${medOdds}%</div></div>
    <div class="cell"><div class="k">Model held-out error</div><div class="v">x${R.diagnostics.pooled_median_factor} <small>median, two folds</small></div></div>
    <div class="cell"><div class="k">Integrity grades</div><div class="grades">${bar('A', '#4ade80')}${bar('B', '#2dd4bf')}${bar('C', '#f5b84c')}${bar('D', '#f26d6d')}</div><div class="v" style="font-size:11.5px;font-weight:400;color:var(--mut)">A ${grades.A} · B ${grades.B} · C ${grades.C} · D ${grades.D}</div></div>
    <div class="cell"><div class="k">Plans worth farming</div><div class="v">${farms} <small>of ${rows.length}</small></div></div>
  </section>`;
}

// ---------------------------------------------------------------------------
// The board
// ---------------------------------------------------------------------------

const state = { q: '', category: '', chain: '', grade: '', verdict: '', watch: false, sort: 'rank', dir: 1 };

function categories() {
  return [...new Set(rows.map((r) => r.category ?? 'Uncategorised'))].sort();
}
function chains() {
  return [...new Set(rows.flatMap((r) => r.chains))].sort();
}

function visibleRows() {
  const q = state.q.trim().toLowerCase();
  const out = rows.filter((r) => {
    if (q && !`${r.name} ${r.slug}`.toLowerCase().includes(q)) return false;
    if (state.category && (r.category ?? 'Uncategorised') !== state.category) return false;
    if (state.chain && !r.chains.includes(state.chain)) return false;
    if (state.grade && r.integrity_grade !== state.grade) return false;
    if (state.verdict && r.verdict !== state.verdict) return false;
    if (state.watch && !r.watchlist) return false;
    return true;
  });
  const key = {
    rank: (r) => r.rank,
    tvl: (r) => r.tvl_usd,
    change: (r) => r.change_7d ?? -Infinity,
    age: (r) => r.age_days ?? -1,
    implied: (r) => r.implied_value_usd,
    odds: (r) => r.odds_pct,
    integrity: (r) => r.integrity_score,
    ev: (r) => r.expected_reward_usd,
  }[state.sort];
  out.sort((a, b) => (key(a) - key(b)) * state.dir || a.rank - b.rank);
  return out;
}

function boardView() {
  const list = visibleRows();
  const th = (label, keyName, cls = '') => {
    const dir = state.sort === keyName ? (state.dir === 1 ? ' <span class="dir">↑</span>' : ' <span class="dir">↓</span>') : '';
    return `<th class="${cls}" data-sort="${keyName}">${label}${dir}</th>`;
  };
  const body = list
    .map(
      (r) => `<tr class="row" data-slug="${esc(r.slug)}">
      <td class="num">${r.rank}</td>
      <td class="l name">${esc(r.name)}${r.watchlist ? ' <span class="chip watch">watchlist</span>' : ''}<span class="slug">${esc(r.slug)}</span></td>
      <td class="l">${esc(r.category ?? 'Uncategorised')}</td>
      <td class="num">${fmtUsd(r.tvl_usd)}</td>
      <td class="num ${r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg'}">${fmtPct(r.change_7d)}</td>
      <td class="num">${fmtAge(r.age_days)}</td>
      <td class="num"><strong>${fmtUsd(r.implied_value_usd)}</strong><span class="band">${fmtUsd(r.band_low_usd)} – ${fmtUsd(r.band_high_usd)}</span></td>
      <td class="num">${r.odds_pct}%</td>
      <td>${gradeChip(r.integrity_grade)} <span class="num" style="color:var(--mut)">${r.integrity_score}</span></td>
      <td class="num">${fmtUsd(r.expected_reward_usd)}<span class="band">cost ${fmtUsd(r.plan_cost_usd)}</span></td>
      <td>${verdictChip(r.verdict)}</td>
    </tr>`,
    )
    .join('');
  return frame(
    'board',
    `${strip()}
    <div class="toolbar">
      <input type="search" id="q" placeholder="Search name or slug" value="${esc(state.q)}">
      <label>Category <select id="f-category"><option value="">All</option>${categories().map((c) => `<option ${state.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label>Chain <select id="f-chain"><option value="">All</option>${chains().map((c) => `<option ${state.chain === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}</select></label>
      <label>Grade <select id="f-grade"><option value="">Any</option>${['A', 'B', 'C', 'D'].map((g) => `<option ${state.grade === g ? 'selected' : ''}>${g}</option>`).join('')}</select></label>
      <label>Verdict <select id="f-verdict"><option value="">Any</option>${['FARM', 'FARM SMALL', 'SKIP'].map((v) => `<option ${state.verdict === v ? 'selected' : ''}>${v}</option>`).join('')}</select></label>
      <label><input type="checkbox" id="f-watch" ${state.watch ? 'checked' : ''}> Watchlist only</label>
      <span class="count">${list.length} of ${rows.length} protocols · click a row for its detail, a heading to sort</span>
    </div>
    <div class="wrap"><table class="board"><thead><tr>
      ${th('#', 'rank')}<th class="l">Protocol</th><th class="l">Category</th>${th('TVL', 'tvl')}${th('7d', 'change')}${th('Age', 'age')}${th('Implied value', 'implied')}${th('Odds', 'odds')}${th('Integrity', 'integrity')}${th('EV / wallet', 'ev')}<th>Verdict</th>
    </tr></thead><tbody>${body || '<tr><td colspan="11" class="l">No protocol matches those filters.</td></tr>'}</tbody></table></div>`,
  );
}

function wireBoard() {
  const on = (id, ev, fn) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener(ev, fn);
  };
  on('q', 'input', (e) => { state.q = e.target.value; rerender(false); });
  on('f-category', 'change', (e) => { state.category = e.target.value; rerender(); });
  on('f-chain', 'change', (e) => { state.chain = e.target.value; rerender(); });
  on('f-grade', 'change', (e) => { state.grade = e.target.value; rerender(); });
  on('f-verdict', 'change', (e) => { state.verdict = e.target.value; rerender(); });
  on('f-watch', 'change', (e) => { state.watch = e.target.checked; rerender(); });
  document.querySelectorAll('th[data-sort]').forEach((el) =>
    el.addEventListener('click', () => {
      const k = el.getAttribute('data-sort');
      if (state.sort === k) state.dir = -state.dir;
      else { state.sort = k; state.dir = k === 'rank' ? 1 : -1; }
      rerender();
    }),
  );
  document.querySelectorAll('tr.row').forEach((el) =>
    el.addEventListener('click', () => { location.hash = `#/p/${el.getAttribute('data-slug')}`; }),
  );
  const q = document.getElementById('q');
  if (q && document.activeElement !== q && state.q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
}

// ---------------------------------------------------------------------------
// One protocol's detail view: the derivation, the peers' record, the flags, the plan
// ---------------------------------------------------------------------------

function detailView(slug) {
  const r = bySlug.get(slug);
  if (!r) return frame('board', `<div class="view"><p><a href="#/">← Back to the board</a></p><p>No protocol with slug ${esc(slug)} is on the board.</p></div>`);
  const m = r.model;
  const steps = r.farm_steps.map((s) => `<li>${esc(s)}</li>`).join('');
  const flags = r.integrity_flags.map((f) => `<li>${esc(f)}</li>`).join('');
  return frame(
    'board',
    `<div class="view">
    <p><a href="#/">← Back to the board</a></p>
    <h2>${esc(r.name)} ${gradeChip(r.integrity_grade)} ${verdictChip(r.verdict)}${r.watchlist ? ' <span class="chip watch">watchlist</span>' : ''}</h2>
    <p class="lede">Rank ${r.rank} of ${rows.length} · ${esc(r.category ?? 'Uncategorised')} · ${esc(r.chains.join(', ') || 'no chain recorded')} · records no token on DefiLlama as of ${esc(R.as_of)}.</p>
    <div class="grid">
      <div class="card"><div class="k">TVL</div><div class="v">${fmtFull(r.tvl_usd)}</div></div>
      <div class="card"><div class="k">Implied launch value</div><div class="v">${fmtFull(r.implied_value_usd)} <small>band ${fmtUsd(r.band_low_usd)} – ${fmtUsd(r.band_high_usd)}</small></div></div>
      <div class="card"><div class="k">Launch odds (peers' record)</div><div class="v">${r.odds_pct}% <small>${r.cohort_trading} of ${r.cohort_size} peers already trade</small></div></div>
      <div class="card"><div class="k">Integrity</div><div class="v">${r.integrity_score} / 100 <small>grade ${r.integrity_grade}</small></div></div>
      <div class="card"><div class="k">Expected reward / wallet</div><div class="v">${fmtFull(r.expected_reward_usd)} <small>against ${fmtFull(r.plan_cost_usd)} cash cost</small></div></div>
      <div class="card"><div class="k">Age with no token</div><div class="v">${r.age_days === null ? 'Unrecorded' : `${r.age_days} days`} <small>listed ${esc(r.listed_at ?? '—')}</small></div></div>
    </div>
    <h3>How the model prices ${esc(r.name)}</h3>
    <table class="kv">
      <tr><td>TVL (the snapshot's own figure)</td><td class="n num">${fmtFull(r.tvl_usd)}</td></tr>
      <tr><td>Category effect: the fitted median value ratio of trading ${esc(r.category ?? 'Uncategorised')} protocols, shrunk by peer count</td><td class="n num">x${m.category_effect}</td></tr>
      <tr><td>Regression ratio: the fitted size, growth and age terms on this protocol</td><td class="n num">x${m.regression_ratio}</td></tr>
      <tr><td>Local peer ratio: the median ratio of trading protocols within a x4 TVL band</td><td class="n num">x${m.local_ratio}</td></tr>
      <tr><td>Blended ratio (half regression, half local peers)</td><td class="n num">x${m.blended_ratio}</td></tr>
      <tr><td><strong>Implied value = TVL x blended ratio</strong>, rounded; the band is the model's pooled held-out median error, x${R.diagnostics.pooled_median_factor}</td><td class="n num"><strong>${fmtFull(r.implied_value_usd)}</strong></td></tr>
    </table>
    <h3>The peers' record</h3>
    <p class="note">Of the ${r.cohort_size} protocols in the cohort (${esc(r.cohort_rule)}), ${r.cohort_trading} already record a token. Laplace-smoothed, that is the ${r.odds_pct}% launch odds above: not a prediction that ${esc(r.name)} will issue, but what protocols like it have done.</p>
    <h3>Integrity flags</h3>
    <ul class="flags">${flags}</ul>
    <h3>The farm plan, priced</h3>
    <ol class="steps">${steps}</ol>
    </div>`,
  );
}

// ---------------------------------------------------------------------------
// The model page: coefficients, both validation folds, baselines, assumptions
// ---------------------------------------------------------------------------

function modelView() {
  const d = R.diagnostics;
  const b = d.beta;
  const foldRows = d.folds
    .map(
      (f) => `<tr><td>Fold ${f.fold}: fitted on ${f.train_size}, tested on ${f.test_size} it never saw</td>
      <td class="n num">${f.train_r2}</td><td class="n num">${f.heldout_r2}</td><td class="n num">x${f.heldout_median_factor}</td>
      <td class="n num">x${f.baseline_category_factor}</td><td class="n num">x${f.baseline_flat_factor}</td></tr>`,
    )
    .join('');
  const catRows = R.category_effects
    .slice(0, 16)
    .map((c) => `<tr><td>${esc(c.category)}</td><td class="n num">${c.peers}</td><td class="n num">x${c.effect_ratio}</td></tr>`)
    .join('');
  return frame(
    'model',
    `<div class="view">
    <h2>The model, and how well it does</h2>
    <p class="lede">A board's implied value is only worth reading if the model behind it was tested on data it had not seen. This one was, twice. The ${d.training_size} protocols in the sealed snapshot that already trade — a token and a market cap beside their TVL — are the market's revealed valuations. The model learns from them, then prices the protocols that record no token yet.</p>
    <h3>The formula</h3>
    <div class="formula">log10(value / TVL) = category effect + ${b[0]} + ${b[1]} x (log10 TVL - ${d.mean_log_tvl}) + ${b[2]} x growth + ${b[3]} x (log10 age - centre), blended 50/50 with the local peer ratio</div>
    <p class="note">Growth is the seven-day TVL change clipped to [-50%, +100%], as a fraction; age is days tracked with no token. The fit is a Huber robust regression (eight IRLS rounds), so the few protocols priced at hundreds of times TVL cannot drag it. Ratios are winsorised to [0.002, 5.0]. The category effect is each category's median ratio among trading protocols, shrunk toward the global median (x${d.global_ratio}) by its peer count, so a category with two peers barely moves from the field's figure. The local peer ratio is the median ratio of trading protocols within a x4 TVL band, same-category peers preferred; the 50/50 blend is the weight the two validation folds chose over 0, 30, 70 and 100%.</p>
    <h3>Tested held-out, twice</h3>
    <table class="kv">
      <tr><th>Fold</th><th class="n">Train R²</th><th class="n">Held-out R²</th><th class="n">Held-out median error</th><th class="n">Category table alone</th><th class="n">Flat ratio alone</th></tr>
      ${foldRows}
    </table>
    <p class="note">The trading set is split by a hash of each protocol's slug: each fold's fit sees one half and is scored on the other. Pooled across both folds, the median held-out prediction lands within x${d.pooled_median_factor} of the market's own figure — that factor is the band beside every implied value on the board. Refit on all ${d.training_size}, the model's in-sample R² is ${d.full_r2} with a median error of x${d.full_median_factor}. Pooled, the fitted blend's x${d.pooled_median_factor} beats both baselines it replaces — the category peer table alone at x${d.pooled_category_factor} and one flat ratio for the whole field at x${d.pooled_flat_factor}. Fold by fold it beats the flat ratio on both; against the category table it wins fold 0 clearly and is level within noise on fold 1, whose test half happens to be one where category medians run strong. Launch valuations are dispersed — half of real launches land more than a factor of three from any model of TVL, growth and age — so the board prints the band rather than pretend a precision the market does not have.</p>
    <h3>Category effects (top 16 by trading peers)</h3>
    <table class="kv"><tr><th>Category</th><th class="n">Trading peers</th><th class="n">Fitted value ratio</th></tr>${catRows}</table>
    <h3>Odds, integrity and verdicts</h3>
    <p class="note">Launch odds are the peers' record, not a forecast: of the protocols in a candidate's category tracked at least as long as it has been, the share that already record a token, Laplace-smoothed; thin cohorts widen to every category at that age. The integrity grade starts at 100 and deducts only for what the record shows: no listing date (-12), under 90 days tracked (-10), a seven-day TVL swing past 40% (-10), all TVL on one chain (-8), no reported growth (-6), TVL shrinking past 15% in a week (-6), over 1,500 days with no token (-6), no category (-6), fewer than 3 trading peers in its category (-6), under $10M TVL (-6). A is 85+, B 70+, C 55+, D below.</p>
    <p class="note">A farm verdict prices the plan: it assumes a launch sends ${(R.assumptions.airdrop_share * 100).toFixed(0)}% of the implied value to early users, split across one wallet per $${R.assumptions.wallet_per_tvl.toLocaleString('en-US')} of TVL (clamped to ${R.assumptions.wallets_min}–${R.assumptions.wallets_max.toLocaleString('en-US')} wallets). Expected reward per wallet against the plan's cash cost in gas and fees: FARM at 3x the cost or better, FARM SMALL at 1x, SKIP below. The capital a plan deploys is the farmer's own and comes back on exit; only gas and fees count as cost. Change the assumptions and the verdicts move — they are printed here so a reader can disagree with them in numbers, not in vibes.</p>
    </div>`,
  );
}

// ---------------------------------------------------------------------------
// Trading peers and the not-launches view
// ---------------------------------------------------------------------------

function liveView() {
  const body = R.live
    .map(
      (p, i) => `<tr><td class="num">${i + 1}</td><td class="l name">${esc(p.name)}<span class="slug">${esc(p.slug)}</span></td>
      <td class="l">${esc(p.category ?? 'Uncategorised')}</td><td class="num">${fmtUsd(p.tvl_usd)}</td>
      <td class="num">${fmtUsd(p.mcap_usd)}</td><td class="num">x${p.ratio}</td>
      <td class="num ${p.change_7d === null ? '' : p.change_7d >= 0 ? 'pos' : 'neg'}">${fmtPct(p.change_7d)}</td></tr>`,
    )
    .join('');
  return frame(
    'live',
    `<div class="view">
    <h2>Trading peers: the market's own values</h2>
    <p class="lede">These protocols already record a token, so the board never ranks them — it learns from them. The ${R.counts.live} with a market cap are the model's training set; the largest 48 are shown. Their spread of value ratios, from under 0.01 to over 5, is why every implied value on the board carries a band.</p>
    <div class="wrap" style="padding:0"><table class="board" style="min-width:760px"><thead><tr><th>#</th><th class="l">Protocol</th><th class="l">Category</th><th>TVL</th><th>Market cap</th><th>Ratio</th><th>7d</th></tr></thead><tbody>${body}</tbody></table></div>
    </div>`,
  );
}

function excludedView() {
  const body = R.excluded
    .map(
      (p) => `<tr><td class="l name">${esc(p.name)}<span class="slug">${esc(p.slug)}</span></td>
      <td class="l">${esc(p.category ?? 'Uncategorised')}</td><td class="num">${fmtUsd(p.tvl_usd)}</td><td class="l">${esc(p.reason)}</td></tr>`,
    )
    .join('');
  return frame(
    'excluded',
    `<div class="view">
    <h2>Not launches: products of tokens that already trade</h2>
    <p class="lede">These protocols record no token of their own, but they are not waiting on a launch: each is a wrapped, staked, bridged or exchange product of a token that already trades, or a versioned pool of a parent protocol. The board leaves them out rather than price another token's product as a launch. The largest 48 by TVL are shown; the rule is the snapshot field guide's own.</p>
    <div class="wrap" style="padding:0"><table class="board" style="min-width:760px"><thead><tr><th class="l">Protocol</th><th class="l">Category</th><th>TVL</th><th class="l">Why it is not a launch</th></tr></thead><tbody>${body}</tbody></table></div>
    </div>`,
  );
}

// ---------------------------------------------------------------------------
// Routing
// ---------------------------------------------------------------------------

function render() {
  const app = document.getElementById('app');
  const hash = location.hash || '#/';
  if (hash.startsWith('#/p/')) {
    app.innerHTML = detailView(decodeURIComponent(hash.slice(4)));
  } else if (hash === '#/model') {
    app.innerHTML = modelView();
  } else if (hash === '#/live') {
    app.innerHTML = liveView();
  } else if (hash === '#/excluded') {
    app.innerHTML = excludedView();
  } else {
    app.innerHTML = boardView();
    wireBoard();
  }
  app.setAttribute('aria-busy', 'false');
  window.scrollTo(0, 0);
}

function rerender(keepFocus = true) {
  const app = document.getElementById('app');
  app.innerHTML = boardView();
  wireBoard();
  if (!keepFocus) return;
}

window.addEventListener('hashchange', render);
render();
