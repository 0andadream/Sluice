import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rulesProposal } from "./brain.js";
import { rootDir } from "./env.js";
import { evaluateProposal, evaluateQuote, loadPolicy } from "./gate.js";
import { findUsdc, interpretStatus, loadQuoteFixture, loadTokenFixture, asExecutionStatus } from "./intents.js";
import { nearAccountUrl } from "./links.js";
import type { ChainId, ExecutionStatus } from "./types.js";
import { loadYieldFixture } from "./yields.js";

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

export function buildPublicState(now = new Date()) {
  const policy = loadPolicy();
  const book = loadYieldFixture(policy);
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
    fetchedAt: book.fetchedAt,
    ageSeconds: ageSeconds(book.fetchedAt, now.getTime()),
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
