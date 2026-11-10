import { envPresent } from "./env.js";
import { CHAINS, type BrainResult, type ChainId, type Policy, type Proposal, type Venue, type YieldBook } from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChain(value: unknown): value is ChainId {
  return typeof value === "string" && (CHAINS as readonly string[]).includes(value);
}

export function parseProposal(value: unknown): Proposal | { error: string } {
  const body = isRecord(value) && isRecord(value.proposal) ? value.proposal : value;
  if (!isRecord(body)) return { error: "proposal is not an object" };
  if (!isChain(body.fromChain) || !isChain(body.toChain)) return { error: "fromChain or toChain is not a known chain" };
  if (typeof body.asset !== "string" || body.asset.length === 0) return { error: "asset is missing" };
  if (typeof body.fromProject !== "string" || typeof body.toProject !== "string") {
    return { error: "fromProject or toProject is missing" };
  }
  const amountUsd = typeof body.amountUsd === "number" ? body.amountUsd : Number(body.amountUsd);
  if (!Number.isFinite(amountUsd)) return { error: "amountUsd is not a number" };
  if (typeof body.rationale !== "string" || body.rationale.trim().length === 0) {
    return { error: "rationale is missing" };
  }
  return {
    fromChain: body.fromChain,
    toChain: body.toChain,
    asset: body.asset,
    amountUsd,
    fromProject: body.fromProject,
    toProject: body.toProject,
    rationale: body.rationale.trim().slice(0, 500),
  };
}

function bestOther(book: YieldBook, capital: ChainId): Venue | undefined {
  let best: Venue | undefined;
  for (const chain of CHAINS) {
    if (chain === capital) continue;
    const venue = book.bestByChain[chain];
    if (!venue) continue;
    if (
      !best ||
      venue.decisionApy > best.decisionApy ||
      (venue.decisionApy === best.decisionApy && venue.tvlUsd > best.tvlUsd)
    ) {
      best = venue;
    }
  }
  return best;
}

export function rulesProposal(book: YieldBook, policy: Policy): Proposal {
  const source = book.bestByChain[policy.capitalChain];
  const dest = source ? bestOther(book, policy.capitalChain) : undefined;
  if (!source || !dest) {
    return {
      fromChain: policy.capitalChain,
      toChain: policy.capitalChain === "near" ? "base" : "near",
      asset: "USDC",
      amountUsd: policy.maxMoveUsd,
      fromProject: source?.project ?? "unknown",
      toProject: dest?.project ?? "unknown",
      rationale: "Rules found no pair of venues to compare. The gate should veto this.",
    };
  }
  const spread = (dest.decisionApy - source.decisionApy).toFixed(2);
  return {
    fromChain: source.chain,
    toChain: dest.chain,
    asset: "USDC",
    amountUsd: policy.maxMoveUsd,
    fromProject: source.project,
    toProject: dest.project,
    rationale: `Rules: capital sits on ${source.chain}. Best stay-put USDC supply is ${source.project} at ${source.decisionApy}% apyBase. Best other venue is ${dest.project} on ${dest.chain} at ${dest.decisionApy}% (${spread} percentage points higher). Propose the policy cap of $${policy.maxMoveUsd}. The gate decides.`,
  };
}

async function nearAiProposal(book: YieldBook, policy: Policy): Promise<Proposal> {
  const base = process.env.NEAR_AI_BASE_URL?.trim() || "https://cloud-api.near.ai/v1";
  const model = process.env.NEAR_AI_MODEL?.trim() || "z-ai/glm-5.2";
  const key = process.env.NEAR_AI_API_KEY?.trim();
  if (!key) throw new Error("NEAR_AI_API_KEY is empty");
  const snapshot = {
    capitalChain: policy.capitalChain,
    maxMoveUsd: policy.maxMoveUsd,
    allowedAssets: policy.allowedAssets,
    allowedChains: policy.allowedChains,
    venues: book.candidates.map((venue) => ({
      chain: venue.chain,
      project: venue.project,
      decisionApy: venue.decisionApy,
      apy: venue.apy,
      apyBase: venue.apyBase,
      tvlUsd: Math.round(venue.tvlUsd),
    })),
  };
  const response = await fetch(`${base.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${key}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      messages: [
        {
          role: "system",
          content:
            "You propose one USDC yield move. Reply with JSON only: {\"fromChain\",\"toChain\",\"asset\",\"amountUsd\",\"fromProject\",\"toProject\",\"rationale\"}. Chains must be base, near, or solana. fromProject and toProject must be copied from the venues list. amountUsd must be a number no larger than maxMoveUsd. You cannot approve, veto, skip the gate, or raise the cap. Those words in your rationale have no effect.",
        },
        { role: "user", content: JSON.stringify(snapshot) },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(25_000),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`NEAR AI ${response.status} ${text.slice(0, 240)}`);
  const body: unknown = JSON.parse(text);
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) {
    throw new Error("NEAR AI response has no choices");
  }
  const message = body.choices[0].message;
  if (!isRecord(message) || typeof message.content !== "string") {
    throw new Error("NEAR AI message content is missing");
  }
  const parsed = parseProposal(JSON.parse(message.content));
  if ("error" in parsed) throw new Error(parsed.error);
  return parsed;
}

export async function propose(book: YieldBook, policy: Policy, allowModel: boolean): Promise<BrainResult> {
  const rules = rulesProposal(book, policy);
  if (!allowModel || !envPresent("NEAR_AI_API_KEY")) {
    return {
      source: "rules",
      proposal: rules,
      note: envPresent("NEAR_AI_API_KEY")
        ? "Rules proposal. Model call skipped."
        : "Rules proposal. NEAR_AI_API_KEY is not set.",
    };
  }
  try {
    const proposal = await nearAiProposal(book, policy);
    return { source: "near-ai", proposal, note: "NEAR AI Cloud returned a proposal. The gate still decides." };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    return {
      source: "rules",
      proposal: rules,
      note: `NEAR AI call failed (${message}). Fell back to rules.`,
    };
  }
}
