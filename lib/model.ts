// token-radar-01 v5 — model, board builder, farm plans and gate self-check.
//
// The model is a blend of two estimators of ln(market cap), both fit at
// runtime from the sealed snapshot's own 128 token-bearing protocols:
//   - a grouped comps curve (weight 0.7): a global log-log OLS line plus a
//     shrunk median residual per pooled category group;
//   - a ridge median (L1) regression (weight 0.3) on TVL, growth, age,
//     chain count and chain flags, solved by IRLS.
// Nothing here names a protocol. Every number is fit from the snapshot.

import { buildDossier } from '../vendor/makefun-board.ts';
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------- types

export interface Proto {
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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: Proto[];
  watchlist: string[];
}

export interface BoardRow {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  ratio: number;
  curve_usd: number;
  grouped_usd: number;
  ridge_usd: number;
  group: string;
  group_offset_log: number;
  ridge_delta_log: number;
  watchlist: boolean;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  tvl_usd: number;
  mcap_usd: number;
  ratio: number;
  change_7d: number | null;
}

export interface Fit {
  intercept: number;
  slope: number;
  globalMedian: number;
  offsets: Map<string, number>;
  groups: string[];
  ridgeBeta: number[];
  ridgeMeans: number[];
  ridgeSds: number[];
  medianLogAge: number;
  asOfMs: number;
  comps: number;
}

// ---------------------------------------------------------------- small maths

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  if (n === 0) return 0;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/** Ordinary least squares of y on x: returns [intercept, slope]. */
function ols(xs: number[], ys: number[]): [number, number] {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i]! - mx) * (xs[i]! - mx);
    sxy += (xs[i]! - mx) * (ys[i]! - my);
  }
  const slope = sxx === 0 ? 0 : sxy / sxx;
  return [my - slope * mx, slope];
}

/**
 * Solve A x = b by Gaussian elimination with partial pivoting. A is a
 * square matrix given as rows; b is the right-hand side. Returns x.
 */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M: number[][] = A.map((row, i) => [...row, b[i]!]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r]![col]!) > Math.abs(M[piv]![col]!)) piv = r;
    }
    if (Math.abs(M[piv]![col]!) < 1e-12) continue;
    if (piv !== col) {
      const tmp = M[piv]!;
      M[piv] = M[col]!;
      M[col] = tmp;
    }
    const diag = M[col]![col]!;
    for (let r = col + 1; r < n; r++) {
      const f = M[r]![col]! / diag;
      if (f === 0) continue;
      for (let c = col; c <= n; c++) M[r]![c]! -= f * M[col]![c]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let c = r + 1; c < n; c++) s -= M[r]![c]! * x[c]!;
    x[r] = Math.abs(M[r]![r]!) < 1e-12 ? 0 : s / M[r]![r]!;
  }
  return x;
}

// ---------------------------------------------------------------- grouping and eligibility

const POOL: Record<string, string> = {
  Bridge: 'Bridge',
  'Canonical Bridge': 'Bridge',
  'Cross Chain Bridge': 'Bridge',
  'Liquid Staking': 'Staking',
  'Staking Pool': 'Staking',
  'Liquid Restaking': 'Staking',
  Restaking: 'Staking',
  Yield: 'Yield',
  'Yield Aggregator': 'Yield',
  'Leveraged Farming': 'Yield',
  Lending: 'Lending',
  'Uncollateralized Lending': 'Lending',
  CDP: 'Lending',
  Dexs: 'Dexs',
};

/** The pooled group a category belongs to; anything else is its own group. */
export function groupOf(category: string | null): string {
  if (category === null) return 'Unknown';
  return POOL[category] ?? category;
}

const BAD_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);
const EXCHANGE_PREFIXES = [
  'Binance',
  'Coinbase',
  'Bybit',
  'Kraken',
  'Bitget',
  'OKX',
  'Bitfinex',
  'Gemini',
];
const VERSION_SUFFIX = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/**
 * The house watchlist's own eligibility rule, minus the size floor: a
 * protocol that records no token and is not a wrapped, staked or bridged
 * product of a token that already trades. The board is every protocol
 * that passes it, watchlist or below the floor.
 */
export function isEligible(p: Proto): boolean {
  if (p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && BAD_CATEGORIES.has(p.category)) return false;
  const name = p.name ?? '';
  if (VERSION_SUFFIX.test(name)) return false;
  if (WRAPPED_WORD.test(name)) return false;
  for (const ex of EXCHANGE_PREFIXES) {
    if (name.startsWith(ex)) return false;
  }
  return true;
}

// ---------------------------------------------------------------- features

const CHAIN_FLAGS = [
  'Ethereum',
  'Solana',
  'Base',
  'Arbitrum',
  'Optimism',
  'Binance',
  'Polygon',
  'Avalanche',
];
const RIDGE_LAMBDA = 10;
const RIDGE_ROUNDS = 40;
const GROUPED_WEIGHT = 0.7;
const RIDGE_WEIGHT = 0.3;
const SHRINK_K = 5;

function dayMs(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function ageDays(p: Proto, asOfMs: number): number | null {
  if (p.listed_at === null) return null;
  return Math.max(0, Math.round((asOfMs - dayMs(p.listed_at)) / 86400000));
}

function growthOf(p: Proto): number {
  const g = p.change_7d === null ? 0 : p.change_7d / 100;
  return clamp(g, -0.95, 5);
}

/**
 * The ridge design row for a protocol: intercept, ln(TVL), a one-hot over
 * the trained groups, growth, log age, ln(chain count) and the eight chain
 * flags. Only the continuous columns are standardised with the training
 * mean and sd before the fit (the one-hot and flag columns stay 0/1);
 * this function returns the raw row and the caller standardises it.
 */
function designRow(
  p: Proto,
  groups: string[],
  medianLogAge: number,
  asOfMs: number,
): number[] {
  const row: number[] = [1, Math.log(p.tvl_usd)];
  const g = groupOf(p.category);
  for (const grp of groups) row.push(g === grp ? 1 : 0);
  row.push(growthOf(p));
  const age = ageDays(p, asOfMs);
  row.push(age === null ? medianLogAge : Math.log(age + 1));
  row.push(Math.log(Math.max(1, p.chains.length)));
  for (const flag of CHAIN_FLAGS) row.push(p.chains.includes(flag) ? 1 : 0);
  return row;
}

// ---------------------------------------------------------------- fit

export function fitModel(snap: Snapshot): Fit {
  const asOfMs = dayMs(snap.as_of);
  const comps = snap.protocols.filter((p) => p.mcap_usd !== null && p.mcap_usd > 0);
  const xs = comps.map((p) => Math.log(p.tvl_usd));
  const ys = comps.map((p) => Math.log(p.mcap_usd!));
  const [intercept, slope] = ols(xs, ys);

  const residuals = comps.map((p, i) => ys[i]! - (intercept + slope * xs[i]!));
  const globalMedian = median(residuals);

  const byGroup = new Map<string, number[]>();
  for (let i = 0; i < comps.length; i++) {
    const g = groupOf(comps[i]!.category);
    const arr = byGroup.get(g) ?? [];
    arr.push(residuals[i]!);
    byGroup.set(g, arr);
  }
  const groups = [...byGroup.keys()].sort();
  const offsets = new Map<string, number>();
  for (const g of groups) {
    const r = byGroup.get(g)!;
    const w = r.length / (r.length + SHRINK_K);
    offsets.set(g, w * median(r) + (1 - w) * globalMedian);
  }

  // Median log age over the dated comps, for rows with no listed_at.
  const datedLogAge = comps
    .map((p) => ageDays(p, asOfMs))
    .filter((a): a is number => a !== null)
    .map((a) => Math.log(a + 1));
  const medianLogAge = median(datedLogAge);

  // Ridge median regression by IRLS.
  const rawRows = comps.map((p) => designRow(p, groups, medianLogAge, asOfMs));
  const ncol = rawRows[0]!.length;
  const means = new Array<number>(ncol).fill(0);
  const sds = new Array<number>(ncol).fill(1);
  // Only the continuous features are standardised: ln(TVL) and, after the
  // one-hot block, growth, log age and ln(chain count). The pooled-group
  // one-hot and the chain flags stay 0/1. Standardising a rare group's
  // dummy would turn it into an 11-sigma outlier and let the ridge chase
  // one comp's residual; this choice is the one that reproduces the
  // research protocol's walk-forward (1.07 vs its 1.05 — standardising
  // the dummies gives 1.18 instead).
  const continuous = [1, 2 + groups.length, 3 + groups.length, 4 + groups.length];
  for (const c of continuous) {
    const col = rawRows.map((r) => r[c]!);
    const m = col.reduce((a, b) => a + b, 0) / col.length;
    const sd = Math.sqrt(col.reduce((a, b) => a + (b - m) * (b - m), 0) / col.length);
    means[c] = m;
    sds[c] = sd === 0 ? 1 : sd;
  }
  const X = rawRows.map((r) => r.map((v, c) => (c === 0 ? v : (v - means[c]!) / sds[c]!)));

  const ridgeSolve = (weights: number[]): number[] => {
    const A: number[][] = [];
    const b: number[] = [];
    for (let i = 0; i < ncol; i++) {
      const rowA: number[] = [];
      for (let j = 0; j < ncol; j++) {
        let s = 0;
        for (let k = 0; k < X.length; k++) s += weights[k]! * X[k]![i]! * X[k]![j]!;
        if (i === j && i !== 0) s += RIDGE_LAMBDA;
        rowA.push(s);
      }
      let s = 0;
      for (let k = 0; k < X.length; k++) s += weights[k]! * X[k]![i]! * ys[k]!;
      A.push(rowA);
      b.push(s);
    }
    return solveLinear(A, b);
  };

  let beta = ridgeSolve(new Array<number>(X.length).fill(1));
  for (let round = 0; round < RIDGE_ROUNDS; round++) {
    const weights = X.map((row, k) => {
      let pred = 0;
      for (let c = 0; c < ncol; c++) pred += row[c]! * beta[c]!;
      return 1 / Math.max(Math.abs(ys[k]! - pred), 0.001);
    });
    beta = ridgeSolve(weights);
  }

  return {
    intercept,
    slope,
    globalMedian,
    offsets,
    groups,
    ridgeBeta: beta,
    ridgeMeans: means,
    ridgeSds: sds,
    medianLogAge,
    asOfMs,
    comps: comps.length,
  };
}

/** The model's prediction for one protocol, in dollars, with its parts. */
export function predict(
  p: Proto,
  fit: Fit,
): { curve: number; grouped: number; ridge: number; blended: number; offset: number; ridgeDelta: number } {
  const lnTvl = Math.log(p.tvl_usd);
  const curveLog = fit.intercept + fit.slope * lnTvl;
  const g = groupOf(p.category);
  const offset = fit.offsets.get(g) ?? fit.globalMedian;
  const groupedLog = curveLog + offset;
  const raw = designRow(p, fit.groups, fit.medianLogAge, fit.asOfMs);
  let ridgeLog = 0;
  for (let c = 0; c < raw.length; c++) {
    const v = c === 0 ? raw[c]! : (raw[c]! - fit.ridgeMeans[c]!) / fit.ridgeSds[c]!;
    ridgeLog += v * fit.ridgeBeta[c]!;
  }
  const blendedLog = GROUPED_WEIGHT * groupedLog + RIDGE_WEIGHT * ridgeLog;
  return {
    curve: Math.exp(curveLog),
    grouped: Math.exp(groupedLog),
    ridge: Math.exp(ridgeLog),
    blended: Math.exp(blendedLog),
    offset,
    ridgeDelta: ridgeLog - groupedLog,
  };
}

// ---------------------------------------------------------------- farm plans

const GAS: Record<string, string> = {
  Ethereum: '$8',
  Solana: '$0.01',
  Base: '$0.50',
  Arbitrum: '$0.50',
  Optimism: '$0.50',
  Binance: '$0.30',
  Polygon: '$0.10',
  Avalanche: '$0.30',
};
const DEFAULT_GAS = '$2';

function gasFor(chain: string): string {
  return GAS[chain] ?? DEFAULT_GAS;
}

interface PlanCtx {
  name: string;
  chain: string;
  gas: string;
  chain2: string;
  gas2: string;
}

type Plan = (c: PlanCtx) => string[];

function dexPlan(): Plan {
  return (c) => [
    `Bridge $500 of USDC to ${c.chain} for about ${c.gas} in gas (10 minutes), then open ${c.name}.`,
    `Swap $250 of USDC for the other token of the main pool on ${c.name} on ${c.chain}, about ${c.gas} gas (5 minutes).`,
    `Add $500 of liquidity to the main ${c.name} pool on ${c.chain} for about ${c.gas} gas (10 minutes).`,
    `Hold the LP position for 4 weeks and collect trading fees, about ${c.gas} per claim on ${c.chain}.`,
    `Swap another $100 through ${c.name} each week for 4 weeks to build swap volume on ${c.chain}.`,
    `Review the LP position weekly and withdraw or re-add liquidity if the pool's TVL moves sharply.`,
  ];
}

function lendingPlan(): Plan {
  return (c) => [
    `Bridge $1,000 of USDC to ${c.chain} for about ${c.gas} gas (10 minutes), then open ${c.name}.`,
    `Supply $1,000 of USDC as collateral on ${c.name} on ${c.chain}, about ${c.gas} gas (5 minutes).`,
    `Borrow $400 of a stable asset against the collateral on ${c.name} on ${c.chain}, about ${c.gas} gas.`,
    `Hold the borrow for 4 weeks, keep the health factor above 2, and top up collateral if it slips.`,
    `Repay the $400 borrow on ${c.name} on ${c.chain} after 4 weeks for about ${c.gas} gas (5 minutes).`,
    `Withdraw the $1,000 collateral after repaying, and check the position weekly while it is open.`,
  ];
}

function yieldPlan(): Plan {
  return (c) => [
    `Bridge $1,000 of USDC to ${c.chain} for about ${c.gas} gas (10 minutes), then open the ${c.name} vault.`,
    `Deposit $1,000 into the main ${c.name} vault on ${c.chain}, about ${c.gas} gas (5 minutes).`,
    `Stake the vault receipt token if ${c.name} offers staking, about ${c.gas} gas on ${c.chain}.`,
    `Compound the yield weekly for 8 weeks, about ${c.gas} per claim on ${c.chain}.`,
    `Hold the position for at least 8 weeks to cover deposit and exit fees on ${c.chain}.`,
    `Withdraw the deposit and rewards after 8 weeks for about ${c.gas} gas (10 minutes).`,
  ];
}

function stakingPlan(): Plan {
  return (c) => [
    `Buy $1,000 of the base asset on ${c.chain} for about ${c.gas} gas (10 minutes).`,
    `Stake $1,000 with ${c.name} on ${c.chain} for about ${c.gas} gas (5 minutes).`,
    `Hold the liquid receipt token for 4 weeks and use it in a lending market on ${c.chain}.`,
    `Restake the staking rewards weekly for 8 weeks, about ${c.gas} per claim on ${c.chain}.`,
    `Check the validator or operator set monthly and move stake if performance drops.`,
    `Unstake after 8 weeks, allowing for the queue period, for about ${c.gas} gas on ${c.chain}.`,
  ];
}

function bridgePlan(): Plan {
  return (c) => [
    `Bridge $500 of USDC from ${c.chain} to ${c.chain2} on ${c.name} for about ${c.gas} gas (15 minutes).`,
    `Bridge $250 back from ${c.chain2} to ${c.chain} to complete a round trip, about ${c.gas2} gas.`,
    `Use the bridged asset in a ${c.chain2} app for 2 weeks to leave a usage trail.`,
    `Bridge a second $500 from ${c.chain} to another supported chain after 2 weeks.`,
    `Repeat one bridge a month for 3 months, about ${c.gas} gas each time on ${c.chain}.`,
    `Keep the receipt of each bridge and check finality times before bridging larger amounts.`,
  ];
}

function predictionPlan(): Plan {
  return (c) => [
    `Bridge $100 of USDC to ${c.chain} for about ${c.gas} gas (10 minutes), then open ${c.name}.`,
    `Place a $50 position on a high-volume market on ${c.name} on ${c.chain}, about ${c.gas} gas.`,
    `Provide $50 of liquidity to a market on ${c.name} on ${c.chain} for about ${c.gas} gas.`,
    `Hold both positions until the market resolves, usually 1 to 4 weeks.`,
    `Claim any winnings after resolution for about ${c.gas} gas on ${c.chain} (5 minutes).`,
    `Repeat with a new market each month and keep a record of wins and losses.`,
  ];
}

function derivativesPlan(): Plan {
  return (c) => [
    `Bridge $500 of USDC to ${c.chain} for about ${c.gas} gas (10 minutes), then open ${c.name}.`,
    `Deposit $500 as margin on ${c.name} on ${c.chain}, about ${c.gas} gas (5 minutes).`,
    `Open a small 2x long position on ${c.name} on ${c.chain} for about ${c.gas} gas.`,
    `Set a stop loss and hold the position for 1 to 2 weeks on ${c.chain}.`,
    `Close the position and take profit or cut the loss, about ${c.gas} gas on ${c.chain}.`,
    `Withdraw the margin after closing and review the trade before opening another.`,
  ];
}

function rwaPlan(): Plan {
  return (c) => [
    `Complete the onboarding for ${c.name} and bridge $500 of USDC to ${c.chain}, about ${c.gas} gas.`,
    `Buy $500 of the tokenised asset on ${c.name} on ${c.chain} for about ${c.gas} gas (10 minutes).`,
    `Hold the asset for 4 weeks and collect the yield it pays, about ${c.gas} per claim.`,
    `Add a second $250 purchase after 2 weeks if the asset performs, about ${c.gas} gas.`,
    `Check the underlying asset and issuer reports monthly while holding.`,
    `Sell or redeem after 8 weeks for about ${c.gas} gas on ${c.chain} (10 minutes).`,
  ];
}

function curatorPlan(): Plan {
  return (c) => [
    `Bridge $500 of USDC to ${c.chain} for about ${c.gas} gas (10 minutes), then open ${c.name}.`,
    `Deposit $500 into a curated vault on ${c.name} on ${c.chain}, about ${c.gas} gas (5 minutes).`,
    `Read the curator's allocation and risk limits before depositing more on ${c.chain}.`,
    `Hold the vault position for 8 weeks and check the curator's reports monthly.`,
    `Add $250 more after 4 weeks if the vault's risk stays within its stated limits.`,
    `Withdraw after 8 weeks for about ${c.gas} gas and compare the return with the vault's target.`,
  ];
}

function allocatorPlan(): Plan {
  return (c) => [
    `Bridge $500 of USDC to ${c.chain} for about ${c.gas} gas (10 minutes), then open ${c.name}.`,
    `Allocate $500 through ${c.name} on ${c.chain} for about ${c.gas} gas (5 minutes).`,
    `Hold the allocation for 8 weeks and read the allocator's monthly reports.`,
    `Claim any distributions weekly for 8 weeks, about ${c.gas} per claim on ${c.chain}.`,
    `Rebalance after 4 weeks if the allocation drifts from its stated strategy.`,
    `Exit the allocation after 8 weeks for about ${c.gas} gas on ${c.chain} (10 minutes).`,
  ];
}

function defaultPlan(): Plan {
  return (c) => [
    `Bridge $500 of USDC to ${c.chain} for about ${c.gas} gas (10 minutes), then open ${c.name}.`,
    `Deposit $500 into the main ${c.name} position on ${c.chain}, about ${c.gas} gas (5 minutes).`,
    `Hold the position for 4 weeks and check it weekly for rate or risk changes.`,
    `Add a second $250 deposit after 2 weeks if the position performs, about ${c.gas} gas.`,
    `Claim any rewards weekly for 4 weeks, about ${c.gas} per claim on ${c.chain}.`,
    `Exit or rebalance after 8 weeks for about ${c.gas} gas and record the outcome.`,
  ];
}

const PLAN_BY_GROUP: Record<string, Plan> = {
  Dexs: dexPlan(),
  Lending: lendingPlan(),
  Yield: yieldPlan(),
  Staking: stakingPlan(),
  Bridge: bridgePlan(),
  'Prediction Market': predictionPlan(),
  Derivatives: derivativesPlan(),
  'Basis Trading': derivativesPlan(),
  'Interest Rate Derivatives': derivativesPlan(),
  RWA: rwaPlan(),
  'Risk Curators': curatorPlan(),
  'Onchain Capital Allocator': allocatorPlan(),
};

/** Six concrete, costed, timed farm steps for one protocol. */
export function farmPlan(p: Proto): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const chain2 =
    p.chains.length > 1 ? p.chains[1]! : chain === 'Ethereum' ? 'Base' : 'Ethereum';
  const ctx: PlanCtx = {
    name: p.name,
    chain,
    gas: gasFor(chain),
    chain2,
    gas2: gasFor(chain2),
  };
  const plan = PLAN_BY_GROUP[groupOf(p.category)] ?? defaultPlan();
  return plan(ctx);
}

// ---------------------------------------------------------------- board

export interface Board {
  rows: BoardRow[];
  live: LiveRow[];
  fit: Fit;
}

export function buildBoard(snap: Snapshot): Board {
  const fit = fitModel(snap);
  const watch = new Set(snap.watchlist);
  const candidates = snap.protocols.filter(isEligible);
  const scored = candidates.map((p) => {
    const pred = predict(p, fit);
    return { p, pred };
  });
  scored.sort((a, b) => {
    if (b.pred.blended !== a.pred.blended) return b.pred.blended - a.pred.blended;
    return a.p.slug < b.p.slug ? -1 : 1;
  });
  const rows: BoardRow[] = [];
  let prev = Number.POSITIVE_INFINITY;
  for (let i = 0; i < scored.length; i++) {
    const { p, pred } = scored[i]!;
    let value = Math.round(clamp(pred.blended, 1, 1e14));
    if (value >= prev) value = prev - 1;
    if (value < 1) value = 1;
    prev = value;
    rows.push({
      slug: p.slug,
      name: p.name,
      rank: i + 1,
      implied_value_usd: value,
      farm_steps: farmPlan(p),
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      change_7d: p.change_7d,
      age_days: ageDays(p, fit.asOfMs),
      ratio: value / p.tvl_usd,
      curve_usd: Math.round(pred.curve),
      grouped_usd: Math.round(pred.grouped),
      ridge_usd: Math.round(pred.ridge),
      group: groupOf(p.category),
      group_offset_log: pred.offset,
      ridge_delta_log: pred.ridgeDelta,
      watchlist: watch.has(p.slug),
    });
  }
  const live: LiveRow[] = snap.protocols
    .filter((p) => p.mcap_usd !== null && p.mcap_usd > 0)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      ratio: p.mcap_usd! / p.tvl_usd,
      change_7d: p.change_7d,
    }))
    .sort((a, b) => b.mcap_usd - a.mcap_usd);
  return { rows, live, fit };
}

// ---------------------------------------------------------------- gate self-check

export interface GateRow {
  name: string;
  pass: boolean;
  detail: string;
}

const PLAIN_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function pngSize(bytes: Buffer): { w: number; h: number } | null {
  if (bytes.length < 24) return null;
  const magic = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (bytes[i] !== magic[i]) return null;
  if (bytes.toString('ascii', 12, 16) !== 'IHDR') return null;
  return { w: bytes.readUInt32BE(16), h: bytes.readUInt32BE(20) };
}

function jpegSize(bytes: Buffer): { w: number; h: number } | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { h: bytes.readUInt16BE(i + 5), w: bytes.readUInt16BE(i + 7) };
    }
    const len = bytes.readUInt16BE(i + 2);
    i += 2 + len;
  }
  return null;
}

/** The kit gate's seven rows, checked against a written output directory. */
export function gateCheck(outDir: string, snap: Snapshot): GateRow[] {
  const rows: GateRow[] = [];
  const fail = (name: string, detail: string) => rows.push({ name, pass: false, detail });
  const ok = (name: string, detail: string) => rows.push({ name, pass: true, detail });

  // 1. dashboard_files
  try {
    const dashDir = join(outDir, 'dashboard');
    const files: string[] = [];
    let bytes = 0;
    const walk = (dir: string, rel: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = rel === '' ? e.name : `${rel}/${e.name}`;
        if (e.isDirectory()) {
          if (e.name.startsWith('.')) throw new Error(`dot-directory ${p}`);
          walk(join(dir, e.name), p);
        } else if (e.isFile()) {
          if (!PLAIN_NAME.test(e.name)) throw new Error(`bad name ${p}`);
          files.push(p);
          bytes += statSync(join(dir, e.name)).size;
        } else {
          throw new Error(`not a file ${p}`);
        }
      }
    };
    walk(dashDir, '');
    const hasHtml = files.includes('index.html');
    const hasCss = files.some((f) => f.endsWith('.css'));
    const hasJs = files.some((f) => f.endsWith('.js'));
    let net = '';
    for (const f of files) {
      const text = readFileSync(join(dashDir, f), 'utf8');
      if (text.includes('http://') || text.includes('https://')) {
        net = f;
        break;
      }
    }
    if (!hasHtml || !hasCss || !hasJs) fail('dashboard_files', 'missing index.html, css or js');
    else if (files.length > 400 || bytes > 4 * 1024 * 1024) fail('dashboard_files', `${files.length} files, ${bytes} bytes`);
    else if (net !== '') fail('dashboard_files', `network address in ${net}`);
    else ok('dashboard_files', `${files.length} files, ${bytes} bytes, no network`);
  } catch (err) {
    fail('dashboard_files', String((err as Error).message ?? err));
  }

  // 2-5. board rows
  let board: { rows: BoardRow[] } | null = null;
  try {
    const raw = readFileSync(join(outDir, 'board.json'));
    if (raw.length > 8 * 1024 * 1024) throw new Error('board.json over 8 MiB');
    const parsed = JSON.parse(raw.toString('utf8')) as { rows: BoardRow[] } | BoardRow[];
    board = Array.isArray(parsed) ? { rows: parsed } : parsed;
    const slugs = new Set(snap.protocols.map((p) => p.slug));
    const bad: string[] = [];
    for (const r of board.rows) {
      if (!slugs.has(r.slug)) bad.push(r.slug);
      if (typeof r.name !== 'string' || r.name.length === 0) bad.push(`${r.slug}:name`);
      if (!Number.isSafeInteger(r.rank) || r.rank < 1) bad.push(`${r.slug}:rank`);
      if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd < 1 || r.implied_value_usd > 1e14)
        bad.push(`${r.slug}:value`);
      if (!Array.isArray(r.farm_steps)) bad.push(`${r.slug}:steps`);
    }
    if (board.rows.length < 100 || board.rows.length > 4000) fail('board_file', `${board.rows.length} rows`);
    else if (bad.length > 0) fail('board_file', `bad rows: ${bad.slice(0, 5).join(', ')}`);
    else ok('board_file', `${board.rows.length} rows`);

    const ranks = board.rows.map((r) => r.rank).sort((a, b) => a - b);
    const ranksOk = ranks.every((r, i) => r === i + 1);
    const vals = board.rows.map((r) => r.implied_value_usd);
    const nonRising = vals.every((v, i) => i === 0 || v <= vals[i - 1]!);
    const allSame = vals.length > 1 && vals.every((v) => v === vals[0]);
    if (!ranksOk) fail('sorted_by_value', 'ranks are not exactly 1..N');
    else if (!nonRising) fail('sorted_by_value', 'implied value rises with rank');
    else if (allSame) fail('sorted_by_value', 'all implied values equal');
    else ok('sorted_by_value', 'ranks 1..N, values non-increasing');

    const have = new Set(board.rows.map((r) => r.slug));
    const missing = snap.watchlist.filter((s) => !have.has(s));
    if (missing.length > 0) fail('coverage', `missing watchlist: ${missing.join(', ')}`);
    else ok('coverage', `all ${snap.watchlist.length} watchlist slugs present`);

    const badSteps: string[] = [];
    for (const r of board.rows) {
      if (r.farm_steps.length < 3 || r.farm_steps.length > 12) badSteps.push(`${r.slug}:count`);
      for (const s of r.farm_steps) {
        const t = s.trim();
        if (t.length < 20 || t.length > 600) badSteps.push(`${r.slug}:len`);
      }
    }
    if (badSteps.length > 0) fail('farm_steps', badSteps.slice(0, 5).join(', '));
    else ok('farm_steps', 'every row 3-12 steps of 20-600 chars');
  } catch (err) {
    if (board === null) fail('board_file', String((err as Error).message ?? err));
    fail('sorted_by_value', 'board unreadable');
    fail('coverage', 'board unreadable');
    fail('farm_steps', 'board unreadable');
  }

  // 6. screenshots
  try {
    const shotsDir = join(outDir, 'screenshots');
    const names = readdirSync(shotsDir, { withFileTypes: true })
      .filter((e) => e.isFile() && !e.name.startsWith('.'))
      .map((e) => e.name)
      .sort();
    if (names.length < 3 || names.length > 4) {
      fail('screenshots', `${names.length} images`);
    } else {
      const bad: string[] = [];
      for (const n of names) {
        const bytes = readFileSync(join(shotsDir, n));
        if (bytes.length > 512 * 1024) bad.push(`${n}:bytes`);
        const size = pngSize(bytes) ?? jpegSize(bytes);
        if (size === null) bad.push(`${n}:not an image`);
        else {
          const long = Math.max(size.w, size.h);
          const short = Math.min(size.w, size.h);
          if (long > 1440 || short < 800) bad.push(`${n}:${size.w}x${size.h}`);
        }
      }
      if (bad.length > 0) fail('screenshots', bad.join(', '));
      else ok('screenshots', `${names.length} images within limits`);
    }
  } catch (err) {
    fail('screenshots', String((err as Error).message ?? err));
  }

  // 7. dossier_matches
  try {
    const dossier = readFileSync(join(outDir, 'dossier.json'));
    if (dossier.length > 1.5 * 1024 * 1024) {
      fail('dossier_matches', `${dossier.length} bytes, over 1.5 MiB`);
    } else {
      const rebuilt = buildDossier(outDir, { text_max_bytes: 65536 });
      if (Buffer.from(rebuilt).equals(dossier)) ok('dossier_matches', `${dossier.length} bytes, byte-identical`);
      else fail('dossier_matches', 'dossier.json differs from buildDossier output');
    }
  } catch (err) {
    fail('dossier_matches', String((err as Error).message ?? err));
  }

  return rows;
}

// ---------------------------------------------------------------- file helpers for main.ts

export function copyDir(src: string, dst: string): void {
  mkdirSync(dst, { recursive: true });
  cpSync(src, dst, { recursive: true, force: true });
}

export function writeText(path: string, text: string): void {
  writeFileSync(path, text, 'utf8');
}

export function dirExists(path: string): boolean {
  try {
    return existsSync(path) && lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}
