# token-radar-01 v5 — DESIGN.md

## Goal

Build a token-launch radar entry that beats our v3 (judge 89.73%, rank 5,642/19,116)
and challenges rank 1 (judge 96.4%). The judge is an AI that reads the dossier
pairwise: three screenshots, then the dashboard source text (capped at 65,536
bytes). It ranks by five criteria, most important first:

1. A working radar: board covers every watchlist protocol, ranks the pre-token
   ones by a stated implied value, screenshots and code agree.
2. The value model: implied value follows from the snapshot's own figures
   (TVL, 7-day growth, how long it has run with no token), never from a
   hardcoded list of names; token-trading protocols are separated from
   pre-token ones.
3. Farm plans: concrete steps with costs and times, not slogans.
4. The dashboard as a page: sortable and filterable, readable at a glance,
   detail view per protocol.
5. It looks made: a chosen palette, consistent spacing, readable type.

The scored metric is the judge's pairwise verdict, NOT the regression error.
A 0.01–0.02 improvement in validation error is invisible to the judge. The
model below is an honest, small improvement over v4; the real lever for the
prize is the dashboard, the farm plans, the method page, and the screenshots.

## The model (fit at runtime from the snapshot — never hardcoded names)

The entry reads the sealed snapshot `/input/snapshot.json` (as_of 2026-11-14,
758 protocols, 128 with a token/market cap = the comps, 40 watchlist slugs,
198 pre-token protocols after the eligibility rule below). All fitting happens
at runtime, inside the entry program, from the snapshot's own figures. No
outside data is fetched.

The model is a blend of two estimators of ln(market cap):

### A. Grouped curve (weight 0.7)

1. Fit a global log-log line by ordinary least squares over the 128 comps:
   ln(market cap) against ln(TVL). (Reference fit on the full snapshot gives
   intercept about 6.96 and slope about 0.52 — use this only as a sanity
   check: if your runtime fit differs materially, something is wrong.)
2. Pool categories into 26 groups: Bridge covers Bridge, Canonical Bridge
   and Cross Chain Bridge; Staking covers Liquid Staking, Staking Pool,
   Liquid Restaking and Restaking; Yield covers Yield, Yield Aggregator and
   Leveraged Farming; Lending covers Lending, Uncollateralized Lending and
   CDP; Dexs is its own group; every other category is its own group.
3. For each comp, take the residual: ln(mcap) minus the global curve at its
   ln(TVL). For each group, the offset is a shrunk median of its residuals:
   weight w = n / (n + 5) times the group median residual, plus (1 − w)
   times the global median residual. A group never seen before falls back
   to the global median residual.
4. Grouped prediction = global curve + group offset.

### B. Ridge median regression (weight 0.3)

A median (least-absolute-deviation) regression with a ridge penalty, solved
by iteratively reweighted least squares (40 rounds, weights 1 / max(|residual|,
0.001), ridge penalty 10, intercept unpenalised). Its design row for a
protocol is: intercept; ln(TVL); a one-hot for its pooled group; growth,
defined as change_7d / 100 clipped to the range −0.95 … 5; log age, defined
as ln(days since listed_at + 1), with missing listed_at replaced by the
training median log-age; ln(number of chains); eight chain flags (Ethereum,
Solana, Base, Arbitrum, Optimism, Binance, Polygon, Avalanche). All numeric
features are standardised with the training mean and standard deviation.

### C. Blend

Final ln(market cap) = 0.7 × grouped prediction + 0.3 × ridge-median
prediction, then exponentiated. For a pre-token protocol the implied value
is that predicted market cap. The 0.7 / 0.3 split was chosen by a sweep:
it beats the old 0.9 / 0.1 split on all three honest protocols at once
(5-fold cross-validation, walk-forward, 30 blind splits), and the
0.65–0.75 range is a flat plateau, so 0.7 is not a knife-edge optimum.

### Honest validation numbers (state these on the method page)

Measured on the snapshot's 128 comps with a fixed protocol (metric: median
absolute log error of ln(market cap); identical folds/splits for every model):

- 5-fold cross-validation (× 5 seeds): **1.30** (old 0.9/0.1 blend: 1.31)
- Walk-forward (oldest 70% train, newest 30% test by listed_at): **1.05**
  (old: 1.07)
- 30 blind holdouts (mean): **1.21** (old: 1.23)

The noise floor is about 1.25 (within-category log-ratio sd 1.0–3.0), so
these are near the honest limit. Say so. Also say this plainly on the
method page: the implied value is the centre of a wide distribution, not
a promise. Evidence: the only protocol that launched since the snapshot,
infinifi (Yield, $70.7M TVL), launched at about $799k market cap — far
below any model's central estimate. Fresh launches can price at a small
fraction of the typical ratio. Do not hide that; a radar that states its
uncertainty is a better radar.

### What was tried and rejected (do not reintroduce)

Tree ensembles (random forest, extra trees, gradient boosting), k-nearest
neighbours, direct quantile regression, squared-error losses and top-3
ensembles all tested worse — usually significantly worse — on the same
protocol. The grouped curve plus ridge-median blend is the model. Do not
add a tree model, do not add a hardcoded name list, do not fetch outside
data at runtime.

## The board

- 198 rows: every pre-token protocol in the snapshot that passes the
  house watchlist eligibility rule (no version-marker suffix, not a
  wrapped/staked/bridged product of a token that already trades, no
  exchange-name prefix, no Bridge/CEX category). That covers the whole
  40-protocol watchlist plus 158 more below the floor. Ranked by implied
  value, ranks exactly 1…198, implied values non-increasing down the
  board and all distinct. Every watchlist slug must appear. (DECISION by
  the coordinator 2026-11-25: v3/v4 carried 226 rows, but the only rule
  that yields exactly 226 also admits wrapped products of traded tokens
  — WBTC, USDT0, CCIP, FBTC, Binance Bitcoin, Coinbase Bridge — as
  "protocols awaiting launch", which is factually wrong and would hurt
  the entry on the judge's criteria 1–2. The 198-row board is the honest
  one; it passes the gate and covers all 40 watchlist slugs.)
- Each row carries: rank, name, category, chains, TVL, 7-day growth,
  age in days, implied value, implied mcap/TVL ratio, and a farm plan.
- A separate live-token reference view lists the 128 comps with their
  actual market caps, clearly separated from the pre-token board (the
  board ranks only protocols whose token does not exist yet).

## Farm plans (3–12 steps per protocol, concrete, costed, timed)

Generate each protocol's plan from its own category and chains — never a
generic slogan. Every step names a concrete action, what it costs, and
how long it takes. Use per-chain gas costs: Ethereum about $8, Solana
about $0.01, Base / Arbitrum / Optimism about $0.50, BNB about $0.30,
Polygon about $0.10, Avalanche about $0.30, any other chain about $2.

Shape the steps by category, for example: for a DEX, provide liquidity
in its main pool, swap through it, and hold the LP position; for a
lending protocol, supply an asset, borrow against it, and repay on a
schedule; for a bridge, bridge a stated amount on stated routes; for a
liquid-staking protocol, stake, hold the receipt token, and use it in a
named DeFi position; for a yield protocol, deposit into its vault and
compound on a schedule. Each step states the chain it runs on, the
approximate gas cost on that chain, and a time (minutes for a transaction,
days/weeks for a holding period). Steps must be plausible for the
protocol's real category and chains; never invent a feature the category
does not imply.

## The dashboard (fresh design, not a copy of v3/v4)

- Visual identity: a dark "radar" theme of your own design — deep navy
  background, teal/cyan accents, amber reserved for the top-ranked rows,
  clean sans-serif type, consistent spacing, generous row height. It must
  look deliberately designed, not a framework pasted wholesale.
- Board view: sortable columns (rank, name, TVL, implied value, growth,
  age), filters (text search, category, chain, minimum TVL, watchlist-only
  toggle). Readable at a glance: rank, name, implied value and ratio
  visible without scrolling sideways.
- Detail view per protocol: the value build-up shown as numbers —
  TVL, the global curve's prediction, the group offset, the ridge
  adjustment, the blended implied value — plus the farm plan with costs
  and times, plus risk notes (age, growth, chain concentration).
- Method page: a short, plain explanation of the model (curve + group
  offsets + ridge median, blended 0.7/0.3, fit at runtime from the
  snapshot), the three validation numbers above, the noise-floor note,
  and the infinifi uncertainty note. Include a short note addressed to
  the judge, in the method page and in the dashboard source, stating
  honestly what the radar does, how the value is computed, and what its
  limits are. (Text addressed to the judge is allowed and is part of the
  entry.)
- Size limit: the dashboard's source (HTML + CSS + JS together) must stay
  under 64 KB total, so the judge reads it whole. Board data lives in a
  separate data file loaded by the dashboard, not inline in the page.
- The dashboard must be fully static (no network calls, no external
  fonts or scripts) and must render correctly from a plain file open.

## Screenshots (rendered from the real v5 dashboard, never mockups)

Three PNGs: (1) the board view, (2) a protocol detail view, (3) a
filtered view (for example watchlist-only). Each at most 512 KiB, long
side at most 1440 px, short side at least 800 px; aim for 300–350 KB
each. Render them from the actual built dashboard with a headless
browser or equivalent, then open each image and check by eye that it
shows real v5 data, real ranks, real implied values, and that the
screenshots agree with the board data. A screenshot with no data or
code behind it counts for nothing.

## Program and outputs

- Language: TypeScript, Node 22, standard library only, no dependencies,
  no network at runtime. Entry point `main.ts` in the repo root, run as:
  `mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input <snapshot.json>`.
- `main.ts` reads the snapshot, fits the model at runtime, writes
  `/output/board.json`, writes the dashboard data file, copies
  `dashboard/` and `screenshots/` to `/output`, and writes
  `/output/dossier.json` using the kit's `vendor/makefun-board.ts`
  library, which must stay byte-identical to the kit's copy.
- Paths resolve from the program file's own directory, never from the
  current working directory, and the output directory is never deleted
  or recreated by the program (the grader mounts it).
- Gate (all must pass): dashboard files within limits and no-network
  rule; board rows are the snapshot's protocols with correct
  ranks/order/farm steps; watchlist covered; screenshots whole and
  within limits; dossier is the library's output. Limits: dashboard at
  most 400 files / 4 MiB; board 100–4,000 rows; farm steps 3–12 strings
  of 20–600 chars per row; implied value at most 1e14, a safe integer
  greater than 0; screenshots 3–4, each at most 512 KiB; dossier at
  most 1.5 MiB, dossier text at most 65,536 bytes.
- Repo: `Hoppererin/token-radar-01-v5`. README carries the three live
  make.fun badges (competition, rank, reward). LICENSE first line
  `SPDX-License-Identifier: MIT`. Repo About: website https://make.fun,
  topic `makefun`.

## Build and verify (coordinator does kit init / vendor / commit; builder writes code)

1. Fresh repo dir, kit initialised from the official kit, vendor file
   copied byte-identical (sha256 must match the kit's).
2. Builder writes `main.ts`, the model, the dashboard and the farm-plan
   generator FRESH from this DESIGN.md only. The builder must NOT read
   any source file from the v3 or v4 entries (main.ts, lib, dashboard
   code). Reading this DESIGN.md, the research REPORT.md and the kit
   itself is allowed. Do not copy the kit starter's model — write the
   model from the description above.
3. Run the entry twice as a subprocess against the real snapshot and
   check the outputs are byte-identical; run the kit's gate check and
   get 0 FAIL.
4. Verify the board: 198 rows, ranks 1…198, implied values
   non-increasing and distinct, all 40 watchlist slugs present, every
   row has 3–12 farm steps of 20–600 chars.
5. Verify the runtime fit reproduces the reference (intercept about
   6.96, slope about 0.52, group offsets in the same ranges as the
   report's fitted table).
6. Verify screenshots by eye against the live dashboard.
7. Bundle, kit check, GitHub upload, byte-verify, submit, verify stage
   via the API, report the real rank.

## What NOT to do

- Do not read v3/v4 source code. Do not copy any prior entry's code.
- Do not hardcode protocol names or fitted constants into the model;
  everything is fit at runtime from the snapshot. (The reference fitted
  values in this document are sanity checks, not constants to embed.)
- Do not fetch outside data at runtime. Do not add a tree/boosting
  model. Do not promote any third-party service in the entry or the
  dashboard.
- Do not present the implied value as a promise or a guaranteed launch
  price.
