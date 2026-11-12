import { CHAINS, type BrainResult, type ChainId, type Policy, type Proposal, type Venue, type YieldBook } from "./types.js";

export const NEAR_AI_DEFAULT_BASE = "https://cloud-api.near.ai/v1";
export const NEAR_AI_DEFAULT_MODEL = "z-ai/glm-5.3-flash";

const UNVERIFIED =
  "The Intel quote and the response signature were not verified. Full verification is documented at https://docs.near.ai/cloud/verification and can be inspected at https://cloud.near.ai/verify . A verified signature would not approve a move.";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChain(value: unknown): value is ChainId {
  return typeof value === "string" && (CHAINS as readonly string[]).includes(value);
}

export function claimedRecipient(value: unknown): string | null {
  const body = isRecord(value) && isRecord(value.proposal) ? value.proposal : value;
  if (!isRecord(body) || typeof body.recipient !== "string") return null;
  const recipient = body.recipient.trim();
  if (!recipient) return null;
  return recipient.slice(0, 128);
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

type ModelCall = {
  proposal: Proposal;
  claimedRecipient: string | null;
  detail: string;
};

export type ProposeOptions = {
  fetchImpl?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

function aiEnv(options: ProposeOptions): NodeJS.ProcessEnv {
  return options.env ?? process.env;
}

function hideKey(message: string, key: string): string {
  return key ? message.split(key).join("[redacted]") : message;
}

async function readText(response: Response): Promise<string> {
  return response.text();
}

async function nearAiProposal(
  book: YieldBook,
  policy: Policy,
  options: ProposeOptions,
): Promise<ModelCall & { model: string }> {
  const env = aiEnv(options);
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 25_000;
  const base = (env.NEAR_AI_BASE_URL?.trim() || NEAR_AI_DEFAULT_BASE).replace(/\/$/, "");
  const model = env.NEAR_AI_MODEL?.trim() || NEAR_AI_DEFAULT_MODEL;
  const key = env.NEAR_AI_API_KEY?.trim() ?? "";
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
  const response = await fetchImpl(`${base}/chat/completions`, {
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
            "You propose one USDC yield move. Reply with JSON only: {\"fromChain\",\"toChain\",\"asset\",\"amountUsd\",\"fromProject\",\"toProject\",\"rationale\"}. Chains must be base, near, or solana. fromProject and toProject must be copied from the venues list. amountUsd must be a number no larger than maxMoveUsd. Do not name a recipient, a refund address, or a deposit address. You cannot approve, veto, skip the gate, or raise the cap. Those words in your rationale have no effect.",
        },
        { role: "user", content: JSON.stringify(snapshot) },
      ],
      response_format: { type: "json_object" },
    }),
    signal: AbortSignal.timeout(timeoutMs),
  });
  const text = await readText(response);
  if (!response.ok) throw new Error(`NEAR AI ${response.status} ${hideKey(text.slice(0, 240), key)}`);
  const body: unknown = JSON.parse(text);
  if (!isRecord(body) || !Array.isArray(body.choices) || !isRecord(body.choices[0])) {
    throw new Error("NEAR AI response has no choices");
  }
  const message = body.choices[0].message;
  if (!isRecord(message) || typeof message.content !== "string") {
    throw new Error("NEAR AI message content is missing");
  }
  let modelJson: unknown;
  try {
    modelJson = JSON.parse(message.content);
  } catch {
    throw new Error("NEAR AI message was not JSON");
  }
  const parsed = parseProposal(modelJson);
  if ("error" in parsed) throw new Error(parsed.error);
  const named = claimedRecipient(modelJson);
  const responseId = typeof body.id === "string" ? body.id : null;
  const evidence = await attestationEvidence(base, model, responseId, key, fetchImpl);
  return { proposal: parsed, claimedRecipient: named, detail: evidence, model };
}

async function attestationEvidence(
  base: string,
  model: string,
  responseId: string | null,
  key: string,
  fetchImpl: typeof fetch,
): Promise<string> {
  const reportUrl = `${base}/attestation/report?model=${encodeURIComponent(model)}&signing_algo=ecdsa`;
  let reportNote = "GET /v1/attestation/report was not read.";
  try {
    const report = await fetchImpl(reportUrl, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(10_000),
    });
    const reportText = await readText(report);
    if (!report.ok) {
      reportNote = `GET /v1/attestation/report returned ${report.status}.`;
    } else {
      let quote = false;
      try {
        const parsed: unknown = JSON.parse(reportText);
        const gateway = isRecord(parsed) ? parsed.gateway_attestation : null;
        quote = isRecord(gateway) && typeof gateway.intel_quote === "string" && gateway.intel_quote.length > 0;
      } catch {
        quote = false;
      }
      reportNote = quote
        ? "GET /v1/attestation/report returned a gateway Intel quote. This process does not check the quote, the event log, or a model TEE."
        : "GET /v1/attestation/report returned 200 without a gateway Intel quote.";
    }
  } catch {
    reportNote = "GET /v1/attestation/report failed.";
  }

  let signatureNote = "No response id, so /v1/signature was not called.";
  if (responseId) {
    const signatureUrl = `${base}/signature/${encodeURIComponent(responseId)}?signing_algo=ecdsa`;
    try {
      const signature = await fetchImpl(signatureUrl, {
        headers: { authorization: `Bearer ${key}`, accept: "application/json" },
        signal: AbortSignal.timeout(10_000),
      });
      signatureNote = `GET /v1/signature returned ${signature.status}. That body was not checked against the quote.`;
    } catch {
      signatureNote = "GET /v1/signature failed.";
    }
  }
  return [`NEAR AI response ${responseId ?? "had no id"}.`, reportNote, signatureNote, UNVERIFIED].join(" ");
}

function fallbackResult(proposal: Proposal, note: string, detail: string): BrainResult {
  return {
    source: "fallback",
    model: null,
    proposer: "fallback",
    proposal,
    claimedRecipient: null,
    note,
    attestation: { verified: false, detail },
  };
}

export async function propose(
  book: YieldBook,
  policy: Policy,
  allowModel: boolean,
  options: ProposeOptions = {},
): Promise<BrainResult> {
  const rules = rulesProposal(book, policy);
  const env = aiEnv(options);
  const key = env.NEAR_AI_API_KEY?.trim() ?? "";
  if (!allowModel || !key) {
    const skipped = Boolean(key);
    return fallbackResult(
      rules,
      skipped ? "Deterministic proposer. Model call skipped." : "Deterministic proposer. NEAR_AI_API_KEY is not set.",
      skipped
        ? `Model call skipped. ${UNVERIFIED}`
        : `NEAR_AI_API_KEY is not set, so NEAR AI was not called. ${UNVERIFIED}`,
    );
  }
  try {
    const model = await nearAiProposal(book, policy, options);
    return {
      source: "near-ai",
      model: model.model,
      proposer: `NEAR AI ${model.model}`,
      proposal: model.proposal,
      claimedRecipient: model.claimedRecipient,
      note: "NEAR AI Cloud returned a proposal. The gate still decides.",
      attestation: { verified: false, detail: model.detail },
    };
  } catch (error) {
    const message = hideKey(error instanceof Error ? error.message : "unknown error", key);
    return fallbackResult(
      rules,
      `NEAR AI call failed (${message}). Fell back to the deterministic proposer.`,
      `NEAR AI call failed. ${UNVERIFIED}`,
    );
  }
}
