import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rootDir } from "./env.js";
import {
  annualizedCostBps as annualizedCostOf,
  grossSpreadBps as grossSpreadOf,
  paybackDays as paybackDaysOf,
  paybackExceeds,
} from "./policy-math.js";
import {
  CHAINS,
  type ChainId,
  type GateDecision,
  type Policy,
  type Proposal,
  type QuoteResponse,
  type Venue,
  type YieldBook,
} from "./types.js";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isChain(value: unknown): value is ChainId {
  return typeof value === "string" && (CHAINS as readonly string[]).includes(value);
}

function requiredNumber(body: Record<string, unknown>, key: string): number {
  const value = body[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`gate.policy.json ${key} must be a finite number`);
  }
  return value;
}

export function loadPolicy(path = resolve(rootDir, "gate.policy.json")): Policy {
  const body: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(body)) throw new Error("gate.policy.json must be an object");
  if (!Array.isArray(body.allowedAssets) || body.allowedAssets.some((asset) => typeof asset !== "string")) {
    throw new Error("gate.policy.json allowedAssets must be a string array");
  }
  if (!Array.isArray(body.allowedChains) || !body.allowedChains.every(isChain)) {
    throw new Error("gate.policy.json allowedChains must be base, near, or solana");
  }
  if (!Array.isArray(body.venues)) throw new Error("gate.policy.json venues must be an array");
  const venues = body.venues.map((venue) => {
    if (!isRecord(venue) || !isChain(venue.chain) || typeof venue.project !== "string" || venue.project.length === 0) {
      throw new Error("gate.policy.json venue needs chain and project");
    }
    return { chain: venue.chain, project: venue.project };
  });
  if (!isChain(body.capitalChain)) throw new Error("gate.policy.json capitalChain is invalid");
  if (!Array.isArray(body.allowedRecipients) || body.allowedRecipients.some((item) => typeof item !== "string")) {
    throw new Error("gate.policy.json allowedRecipients must be a string array");
  }
  const policy: Policy = {
    maxMoveUsd: requiredNumber(body, "maxMoveUsd"),
    allowedAssets: body.allowedAssets as string[],
    allowedChains: body.allowedChains as ChainId[],
    venues,
    minTvlUsd: requiredNumber(body, "minTvlUsd"),
    minNetSpreadBps: requiredNumber(body, "minNetSpreadBps"),
    slippageToleranceBps: requiredNumber(body, "slippageToleranceBps"),
    quoteLossBufferBps: requiredNumber(body, "quoteLossBufferBps"),
    unauthenticatedFeeBps: requiredNumber(body, "unauthenticatedFeeBps"),
    stablecoinRouteFeeBps: requiredNumber(body, "stablecoinRouteFeeBps"),
    assumedHoldDays: requiredNumber(body, "assumedHoldDays"),
    maxPaybackDays: requiredNumber(body, "maxPaybackDays"),
    cooldownSeconds: requiredNumber(body, "cooldownSeconds"),
    quoteDeadlineSeconds: requiredNumber(body, "quoteDeadlineSeconds"),
    capitalChain: body.capitalChain,
    allowedRecipients: body.allowedRecipients as string[],
  };
  if (policy.maxMoveUsd <= 0) throw new Error("maxMoveUsd must be positive");
  if (policy.assumedHoldDays <= 0) throw new Error("assumedHoldDays must be positive");
  if (policy.slippageToleranceBps < 0 || policy.unauthenticatedFeeBps < 0) {
    throw new Error("fee and slippage must be >= 0");
  }
  if (!policy.allowedChains.includes(policy.capitalChain)) {
    throw new Error("capitalChain must be an allowed chain");
  }
  return policy;
}

export function feeBpsFor(policy: Policy, proposal: Proposal, hasOneClickKey: boolean): number {
  const stableRoute =
    proposal.asset === "USDC" && policy.allowedAssets.includes("USDC") && proposal.fromChain !== proposal.toChain;
  if (hasOneClickKey && stableRoute) return policy.stablecoinRouteFeeBps;
  return policy.unauthenticatedFeeBps;
}

function findVenue(book: YieldBook, chain: ChainId, project: string): Venue | undefined {
  return book.candidates.find((venue) => venue.chain === chain && venue.project === project);
}

function cents(amountUsd: number): number | null {
  if (!Number.isFinite(amountUsd)) return null;
  const scaled = amountUsd * 100;
  const rounded = Math.round(scaled);
  if (Math.abs(scaled - rounded) > 1e-6) return null;
  return rounded;
}

export function evaluateProposal(
  proposal: Proposal,
  book: YieldBook,
  policy: Policy,
  now: Date,
  lastApprovedAt: Date | null,
  hasOneClickKey: boolean,
  claimedRecipient: string | null = null,
): GateDecision {
  const reasons: string[] = [];
  if (!policy.allowedAssets.includes(proposal.asset)) {
    reasons.push(`asset ${proposal.asset} is not in allowedAssets`);
  }
  if (!policy.allowedChains.includes(proposal.fromChain)) {
    reasons.push(`fromChain ${proposal.fromChain} is not allowed`);
  }
  if (!policy.allowedChains.includes(proposal.toChain)) {
    reasons.push(`toChain ${proposal.toChain} is not allowed`);
  }
  if (proposal.fromChain === proposal.toChain) {
    reasons.push("fromChain and toChain are the same");
  }
  const allowedFrom = policy.venues.some(
    (venue) => venue.chain === proposal.fromChain && venue.project === proposal.fromProject,
  );
  const allowedTo = policy.venues.some(
    (venue) => venue.chain === proposal.toChain && venue.project === proposal.toProject,
  );
  if (!allowedFrom) reasons.push(`fromProject ${proposal.fromProject} is not an allowed venue`);
  if (!allowedTo) reasons.push(`toProject ${proposal.toProject} is not an allowed venue`);

  const amountCents = cents(proposal.amountUsd);
  if (amountCents === null || amountCents <= 0) {
    reasons.push("amountUsd must be a positive amount in cents");
  } else if (amountCents > Math.round(policy.maxMoveUsd * 100)) {
    reasons.push(`amountUsd ${proposal.amountUsd} exceeds maxMoveUsd ${policy.maxMoveUsd}`);
  }

  if (lastApprovedAt) {
    const elapsed = now.getTime() - lastApprovedAt.getTime();
    if (!Number.isFinite(elapsed) || elapsed < 0) {
      reasons.push("last approval time is in the future");
    } else if (elapsed < policy.cooldownSeconds * 1000) {
      const wait = Math.ceil((policy.cooldownSeconds * 1000 - elapsed) / 1000);
      reasons.push(`cooldown has ${wait}s left`);
    }
  }

  if (claimedRecipient) {
    const allowed = policy.allowedRecipients.some((item) => sameEndpoint(item, claimedRecipient));
    if (!allowed) reasons.push(`recipient ${claimedRecipient} is not an allowed recipient`);
  }

  const source = findVenue(book, proposal.fromChain, proposal.fromProject);
  const dest = findVenue(book, proposal.toChain, proposal.toProject);
  if (!source) reasons.push(`no yield row for ${proposal.fromChain}/${proposal.fromProject}`);
  if (!dest) reasons.push(`no yield row for ${proposal.toChain}/${proposal.toProject}`);

  let grossSpreadBps: number | null = null;
  let fee = feeBpsFor(policy, proposal, hasOneClickKey);
  let oneTimeCostBps: number | null = null;
  let annualizedCostBps: number | null = null;
  let netSpreadBps: number | null = null;
  let paybackDays: number | null = null;

  if (source && dest) {
    grossSpreadBps = grossSpreadOf(dest.decisionApy, source.decisionApy);
    oneTimeCostBps = fee + policy.slippageToleranceBps;
    annualizedCostBps = annualizedCostOf(oneTimeCostBps, policy.assumedHoldDays);
    netSpreadBps = grossSpreadBps - annualizedCostBps;
    paybackDays = paybackDaysOf(oneTimeCostBps, grossSpreadBps);
    if (netSpreadBps < policy.minNetSpreadBps) {
      reasons.push(
        `net spread ${netSpreadBps} bps is below minNetSpreadBps ${policy.minNetSpreadBps} (gross ${grossSpreadBps} bps, annualized cost ${annualizedCostBps} bps)`,
      );
    }
    if (paybackExceeds(oneTimeCostBps, grossSpreadBps, policy.maxPaybackDays)) {
      if (grossSpreadBps <= 0) {
        reasons.push("spread is not positive, so the fee and slippage are not earned back");
      } else {
        reasons.push(`payback ${paybackDays.toFixed(1)} days exceeds maxPaybackDays ${policy.maxPaybackDays}`);
      }
    }
  }

  return {
    approved: reasons.length === 0,
    reasons,
    grossSpreadBps,
    feeBps: source && dest ? fee : null,
    oneTimeCostBps,
    annualizedCostBps,
    netSpreadBps,
    paybackDays: paybackDays !== null && Number.isFinite(paybackDays) ? paybackDays : paybackDays,
  };
}

function bpsBetween(amountIn: bigint, amountOut: bigint): number {
  if (amountOut >= amountIn) return 0;
  return Number(((amountIn - amountOut) * 10_000n) / amountIn);
}

/** What the approved proposal is allowed to be quoted as. */
export type QuoteExpectation = {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
};

function sameEndpoint(expected: string, actual: string): boolean {
  const left = expected.trim();
  const right = actual.trim();
  if (left.toLowerCase().startsWith("0x") || right.toLowerCase().startsWith("0x")) {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
}

function mismatch(
  reasons: string[],
  label: string,
  expected: string,
  actual: string | undefined,
  address = false,
): void {
  if (!expected) {
    reasons.push(`approved ${label} is empty`);
    return;
  }
  if (typeof actual !== "string" || actual.length === 0) {
    reasons.push(`quote ${label} is missing`);
    return;
  }
  const same = address ? sameEndpoint(expected, actual) : expected === actual;
  if (!same) reasons.push(`quote ${label} does not match the approved ${label}`);
}

export function evaluateQuote(
  policy: Policy,
  quoteResponse: QuoteResponse,
  expected: QuoteExpectation,
): GateDecision {
  const reasons: string[] = [];
  const quote = quoteResponse.quote;
  const request = quoteResponse.quoteRequest;
  mismatch(reasons, "from-asset", expected.originAsset, request.originAsset);
  mismatch(reasons, "to-asset", expected.destinationAsset, request.destinationAsset);
  mismatch(reasons, "recipient", expected.recipient, request.recipient, true);
  mismatch(reasons, "refund address", expected.refundTo, request.refundTo, true);
  mismatch(reasons, "amount", expected.amount, request.amount);
  if (request.amount !== quote.amountIn) {
    reasons.push("quote amountIn does not match quoteRequest.amount");
  }
  if (request.dry === true && quote.depositAddress) {
    reasons.push("dry quote included a deposit address");
  }
  let amountIn = 0n;
  let minOut = 0n;
  try {
    amountIn = BigInt(quote.amountIn);
    minOut = BigInt(quote.minAmountOut);
    if (amountIn <= 0n) reasons.push("quote amountIn is not positive");
  } catch {
    reasons.push("quote amountIn or minAmountOut is not an integer string");
  }
  const amountInUsd = Number(quote.amountInUsd);
  if (!Number.isFinite(amountInUsd)) {
    reasons.push("quote amountInUsd is not a number");
  } else if (amountInUsd > policy.maxMoveUsd) {
    reasons.push(`quote amountInUsd ${amountInUsd} exceeds maxMoveUsd ${policy.maxMoveUsd}`);
  }
  const lossBps = amountIn > 0n ? bpsBetween(amountIn, minOut) : 0;
  const lossBudget = policy.slippageToleranceBps + policy.quoteLossBufferBps;
  if (lossBps > lossBudget) {
    reasons.push(
      `quote minAmountOut loss ${lossBps} bps exceeds slippage ${policy.slippageToleranceBps} + buffer ${policy.quoteLossBufferBps}`,
    );
  }
  if (quoteResponse.quoteRequest.dry !== true && process.env.LIVE !== "1") {
    reasons.push("quote is not dry and LIVE is not 1");
  }
  return {
    approved: reasons.length === 0,
    reasons:
      reasons.length === 0
        ? [
            `minAmountOut loss ${lossBps} bps is within ${lossBudget} bps`,
            `amountInUsd ${quote.amountInUsd} is within maxMoveUsd ${policy.maxMoveUsd}`,
            quoteResponse.quoteRequest.dry
              ? "dry quote has no deposit address; nothing to send"
              : "live quote exposes a deposit address; funds move only after the on-chain gate approves and the live switches are set",
          ]
        : reasons,
    grossSpreadBps: null,
    feeBps: null,
    oneTimeCostBps: lossBps,
    annualizedCostBps: null,
    netSpreadBps: null,
    paybackDays: null,
  };
}
