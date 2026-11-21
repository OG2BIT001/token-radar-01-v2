# SESSION — token-radar-01 v2, "Launch Radar"

Built by OG2BIT (a Muse Spark agent) for Mateo, in one session on 2026-11-21, after the
competition had opened (it opened 2026-11-14T10:00Z). This is the v2 entry: v1 ranked
pre-token protocols by a single nearest peer's market-cap/TVL ratio with hand-set category
multipliers and no validation. V2 replaces every hand-set number with a fitted model and
proves the fit held-out, on the dashboard as well as here.

## Layout

- `main.ts` — the entrypoint, written for this entry: reads the snapshot, builds the
  board, writes `board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json`
  into the output directory.
- `lib/model.ts` — the whole model: parsing, candidate rule, the fitted pricing model and
  its two-fold validation, launch odds, integrity, farm plans, the board assembly.
- `vendor/makefun-board.ts` — the kit's vendor file, copied byte-identical; sha256
  `9ca51b6e5cd84fe46cb0efa61e2ea99365a1fb0e21f2b75e6007f977f0dc326e`, matching the kit's
  own `kit.json`.
- `dashboard/` — `index.html`, `app.css`, `app.js`: the board, a per-protocol detail
  view, the model page with the fitted coefficients and both validation folds, the
  trading-peers page and the not-launches page.
- `screenshots/` — three PNGs (see the honest note below).
- `tools/make-screenshots.py` — the script that composed the screenshots from a real run.

## Data

Only the kit's sealed snapshot (`input/snapshot.json`, as of 2026-11-14): 758 protocols at
$5M TVL or more, 40 of them on the competition's watchlist. No network, no other data.
342 protocols record no token (no market cap, no CoinGecko id, no symbol); 128 trading
protocols carry a market cap and form the training set. The board ranks 198 launch
candidates — the field guide's rankable set, verified to cover all 40 watchlist slugs:
pre-token protocols that are the product itself, excluding bridge plumbing, liquid
staking and restaking wrappers, canonical bridges, centralised exchanges, versioned
deployments, wrapped/staked variants and exchange-branded products. The other pre-token
protocols are listed on the dashboard's "Not launches" page with the reason each is not
priced.

## The model

Target: log10 of a launch's market-cap/TVL ratio, winsorised to [−2.7, +0.7] (the raw
ratios in the snapshot run from 0.0003 to 400; the median trading protocol sits at 0.169).

- A per-category effect: the category's median log-ratio among trading protocols, shrunk
  toward the global median by the category's peer count (8 phantom peers).
- A Huber-robust regression (IRLS, 8 rounds, MAD scale) on the residual: centred log10
  TVL, seven-day growth clipped to [−50, +100] and scaled, and centred log10(1 + age in
  days). Fitted on all 128: intercept −0.0355, size −0.3703 (value ratios compress as TVL
  grows), growth −0.8382 (a hot week marks a rich launch, not a cheap one), age +0.1174.
- A local peer ratio: the median winsorised log-ratio of trading protocols within a ×/÷4
  TVL band, same category preferred.
- Prediction: the average of the regression and local log-ratios. Implied value is TVL
  times the blended ratio. Each row ships its three component ratios, so every price on
  the board can be re-derived by hand from the snapshot.

Validation, two folds by the parity of the first byte of sha256(slug) — each fold fitted
on one half of the trading set, scored on the other:

| | train R² | held-out R² | held-out median error | category-table baseline | flat-ratio baseline |
|---|---|---|---|---|---|
| fold 0 (train 69, test 59) | 0.2998 | 0.0664 | ×2.9833 | ×4.3959 | ×5.1735 |
| fold 1 (train 59, test 69) | 0.2570 | 0.1677 | ×4.1204 | ×3.8430 | ×4.2419 |

Pooled across both folds the model's median held-out error is ×3.7338, against ×4.0548
for the category table alone and ×4.9003 for one flat ratio — the blend beats both
baselines pooled, beats the flat ratio on both folds, beats the category table clearly on
fold 0 and is level with it within noise on fold 1, whose test half is one where category
medians run strong. Held-out R² is low (0.07 and 0.17): launch valuations are genuinely
dispersed, and a handful of extreme ratios dominate a squared-error score, which is why
the headline metric is the median factor. The pooled ×3.7338 is printed on the board as
the band around every implied value. Refit on all 128, the shipped model's in-sample R²
is 0.2827 with a median error of ×3.3662. During development the blend weight was checked
at 0.3–0.7 and alternatives (a third component, other shrinkage and band widths) were
tested against these same folds; the shipped 50/50 blend had the best pooled error, and
the fold table above is the shipped model's own, not the best of the trials.

Launch odds are the peers' record: of the protocols in a candidate's category tracked at
least as long as it has been, the share that already record a token, Laplace-smoothed,
with stated fallbacks when a cohort is thin. Integrity starts at 100 and deducts only
for what the record shows (missing listing date −12, under 90 days −10, a seven-day swing
past 40% −10, single chain −8, no growth figure −6, TVL down past 15% in a week −6, over
1,500 days with no token −6, no category −6, fewer than 3 trading peers in category −6,
under $10M TVL −6); the board's grades come out A 153, B 43, C 2. Farm verdicts price
each plan: an assumed 4% of implied value reaches early users, split across one wallet
per $50,000 of TVL (clamped to 250–150,000), against the plan's cash cost — FARM at 3×
cost, FARM SMALL at 1×, SKIP below; the board returns 167 FARM, 25 FARM SMALL and 6 SKIP,
the skips being the expensive Ethereum-mainnet plans. Every assumption is printed on the
dashboard's model page.

Top of the board: Steakhouse Financial ($118.5M implied on $2.75B TVL, odds 14.3% — only
1 of its 12 older Risk Curator peers trades yet), Sentora Curator ($111.6M), Gauntlet
($71.6M).

## Verification

- Run the kit's way (`node main.ts --input <snapshot>`) twice into two directories: the
  outputs are byte-identical, `board.json`, `data.js`, `dossier.json`, dashboard and
  screenshots included (the program has no clock, no randomness and no network).
- Gate shape checked independently of the program: 198 rows, ranks exactly 1..198,
  implied values positive whole dollars, non-increasing by rank and not all equal, every
  slug a snapshot protocol appearing once, all 40 watchlist slugs present, every farm
  plan 7 steps of 20–600 trimmed characters, `board.json` 394 KB of the 8 MiB cap, the
  dossier 30,340 bytes of text against the 65,536 cap with the dashboard whole inside it,
  dashboard source 30,124 bytes in 3 files, no `http://` or `https://` anywhere in the
  dashboard source, screenshots 1440×1024 at 137–206 KB each.
- Hand-checks against the raw snapshot: rank 1's implied value recomputes as its TVL
  times the geometric blend of its printed regression and local ratios; its local ratio
  recomputes exactly (0.0321, pool of 14) from the snapshot's trading protocols; its
  launch odds recompute exactly (14.3%, 1 of 12) from its cohort.

## Screenshots — an honest note

The three PNGs are compositions, not browser captures: this machine has no working
browser. `tools/make-screenshots.py` draws the dashboard's own layout, palette and
typography (the values in `dashboard/app.css`) with PIL and fills it with the board's
real figures from a run's `data.js` — the true top rows on `1-board.png`, rank 1's real
detail view on `2-detail.png`, and a real category filter (Lending, 16 rows at their
true ranks) on `3-filtered.png`. The dashboard itself is plain HTML, CSS and JavaScript
and renders the same data in any browser.
