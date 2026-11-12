import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rulesProposal } from "./brain.js";
import { rootDir } from "./env.js";
import { evaluateProposal, evaluateQuote, loadPolicy } from "./gate.js";
import { findUsdc, interpretStatus, loadQuoteFixture, loadTokenFixture, asExecutionStatus } from "./intents.js";
import { nearAccountUrl } from "./links.js";
import type { ChainId, ExecutionStatus, YieldBook } from "./types.js";
import { fetchYieldBook, loadYieldFixture } from "./yields.js";

export type PublicDecision = {
  id: string;
  at: string;
  source: string;
  approved: boolean;
  summary: string;
  explorerUrl: string | null;
};

export type Deployment = {
  network: "testnet" | "mainnet";
  contractId: string;
  explorerAccount: string;
};

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function loadDecisions(): PublicDecision[] {
  const path = resolve(rootDir, "fixtures", "decisions.json");
  if (!existsSync(path)) return [];
  const body = readJson(path);
  if (!Array.isArray(body)) return [];
  return body.flatMap((row) => {
    if (typeof row !== "object" || row === null) return [];
    const item = row as Record<string, unknown>;
    if (typeof item.id !== "string" || typeof item.at !== "string" || typeof item.summary !== "string") return [];
    return [
      {
        id: item.id,
        at: item.at,
        source: typeof item.source === "string" ? item.source : "record",
        approved: item.approved === true,
        summary: item.summary,
        explorerUrl: typeof item.explorerUrl === "string" ? item.explorerUrl : null,
      },
    ];
  });
}

export function loadDeployment(): Deployment | null {
  const path = resolve(rootDir, "contracts", "sluice-gate", "deployed.json");
  if (!existsSync(path)) return null;
  const body = readJson(path);
  if (typeof body !== "object" || body === null) return null;
  const item = body as Record<string, unknown>;
  if (typeof item.contractId !== "string") return null;
  const network = item.network === "mainnet" ? "mainnet" : "testnet";
  return {
    network,
    contractId: item.contractId,
    explorerAccount:
      typeof item.explorerAccount === "string" ? item.explorerAccount : nearAccountUrl(item.contractId, network),
  };
}

function statusFixture(name: string): ExecutionStatus {
  return asExecutionStatus(readJson(resolve(rootDir, "fixtures", name)));
}

export function ageSeconds(iso: string, now = Date.now()): number | null {
  const then = Date.parse(iso);
  if (!Number.isFinite(then)) return null;
  return Math.max(0, Math.round((now - then) / 1000));
}

/** Live DefiLlama read for the control page. The dry-run keeps the longer timeout. */
export const STATE_FETCH_TIMEOUT_MS = 4_000;
export const STATE_CACHE_MS = 5 * 60 * 1000;

type CachedBook = { book: YieldBook; at: number };
let cachedBook: CachedBook | null = null;
let inflight: Promise<YieldBook> | null = null;
let cacheGeneration = 0;

export function clearControlBookCache(): void {
  cachedBook = null;
  inflight = null;
  cacheGeneration += 1;
}

export function formatAge(seconds: number): string {
  const whole = Number.isFinite(seconds) ? Math.max(0, Math.round(seconds)) : 0;
  if (whole < 60) return `${whole}s`;
  const minutes = Math.floor(whole / 60);
  const rem = whole % 60;
  if (minutes < 60) return rem === 0 ? `${minutes}m` : `${minutes}m ${rem}s`;
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  if (hours < 48) return mins === 0 ? `${hours}h` : `${hours}h ${mins}m`;
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return rest === 0 ? `${days}d` : `${days}d ${rest}h`;
}

export function snapshotDate(iso: string): string {
  const parsed = Date.parse(iso);
  if (!Number.isFinite(parsed)) return iso;
  return new Date(parsed).toISOString().slice(0, 10);
}

export function liveFeedLine(seconds: number): string {
  return `Live, updated ${formatAge(seconds)} ago`;
}

export function fixtureFeedLine(iso: string): string {
  return `Live feed unavailable, showing saved snapshot from ${snapshotDate(iso)}`;
}

async function liveBook(
  policy: ReturnType<typeof loadPolicy>,
  nowMs: number,
  fetchImpl: typeof fetch | undefined,
  timeoutMs: number,
  cacheMs: number,
): Promise<YieldBook> {
  if (cachedBook && nowMs - cachedBook.at < cacheMs) return cachedBook.book;
  const generation = cacheGeneration;
  if (!inflight) {
    const pending = fetchYieldBook(policy, { timeoutMs, fetchImpl }).finally(() => {
      if (inflight === pending) inflight = null;
    });
    inflight = pending;
  }
  const book = await inflight;
  if (book.candidates.length === 0) throw new Error("live yield book has no venues");
  if (generation === cacheGeneration) cachedBook = { book, at: nowMs };
  return book;
}

export async function buildPublicState(
  now = new Date(),
  options: { fetchImpl?: typeof fetch; timeoutMs?: number; cacheMs?: number } = {},
) {
  const policy = loadPolicy();
  let book: YieldBook;
  let live = true;
  try {
    book = await liveBook(
      policy,
      now.getTime(),
      options.fetchImpl,
      options.timeoutMs ?? STATE_FETCH_TIMEOUT_MS,
      options.cacheMs ?? STATE_CACHE_MS,
    );
  } catch {
    book = loadYieldFixture(policy);
    live = false;
  }
  const age = ageSeconds(book.fetchedAt, now.getTime());
  const proposal = rulesProposal(book, policy);
  const decision = evaluateProposal(proposal, book, policy, now, null, false, null);
  const probes = [
    {
      title: "$50",
      decision: evaluateProposal({ ...proposal, amountUsd: 50, rationale: "probe" }, book, policy, now, null, false, null),
    },
    {
      title: "ETH",
      decision: evaluateProposal({ ...proposal, asset: "ETH", rationale: "probe" }, book, policy, now, null, false, null),
    },
    {
      title: "Chain removed",
      decision: evaluateProposal(proposal, book, { ...policy, allowedChains: [policy.capitalChain] }, now, null, false, null),
    },
    {
      title: "Cooldown",
      decision: evaluateProposal(proposal, book, policy, now, new Date(now.getTime() - 1000), false, null),
    },
    {
      title: "Future approval",
      decision: evaluateProposal(proposal, book, policy, now, new Date(now.getTime() + 60_000), false, null),
    },
    {
      title: "Reverse",
      decision: evaluateProposal(
        {
          ...proposal,
          fromChain: proposal.toChain,
          toChain: proposal.fromChain,
          fromProject: proposal.toProject,
          toProject: proposal.fromProject,
          rationale: "probe",
        },
        book,
        policy,
        now,
        null,
        false,
        null,
      ),
    },
    {
      title: "$5000 to attacker.near",
      decision: evaluateProposal({ ...proposal, amountUsd: 5000, rationale: "probe" }, book, policy, now, null, false, "attacker.near"),
    },
  ];
  const tokens = (["base", "near", "solana"] as ChainId[]).map((chain) => {
    const token = findUsdc(loadTokenFixture(), chain);
    return { chain, blockchain: token.blockchain, assetId: token.assetId, decimals: token.decimals };
  });
  const quote = loadQuoteFixture();
  const quoteDecision = evaluateQuote(policy, quote, {
    originAsset: quote.quoteRequest.originAsset,
    destinationAsset: quote.quoteRequest.destinationAsset,
    amount: quote.quoteRequest.amount,
    recipient: quote.quoteRequest.recipient,
    refundTo: quote.quoteRequest.refundTo,
  });
  const amountIn = BigInt(quote.quote.amountIn);
  const minOut = BigInt(quote.quote.minAmountOut);
  const lossBps = amountIn > minOut ? Number(((amountIn - minOut) * 10_000n) / amountIn) : 0;
  const statuses = [
    ["status-pending.json", "pending"],
    ["status-success.json", "settled"],
    ["status-refunded.json", "refunded"],
    ["status-failed.json", "failed"],
    ["status-incomplete.json", "incomplete"],
  ].map(([file, outcome]) => {
    const read = interpretStatus(statusFixture(file ?? ""));
    return { file, outcome, summary: read.summary, status: read.status };
  });
  const deployment = loadDeployment();
  return {
    feed: live ? ("live" as const) : ("fixture" as const),
    feedLine: live ? liveFeedLine(age ?? 0) : fixtureFeedLine(book.fetchedAt),
    fetchedAt: book.fetchedAt,
    ageSeconds: age,
    generatedAt: now.toISOString(),
    book,
    proposal,
    brainNote: "Rules proposal. NEAR_AI_API_KEY is not set on this page.",
    brainSource: "rules" as const,
    decision,
    probes,
    tokens,
    quote,
    quoteDecision,
    lossBps,
    statuses,
    maxMoveUsd: policy.maxMoveUsd,
    feeBps: decision.feeBps,
    decisions: loadDecisions(),
    gate: deployment,
    liveQuote: false,
  };
}
