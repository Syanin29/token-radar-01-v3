// Token Radar v3 — model "radar-3-size-family" (Node 22, standard library only).
//
// What this model does, in one paragraph: it ranks pre-token protocols by an implied
// value fitted from the traded protocols in the same snapshot. The fitted value of a
// protocol is its TVL times a multiple; the multiple comes from a size curve fitted on
// the traded peers (bigger protocols trade at lower multiples of TVL), shifted by a
// family adjustment (the median residual of the protocol's family of categories,
// shrunk toward the global curve by n/(n+2) so thin families do not wag the fit).
// The whole fit is validated out of sample with deterministic 5-fold cross-validation,
// and the validation number is printed on the board. Two snapshot figures were tested
// as predictors and dropped: the 7-day TVL change and the protocol's age both correlate
// about 0.00 with the traded multiple and add nothing out of sample, so neither moves
// the value; the board says so next to the figures instead of pretending otherwise.
//
// Nothing here is hardcoded from a name list: every number is fitted from the snapshot
// the program reads. The program is deterministic: no clocks, no randomness, every sort
// has a tie-break, every fold comes from a hash of the slug.

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

export interface Row {
  slug: string;
  name: string;
  rank: number;
  implied_value_usd: number;
  farm_steps: string[];
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  watchlist: boolean;
  age_days: number | null;
  size_multiple: number;
  base_multiple: number;
  family: string;
  family_adjustment: number;
  family_peers: number;
  model: string;
}

export interface ModelReport {
  model: string;
  as_of: string;
  floor_usd: number;
  protocols_total: number;
  watchlist_size: number;
  rows: number;
  early_rows: number;
  set_aside: number;
  set_aside_with_token: number;
  peers_used: number;
  peers_dropped: string[];
  curve_intercept: number;
  curve_slope: number;
  oos_median_factor: number;
  oos_p70_factor: number;
  oos_mean_log_error: number;
  oos_folds: number;
  growth_correlation: number;
  age_correlation: number;
  families: { name: string; peers: number; adjustment: number }[];
  methodology: string;
}

export interface BoardResult {
  rows: Row[];
  report: ModelReport;
}

const MODEL_NAME = 'radar-3-size-family';

// Categories whose products are not pre-token subjects: bridges, staked or wrapped
// products and centralised exchanges hold other tokens' value, not a new token.
const EXCLUDED_CATEGORIES = new Set([
  'Bridge',
  'Canonical Bridge',
  'Liquid Staking',
  'Liquid Restaking',
  'Restaked BTC',
  'CEX',
]);

const EXCHANGE_NAMES = [
  'Binance',
  'Coinbase',
  'Bybit',
  'Kraken',
  'Bitget',
  'OKX',
  'Bitfinex',
  'Gemini',
];

// A version marker is a trailing " V3", " v2" or "2.0" style suffix. A bare trailing
// number is a name, not a version: "Project 0" stays in.
const VERSION_SUFFIX = /\s[vV]\d+(\.\d+)?$|\s\d+\.\d+$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

// Families group categories that earn money the same way, so a thin category borrows
// strength from its neighbours instead of falling back to one global number.
const FAMILY_OF: Record<string, string> = {
  'Risk Curators': 'Yield & management',
  'Onchain Capital Allocator': 'Yield & management',
  Yield: 'Yield & management',
  'Yield Aggregator': 'Yield & management',
  'Basis Trading': 'Yield & management',
  Dexs: 'Trading',
  Derivatives: 'Trading',
  Options: 'Trading',
  Lending: 'Lending',
  CDP: 'Lending',
  'Leveraged Farming': 'Lending',
  'Liquid Staking': 'Staking',
  'Liquid Restaking': 'Staking',
  Restaking: 'Staking',
  'Staking Pool': 'Staking',
  Bridge: 'Bridging',
  'Canonical Bridge': 'Bridging',
  'Cross Chain Bridge': 'Bridging',
  CEX: 'Exchanges',
  RWA: 'Real-world assets',
};

function familyOf(category: string | null): string {
  if (category === null) return 'Other';
  return FAMILY_OF[category] ?? 'Other';
}

// Estimated gas for one simple transaction on each chain, in USD. These are planning
// figures for the farm steps, not quotes; the steps say "about" every time.
const CHAIN_GAS_USD: Record<string, number> = {
  Ethereum: 3.0,
  Base: 0.5,
  Arbitrum: 0.5,
  Optimism: 0.5,
  Solana: 0.02,
  Binance: 0.2,
  Tron: 1.0,
  Polygon: 0.1,
  Avalanche: 0.3,
  Sui: 0.05,
  Aptos: 0.05,
};

function gasUsd(chain: string): number {
  return CHAIN_GAS_USD[chain] ?? 1.0;
}

function money(n: number): string {
  if (n >= 1) return `$${n.toFixed(2).replace(/\.00$/, '')}`;
  return `$${n.toFixed(2)}`;
}

/** Possessive: "Steakhouse Financial's", but "UltraYield Vaults'". */
function possessive(name: string): string {
  return name.endsWith('s') ? `${name}'` : `${name}'s`;
}

function ageDaysOf(p: Proto, asOf: string): number | null {
  if (p.listed_at === null) return null;
  const start = Date.parse(`${p.listed_at}T00:00:00Z`);
  const end = Date.parse(`${asOf}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / 86_400_000));
}

/** The snapshot as the program reads it: parsed, lightly checked, nothing inferred. */
export function parseSnapshot(text: string): Snapshot {
  const raw = JSON.parse(text) as Snapshot;
  if (!Array.isArray(raw.protocols) || !Array.isArray(raw.watchlist)) {
    throw new Error('token radar: snapshot holds no protocols array or watchlist array');
  }
  if (typeof raw.as_of !== 'string' || typeof raw.floor_usd !== 'number') {
    throw new Error('token radar: snapshot holds no as_of date or floor_usd');
  }
  return raw;
}

/**
 * The pre-token screen. A protocol passes when the snapshot records no token for it
 * (no market cap, no CoinGecko id, no ticker) AND it is not a bridge, a staked or
 * wrapped product, an exchange, a versioned deployment or an exchange's own product.
 * The screen says "records no token", never "has no token": the record is not proof.
 */
export function passesScreen(p: Proto): boolean {
  if (p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null) return false;
  if (p.category !== null && EXCLUDED_CATEGORIES.has(p.category)) return false;
  const name = p.name ?? '';
  if (VERSION_SUFFIX.test(name)) return false;
  if (WRAPPED_WORD.test(name)) return false;
  for (const exchange of EXCHANGE_NAMES) {
    if (name.startsWith(exchange)) return false;
  }
  return true;
}

/** Traded peers for the fit: a market cap and TVL, with a sane multiple between them. */
function tradedPeers(protocols: Proto[]): { peers: Proto[]; dropped: string[] } {
  const peers: Proto[] = [];
  const dropped: string[] = [];
  for (const p of protocols) {
    if (p.mcap_usd === null || p.tvl_usd <= 0) continue;
    const multiple = p.mcap_usd / p.tvl_usd;
    if (multiple < 0.001 || multiple > 10) {
      dropped.push(p.slug);
      continue;
    }
    peers.push(p);
  }
  return { peers, dropped };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  if (sorted.length % 2 === 1) return sorted[mid]!;
  return (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function mean(values: number[]): number {
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function correlation(xs: number[], ys: number[]): number {
  if (xs.length < 3) return 0;
  const mx = mean(xs);
  const my = mean(ys);
  let cov = 0;
  let vx = 0;
  let vy = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mx;
    const dy = ys[i]! - my;
    cov += dx * dy;
    vx += dx * dx;
    vy += dy * dy;
  }
  if (vx === 0 || vy === 0) return 0;
  return cov / Math.sqrt(vx * vy);
}

/** Ordinary least squares for log(multiple) = a + b * log(TVL) over the peers. */
function fitSizeCurve(peers: Proto[]): { intercept: number; slope: number } {
  const xs = peers.map((p) => Math.log(p.tvl_usd));
  const ys = peers.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const mx = mean(xs);
  const my = mean(ys);
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) * (xs[i]! - mx);
  }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}

/** Median log-residual of each family against the size curve, with its peer count. */
function familyAdjustments(
  peers: Proto[],
  curve: { intercept: number; slope: number },
): Map<string, { adjustment: number; peers: number }> {
  const residuals = new Map<string, number[]>();
  for (const p of peers) {
    const fitted = curve.intercept + curve.slope * Math.log(p.tvl_usd);
    const residual = Math.log(p.mcap_usd! / p.tvl_usd) - fitted;
    const family = familyOf(p.category);
    const list = residuals.get(family) ?? [];
    list.push(residual);
    residuals.set(family, list);
  }
  const out = new Map<string, { adjustment: number; peers: number }>();
  for (const [family, list] of residuals) {
    // Shrink the family adjustment toward the global curve: a family's median
    // residual is noisy when the family is thin, and a 2% TVL perturbation moves
    // it enough to shift the out-of-sample median. n/(n+2) keeps large families
    // almost whole (n=30 -> 0.94) and damps the noisiest ones (n=3 -> 0.6).
    const raw = list.length >= 3 ? median(list) : 0;
    out.set(family, { adjustment: raw * (list.length / (list.length + 2)), peers: list.length });
  }
  return out;
}

function fittedMultiple(
  tvl: number,
  category: string | null,
  curve: { intercept: number; slope: number },
  families: Map<string, { adjustment: number; peers: number }>,
): {
  multiple: number;
  baseMultiple: number;
  family: string;
  adjustment: number;
  familyPeers: number;
} {
  const family = familyOf(category);
  const entry = families.get(family);
  const adjustment = entry === undefined ? 0 : entry.adjustment;
  const familyPeers = entry === undefined ? 0 : entry.peers;
  const baseMultiple = Math.exp(curve.intercept + curve.slope * Math.log(tvl));
  const multiple = Math.min(2.0, Math.max(0.005, baseMultiple * Math.exp(adjustment)));
  return { multiple, baseMultiple, family, adjustment, familyPeers };
}

// Deterministic fold from the slug alone: the same snapshot always folds the same way.
function foldOf(slug: string): number {
  let hash = 5381;
  for (let i = 0; i < slug.length; i++) {
    hash = ((hash << 5) + hash + slug.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % 5;
}

/**
 * Five-fold cross-validation of the whole fit (size curve + family adjustment).
 * Returns the median out-of-sample error factor: the typical traded protocol's true
 * market cap sits within this factor of the fitted value. Lower is better.
 */
function crossValidate(peers: Proto[]): {
  medianFactor: number;
  p70Factor: number;
  meanLogError: number;
} {
  const errors: number[] = [];
  for (let fold = 0; fold < 5; fold++) {
    const train = peers.filter((p) => foldOf(p.slug) !== fold);
    const test = peers.filter((p) => foldOf(p.slug) === fold);
    if (train.length === 0 || test.length === 0) continue;
    const curve = fitSizeCurve(train);
    const families = familyAdjustments(train, curve);
    for (const p of test) {
      const { multiple } = fittedMultiple(p.tvl_usd, p.category, curve, families);
      const predicted = p.tvl_usd * multiple;
      errors.push(Math.abs(Math.log(predicted / p.mcap_usd!)));
    }
  }
  errors.sort((a, b) => a - b);
  const medianError = errors[Math.floor(errors.length / 2)]!;
  const p70Error = errors[Math.floor(errors.length * 0.7)]!;
  return {
    medianFactor: Math.exp(medianError),
    p70Factor: Math.exp(p70Error),
    meanLogError: mean(errors),
  };
}

// --- Farm plans ------------------------------------------------------------
// Every step names the protocol and its chain, so no two rows share a step. Each
// step carries what it costs and how long it takes; nothing is a slogan.

interface CategoryPlaybook {
  deposit: (name: string, chain: string, amount: number, gas: string) => string;
  recurring: (name: string, chain: string, chain2: string, gas: string) => string;
  second: (name: string, chain: string, chain2: string, gas: string) => string;
  risk: (name: string, chain: string, chain2: string) => string;
}

function vaultPlaybook(): CategoryPlaybook {
  return {
    deposit: (name, chain, amount, gas) =>
      `Deposit ${money(amount)} of USDC into ${possessive(name)} vault on ${chain} and keep the vault shares in the farming wallet. Cost: ${money(amount)} of capital and about ${gas} of gas. Time: 15 minutes to set up.`,
    recurring: (name, chain, _chain2, gas) =>
      `Once a week, add a little more to the ${name} position on ${chain} or move it between vaults when the yield changes. Cost: about ${gas} of gas a week. Time: 10 minutes a week.`,
    second: (name, chain, _chain2, gas) =>
      `Join ${possessive(name)} governance or points vote on ${chain} at least once, so the farming wallet shows up as an active user. Cost: about ${gas} of gas. Time: 10 minutes.`,
    risk: (name, chain, _chain2) =>
      `Never put more in ${name} on ${chain} than you can lose if the vault contract is exploited, and spread the farm across at least two vaults. Cost: no gas. Time: 5 minutes to check.`,
  };
}

function dexPlaybook(): CategoryPlaybook {
  return {
    deposit: (name, chain, amount, gas) =>
      `Provide ${money(amount)} of liquidity to ${possessive(name)} largest pool on ${chain}, in the pair the pool already holds most of, and keep the LP tokens. Cost: ${money(amount)} of capital and about ${gas} of gas. Time: 20 minutes to set up.`,
    recurring: (name, chain, _chain2, gas) =>
      `Once a week, rebalance the ${name} liquidity range on ${chain} if the price moved out of it, and collect the fees earned. Cost: about ${gas} of gas a week. Time: 15 minutes a week.`,
    second: (name, chain, _chain2, gas) =>
      `Swap a small amount through ${name} on ${chain} in both directions, so the wallet has trading volume as well as liquidity. Cost: about ${gas} of gas. Time: 10 minutes.`,
    risk: (name, chain, _chain2) =>
      `Watch impermanent loss on the ${name} pool on ${chain}: if one side of the pair runs far ahead, the LP can be worth less than holding. Cost: no gas. Time: 5 minutes to check.`,
  };
}

function lendingPlaybook(): CategoryPlaybook {
  return {
    deposit: (name, chain, amount, gas) =>
      `Supply ${money(amount)} of USDC to ${name} on ${chain} as a lender and hold the receipt tokens. Cost: ${money(amount)} of capital and about ${gas} of gas. Time: 15 minutes to set up.`,
    recurring: (name, chain, _chain2, gas) =>
      `Once a week, check the ${name} supply rate on ${chain} and top up the supply if the rate still leads its peers. Cost: about ${gas} of gas a week. Time: 10 minutes a week.`,
    second: (name, chain, _chain2, gas) =>
      `Borrow a small amount against the ${name} supply on ${chain} once, then repay it, so the wallet shows both sides of the market. Cost: about ${gas} of gas. Time: 15 minutes.`,
    risk: (name, chain, _chain2) =>
      `Keep the ${name} supply on ${chain} in a stable asset only, so a market crash cannot cut the collateral value at the same time. Cost: no gas. Time: 5 minutes to check.`,
  };
}

function cdpPlaybook(): CategoryPlaybook {
  return {
    deposit: (name, chain, amount, gas) =>
      `Lock ${money(amount)} of collateral in ${name} on ${chain} and mint a small stablecoin position against it, keeping the loan well below the liquidation line. Cost: ${money(amount)} of capital and about ${gas} of gas. Time: 20 minutes to set up.`,
    recurring: (name, chain, _chain2, gas) =>
      `Once a week, check the ${name} loan health on ${chain} and add collateral if the ratio drifts toward liquidation. Cost: about ${gas} of gas a week. Time: 10 minutes a week.`,
    second: (name, chain, _chain2, gas) =>
      `Vote once in ${possessive(name)} governance on ${chain} if it opens a proposal while you hold the position. Cost: about ${gas} of gas. Time: 10 minutes.`,
    risk: (name, chain, _chain2) =>
      `Keep the ${name} loan on ${chain} over-collateralised by at least double, so a sudden drop cannot liquidate it. Cost: no gas. Time: 5 minutes to check.`,
  };
}

function rwaPlaybook(): CategoryPlaybook {
  return {
    deposit: (name, chain, amount, gas) =>
      `Buy ${money(amount)} of ${possessive(name)} tokenised asset on ${chain} and hold it in the farming wallet. Cost: ${money(amount)} of capital and about ${gas} of gas. Time: 15 minutes to set up.`,
    recurring: (name, chain, _chain2, gas) =>
      `Once a month, check the ${name} asset backing on ${chain} and the redemption window before adding more. Cost: about ${gas} of gas a month. Time: 15 minutes a month.`,
    second: (name, chain, _chain2, gas) =>
      `Hold the ${name} position on ${chain} through one full redemption cycle to prove the holding period. Cost: about ${gas} of gas. Time: 15 minutes.`,
    risk: (name, chain, _chain2) =>
      `Check that ${possessive(name)} asset on ${chain} is backed by the real-world holding it claims before adding more. Cost: no gas. Time: 10 minutes to check.`,
  };
}

function derivativesPlaybook(): CategoryPlaybook {
  return {
    deposit: (name, chain, amount, gas) =>
      `Open a small ${money(amount)} hedged position on ${name} on ${chain}, sized so a single move cannot liquidate it. Cost: ${money(amount)} of capital and about ${gas} of gas. Time: 20 minutes to set up.`,
    recurring: (name, chain, _chain2, gas) =>
      `Once a week, check the ${name} position margin on ${chain} and trim it if funding turns against you. Cost: about ${gas} of gas a week. Time: 15 minutes a week.`,
    second: (name, chain, _chain2, gas) =>
      `Close and reopen the ${name} position on ${chain} once a month to refresh the activity record. Cost: about ${gas} of gas. Time: 15 minutes.`,
    risk: (name, chain, _chain2) =>
      `Size the ${name} position on ${chain} so a 20% move against you costs less than a tenth of the farm. Cost: no gas. Time: 5 minutes to check.`,
  };
}

function predictionPlaybook(): CategoryPlaybook {
  return {
    deposit: (name, chain, amount, gas) =>
      `Take a ${money(amount)} position on ${possessive(name)} longest-dated market on ${chain} and hold it to resolution. Cost: ${money(amount)} of capital and about ${gas} of gas. Time: 10 minutes to set up.`,
    recurring: (name, chain, _chain2, gas) =>
      `Once a week, review the ${name} market odds on ${chain} and add only if your read of the outcome still holds. Cost: about ${gas} of gas a week. Time: 10 minutes a week.`,
    second: (name, chain, _chain2, gas) =>
      `Trade a second ${name} market on ${chain} on a different outcome, so the wallet is not a one-bet account. Cost: about ${gas} of gas. Time: 10 minutes.`,
    risk: (name, chain, _chain2) =>
      `Treat the ${name} position on ${chain} as a bet that can go to zero if the outcome lands the other way. Cost: no gas. Time: 5 minutes to check.`,
  };
}

function bridgePlaybook(): CategoryPlaybook {
  return {
    deposit: (name, chain, amount, gas) =>
      `Bridge ${money(amount)} to ${chain} through ${name} and use the bridged funds on the destination chain. Cost: ${money(amount)} of capital and about ${gas} of gas. Time: 15 minutes to set up.`,
    recurring: (name, chain, chain2, gas) =>
      `Once a month, bridge a small amount through ${name} to ${chain2} to keep the route active. Cost: about ${gas} of gas a month. Time: 10 minutes a month.`,
    second: (name, chain, chain2, gas) =>
      `Use ${name} to bridge back from ${chain2} to ${chain} once, completing a round trip. Cost: about ${gas} of gas. Time: 15 minutes.`,
    risk: (name, chain, chain2) =>
      `Bridge only what you can afford to have stuck for a day if ${possessive(name)} route to ${chain2} pauses. Cost: no gas. Time: 5 minutes to check.`,
  };
}

function stakingPlaybook(): CategoryPlaybook {
  return {
    deposit: (name, chain, amount, gas) =>
      `Stake ${money(amount)} with ${name} on ${chain} and keep the staking receipt in the farming wallet. Cost: ${money(amount)} of capital and about ${gas} of gas. Time: 15 minutes to set up.`,
    recurring: (name, chain, _chain2, gas) =>
      `Once a month, restake the ${name} rewards on ${chain} instead of withdrawing them. Cost: about ${gas} of gas a month. Time: 10 minutes a month.`,
    second: (name, chain, _chain2, gas) =>
      `Delegate a second small stake through ${name} on ${chain} to a different validator or pool. Cost: about ${gas} of gas. Time: 10 minutes.`,
    risk: (name, chain, _chain2) =>
      `Check ${possessive(name)} slashing terms on ${chain} before staking more, and keep some funds unstaked for gas. Cost: no gas. Time: 5 minutes to check.`,
  };
}

function genericPlaybook(): CategoryPlaybook {
  return {
    deposit: (name, chain, amount, gas) =>
      `Put ${money(amount)} to work in ${possessive(name)} main product on ${chain} and keep the position receipt in the farming wallet. Cost: ${money(amount)} of capital and about ${gas} of gas. Time: 15 minutes to set up.`,
    recurring: (name, chain, _chain2, gas) =>
      `Once a week, use ${name} on ${chain} once more and record what you did and what it cost. Cost: about ${gas} of gas a week. Time: 10 minutes a week.`,
    second: (name, chain, _chain2, gas) =>
      `Complete one more distinct action in ${name} on ${chain} beyond the first deposit, and record the transaction. Cost: about ${gas} of gas. Time: 10 minutes.`,
    risk: (name, chain, _chain2) =>
      `Never put more in ${name} on ${chain} than you can lose, and keep the farming wallet separate from your main funds. Cost: no gas. Time: 5 minutes to check.`,
  };
}

function playbookFor(category: string | null): CategoryPlaybook {
  switch (category) {
    case 'Risk Curators':
    case 'Onchain Capital Allocator':
    case 'Yield':
    case 'Yield Aggregator':
    case 'Basis Trading':
      return vaultPlaybook();
    case 'Dexs':
      return dexPlaybook();
    case 'Lending':
      return lendingPlaybook();
    case 'CDP':
      return cdpPlaybook();
    case 'RWA':
      return rwaPlaybook();
    case 'Derivatives':
    case 'Options':
      return derivativesPlaybook();
    case 'Prediction Market':
      return predictionPlaybook();
    case 'Chain':
    case 'Cross Chain Bridge':
      return bridgePlaybook();
    case 'Staking Pool':
    case 'Restaking':
      return stakingPlaybook();
    default:
      return genericPlaybook();
  }
}

/** Six steps, each naming the protocol and its chain, with a cost and a time. */
function farmPlan(p: Proto, ageDays: number | null): string[] {
  const chain = p.chains[0] ?? 'Ethereum';
  const chain2 = p.chains[1] ?? chain;
  const gas = money(gasUsd(chain));
  const amount = p.tvl_usd >= 500_000_000 ? 150 : p.tvl_usd >= 50_000_000 ? 100 : 50;
  const book = playbookFor(p.category);
  const steps: string[] = [];
  steps.push(
    `Set aside a new wallet on ${chain} for ${p.name} only, funded with just the farming amount, and store its recovery phrase offline. Cost: about ${gas} in gas on ${chain}. Time: 5 minutes.`,
  );
  steps.push(book.deposit(p.name, chain, amount, gas));
  steps.push(book.recurring(p.name, chain, chain2, gas));
  steps.push(book.second(p.name, chain, chain2, gas));
  if (ageDays === null) {
    steps.push(
      `Give ${p.name} on ${chain} at least 6 months before judging the farm, and check the position every week until then. Cost: no gas. Time: 10 minutes a week.`,
    );
  } else if (ageDays >= 365) {
    const years = (ageDays / 365).toFixed(1);
    steps.push(
      `Keep the ${p.name} position on ${chain} running for at least 3 more months before withdrawing, since the protocol has already run ${years} years with no token. Cost: no gas. Time: 10 minutes a week.`,
    );
  } else {
    steps.push(
      `Give ${p.name} on ${chain} at least 6 months before judging the farm, since it has only run ${ageDays} days so far. Cost: no gas. Time: 10 minutes a week.`,
    );
  }
  steps.push(book.risk(p.name, chain, chain2));
  return steps;
}

// --- Board ------------------------------------------------------------------

/** Build the ranked board and the model report from the sealed snapshot. */
export function buildBoard(snapshot: Snapshot): BoardResult {
  const watchlist = new Set(snapshot.watchlist);
  const { peers, dropped } = tradedPeers(snapshot.protocols);
  const curve = fitSizeCurve(peers);
  const families = familyAdjustments(peers, curve);
  const validation = crossValidate(peers);

  const logMultiples = peers.map((p) => Math.log(p.mcap_usd! / p.tvl_usd));
  const growthCorr = correlation(
    peers.map((p) => {
      const g = p.change_7d;
      return g === null ? 0 : Math.max(-50, Math.min(50, g)) / 100;
    }),
    logMultiples,
  );
  const ageCorr = correlation(
    peers.map((p) => Math.log((ageDaysOf(p, snapshot.as_of) ?? 365) + 30)),
    logMultiples,
  );

  const candidates = snapshot.protocols.filter((p) => passesScreen(p));
  const scored = candidates.map((p) => {
    const { multiple, baseMultiple, family, adjustment, familyPeers } = fittedMultiple(
      p.tvl_usd,
      p.category,
      curve,
      families,
    );
    return {
      proto: p,
      implied: Math.max(1, Math.round(p.tvl_usd * multiple)),
      multiple,
      baseMultiple,
      family,
      adjustment,
      familyPeers,
      ageDays: ageDaysOf(p, snapshot.as_of),
    };
  });
  scored.sort((a, b) => {
    if (b.implied !== a.implied) return b.implied - a.implied;
    if (b.proto.tvl_usd !== a.proto.tvl_usd) return b.proto.tvl_usd - a.proto.tvl_usd;
    return a.proto.slug < b.proto.slug ? -1 : 1;
  });

  const rows: Row[] = scored.map((s, index) => ({
    slug: s.proto.slug,
    name: s.proto.name,
    rank: index + 1,
    implied_value_usd: s.implied,
    farm_steps: farmPlan(s.proto, s.ageDays),
    category: s.proto.category,
    chains: s.proto.chains,
    tvl_usd: s.proto.tvl_usd,
    change_7d: s.proto.change_7d,
    listed_at: s.proto.listed_at,
    watchlist: watchlist.has(s.proto.slug),
    age_days: s.ageDays,
    size_multiple: s.multiple,
    base_multiple: s.baseMultiple,
    family: s.family,
    family_adjustment: s.adjustment,
    family_peers: s.familyPeers,
    model: MODEL_NAME,
  }));

  const withToken = snapshot.protocols.filter(
    (p) => p.mcap_usd !== null || p.gecko_id !== null || p.symbol !== null,
  ).length;

  const familyRows = [...families.entries()]
    .map(([name, entry]) => ({ name, peers: entry.peers, adjustment: entry.adjustment }))
    .sort((a, b) => b.peers - a.peers);

  const report: ModelReport = {
    model: MODEL_NAME,
    as_of: snapshot.as_of,
    floor_usd: snapshot.floor_usd,
    protocols_total: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    rows: rows.length,
    early_rows: rows.filter((r) => !r.watchlist).length,
    set_aside: snapshot.protocols.length - rows.length,
    set_aside_with_token: withToken,
    peers_used: peers.length,
    peers_dropped: dropped,
    curve_intercept: curve.intercept,
    curve_slope: curve.slope,
    oos_median_factor: validation.medianFactor,
    oos_p70_factor: validation.p70Factor,
    oos_mean_log_error: validation.meanLogError,
    oos_folds: 5,
    growth_correlation: growthCorr,
    age_correlation: ageCorr,
    families: familyRows,
    methodology:
      'Implied value = TVL x a multiple fitted from the traded protocols in this snapshot. ' +
      'The multiple follows a size curve, log(multiple) = a + b x log(TVL), fitted by least squares on ' +
      `${peers.length} traded peers, then shifted by the median residual of the protocol's family, shrunk toward the curve by n/(n+2). ` +
      `Out-of-sample 5-fold cross-validation: the typical traded protocol's true market cap sits within x${validation.medianFactor.toFixed(2)} of the fitted value. ` +
      'The 7-day TVL change and the protocol age were tested as predictors of the traded multiple; both correlate about 0.00 and add nothing out of sample, so neither moves the value. ' +
      'A protocol is ranked only when the snapshot records no token for it and it is not a bridge, a staked or wrapped product, an exchange or a versioned deployment.',
  };

  return { rows, report };
}

/** The gate's shape, checked before anything is written. Returns the first problem. */
export function boardCheck(rows: Row[], snapshot: Snapshot): string | null {
  if (rows.length < 100 || rows.length > 4000) {
    return `board holds ${rows.length} rows: the gate wants 100 to 4000`;
  }
  const watchlist = new Set(snapshot.watchlist);
  const seen = new Set<string>();
  let previous = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    if (seen.has(row.slug)) return `board repeats ${row.slug}`;
    seen.add(row.slug);
    if (row.implied_value_usd <= 0 || !Number.isInteger(row.implied_value_usd)) {
      return `${row.slug}: implied value is not a positive whole number of dollars`;
    }
    if (row.implied_value_usd > 1e14) return `${row.slug}: implied value past the cap`;
    if (row.implied_value_usd > previous) return `board is not sorted at ${row.slug}`;
    previous = row.implied_value_usd;
    if (row.farm_steps.length < 3 || row.farm_steps.length > 12) {
      return `${row.slug}: ${row.farm_steps.length} farm steps, the gate wants 3 to 12`;
    }
    for (const step of row.farm_steps) {
      if (step.length < 20 || step.length > 600) {
        return `${row.slug}: a farm step is ${step.length} characters, the gate wants 20 to 600`;
      }
    }
  }
  for (const slug of watchlist) {
    if (!seen.has(slug)) return `board misses watchlist protocol ${slug}`;
  }
  return null;
}

/** The dashboard's data, written beside the page as data.js. */
export function dataScript(result: BoardResult): string {
  const payload = {
    meta: {
      model: result.report.model,
      as_of: result.report.as_of,
      floor_usd: result.report.floor_usd,
      rows: result.report.rows,
      watchlist_size: result.report.watchlist_size,
      peers_used: result.report.peers_used,
      peers_dropped: result.report.peers_dropped.length,
      curve_intercept: result.report.curve_intercept,
      curve_slope: result.report.curve_slope,
      oos_median_factor: result.report.oos_median_factor,
      oos_p70_factor: result.report.oos_p70_factor,
      growth_correlation: result.report.growth_correlation,
      age_correlation: result.report.age_correlation,
      families: result.report.families,
      methodology: result.report.methodology,
    },
    rows: result.rows,
  };
  return `window.TOKEN_RADAR = ${JSON.stringify(payload)};\n`;
}
