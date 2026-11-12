import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rootDir } from "./env.js";
import { CHAINS, LLAMA_CHAIN, type ChainId, type Policy, type Venue, type YieldBook } from "./types.js";

export const YIELDS_URL = "https://yields.llama.fi/pools";

const LLAMA_TO_CHAIN = new Map<string, ChainId>(
  CHAINS.map((chain) => [LLAMA_CHAIN[chain], chain]),
);

type LlamaPool = {
  chain?: unknown;
  project?: unknown;
  symbol?: unknown;
  tvlUsd?: unknown;
  apy?: unknown;
  apyBase?: unknown;
  apyReward?: unknown;
  pool?: unknown;
  stablecoin?: unknown;
  ilRisk?: unknown;
  exposure?: unknown;
  poolMeta?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function num(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return value;
}

function decisionApy(apyBase: number | null, apy: number | null): number | null {
  if (apyBase !== null) return apyBase;
  return apy;
}

export function venuesFromPools(pools: unknown[], policy: Policy): Venue[] {
  const allowed = new Set(policy.venues.map((venue) => `${venue.chain}:${venue.project}`));
  const venues: Venue[] = [];
  for (const row of pools) {
    if (!isRecord(row)) continue;
    const pool = row as LlamaPool;
    if (pool.stablecoin !== true) continue;
    if (pool.symbol !== "USDC") continue;
    if (pool.exposure !== "single") continue;
    if (pool.ilRisk !== "no") continue;
    if (typeof pool.chain !== "string" || typeof pool.project !== "string") continue;
    const chain = LLAMA_TO_CHAIN.get(pool.chain);
    if (!chain || !policy.allowedChains.includes(chain)) continue;
    if (!allowed.has(`${chain}:${pool.project}`)) continue;
    const tvlUsd = num(pool.tvlUsd);
    if (tvlUsd === null || tvlUsd < policy.minTvlUsd) continue;
    const apy = num(pool.apy);
    const apyBase = num(pool.apyBase);
    const chosen = decisionApy(apyBase, apy);
    if (chosen === null || chosen < 0) continue;
    if (typeof pool.pool !== "string" || pool.pool.length === 0) continue;
    venues.push({
      chain,
      project: pool.project,
      symbol: "USDC",
      pool: pool.pool,
      tvlUsd,
      apy,
      apyBase,
      apyReward: num(pool.apyReward),
      poolMeta: typeof pool.poolMeta === "string" && pool.poolMeta.length > 0 ? pool.poolMeta : null,
      decisionApy: chosen,
    });
  }
  venues.sort((a, b) => b.decisionApy - a.decisionApy || b.tvlUsd - a.tvlUsd);
  return venues;
}

export function bestByChain(venues: Venue[]): Partial<Record<ChainId, Venue>> {
  const best: Partial<Record<ChainId, Venue>> = {};
  for (const venue of venues) {
    const current = best[venue.chain];
    if (
      !current ||
      venue.decisionApy > current.decisionApy ||
      (venue.decisionApy === current.decisionApy && venue.tvlUsd > current.tvlUsd)
    ) {
      best[venue.chain] = venue;
    }
  }
  return best;
}

export function bookFromPools(
  pools: unknown[],
  policy: Policy,
  source: YieldBook["source"],
  fetchedAt: string,
): YieldBook {
  const candidates = venuesFromPools(pools, policy);
  return {
    source,
    fetchedAt,
    url: YIELDS_URL,
    candidates,
    bestByChain: bestByChain(candidates),
  };
}

export async function fetchYieldBook(
  policy: Policy,
  options: { timeoutMs?: number; fetchImpl?: typeof fetch } = {},
): Promise<YieldBook> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const response = await fetchImpl(YIELDS_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
  });
  if (!response.ok) {
    throw new Error(`DefiLlama yields ${response.status} ${response.statusText}`);
  }
  const body: unknown = await response.json();
  const pools = isRecord(body) && Array.isArray(body.data) ? body.data : null;
  if (!pools) throw new Error("DefiLlama yields response has no data array");
  return bookFromPools(pools, policy, "live", new Date().toISOString());
}

export function loadYieldFixture(policy: Policy): YieldBook {
  const path = resolve(rootDir, "fixtures", "yields.json");
  const body: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(body) || !Array.isArray(body.pools)) {
    throw new Error("fixtures/yields.json is missing pools");
  }
  const fetchedAt = typeof body.recordedAt === "string" ? body.recordedAt : "fixture";
  return bookFromPools(body.pools, policy, "fixture", fetchedAt);
}

export function requireVenue(book: YieldBook, chain: ChainId): Venue {
  const venue = book.bestByChain[chain];
  if (!venue) throw new Error(`No USDC venue passed the policy on ${chain}`);
  return venue;
}
