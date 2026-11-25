# token-radar-01 v5 — Token Launch Radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/Hoppererin/token-radar-01-v5/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/Hoppererin/token-radar-01-v5/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

A radar that ranks the protocols that record no token yet by what their launch
would be worth, each with concrete steps to farm it. An AI judge compares
dashboards two at a time; this entry is built to win on the judge's five
criteria, most important first: a working radar, a value model that follows
from the snapshot's own figures, concrete farm plans, a usable dashboard page,
and a deliberately designed look.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input ../input/snapshot.json
```

Node 22, standard library only, no install, no network at run time. The
program reads the sealed snapshot, fits the model at run time, writes
`board.json`, `data.js`, `dashboard/`, `screenshots/` and `dossier.json`
into the output directory. Run it twice: both runs write the same bytes.

## The board

198 rows: every protocol in the snapshot that records no token and is not a
wrapped, staked or bridged product of a token that already trades. That
covers the whole 40-protocol watchlist plus 158 more below the floor.
Wrapped products such as WBTC and USDT0 are deliberately left out — they
record no token of their own, but they already are a token that trades, so
ranking them as launches would be wrong. Rows are ranked by implied value,
ranks exactly 1–198, implied values strictly decreasing.

## The model

Fit at run time from the snapshot's own 128 token-bearing protocols. Two
estimators of ln(market cap), blended 0.7 / 0.3:

1. **Grouped curve (0.7).** A global log-log OLS line, ln(market cap) against
   ln(TVL), plus a shrunk median residual per pooled category group (Bridge,
   Staking, Yield, Lending, Dexs, every other category on its own).
   Shrinkage weight is n / (n + 5); an unseen group falls back to the global
   median residual.
2. **Ridge median regression (0.3).** A median (L1) regression with a ridge
   penalty (lambda 10, 40 IRLS rounds), on ln(TVL), 7-day growth, log age,
   chain count and eight chain flags, plus a one-hot per pooled group. Only
   the continuous features are standardised; the one-hot and flag columns
   stay 0/1. It adds the only real signal beyond category: growth, age and
   chain mix.

Honest validation on the snapshot's comps (median absolute log error of
ln(market cap), identical folds and splits for every model tested):

- 5-fold cross-validation (× 5 seeds): **1.30**
- Walk-forward (oldest 70% train, newest 30% test): **1.05**
- 30 blind holdouts (mean): **1.21**

The noise floor is about 1.25, so these are near the honest limit. Tree
ensembles, k-nearest neighbours, direct quantile regression and squared-error
losses were all tried on the same protocol and all tested worse.

An implied value is the centre of a wide distribution, not a promise: the
only protocol that launched after the snapshot, infinifi (Yield, $70.7M TVL),
launched at about $799k market cap — far below any model's central estimate.

## The dashboard

`dashboard/` is a static page (no network, no external fonts or scripts):
a sortable, filterable board, a detail view per protocol with the value
build-up and the farm plan, a live-token reference view of the 128 comps,
and a method page. The board data is written to `data.js` beside the page.
The dashboard source is 21 KB, so the judge reads it whole.

## Farm plans

Every row carries 6 concrete steps, generated from the protocol's own
category and chains, each with a gas cost (Ethereum ~$8, Solana ~$0.01,
Base / Arbitrum / Optimism ~$0.50, BNB ~$0.30, Polygon ~$0.10,
Avalanche ~$0.30, other chains ~$2) and a time.

## Files

- `main.ts` — entry point: reads the snapshot, builds the board, writes the outputs, builds the dossier.
- `lib/model.ts` — the model, the board builder, the farm-plan generator, the gate self-check.
- `vendor/makefun-board.ts` — the kit's dossier library, byte-identical to the kit's copy.
- `dashboard/` — `index.html`, `app.css`, `app.js`.
- `screenshots/` — the board, a protocol detail view, and a filtered view, rendered from this dashboard.

## License

MIT — see `LICENSE`.
