import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { evaluateProposal, evaluateQuote, loadPolicy, type QuoteExpectation } from "./gate.js";
import { rootDir } from "./env.js";
import {
  buildQuoteRequest,
  findUsdc,
  getTokens,
  interpretStatus,
  pollStatus,
  requestQuote,
  usdToBaseUnits,
} from "./intents.js";
import { statusExplorerLinks } from "./links.js";
import { previewOnTestnet, type PreviewArgs, type PreviewOutcome } from "./near-preview.js";
import { apyToPpm } from "./policy-math.js";
import { loadDecisions, type PublicDecision } from "./snapshot.js";
import type { ExecutionStatus, Policy, Proposal, QuoteRequest, QuoteResponse, Token, YieldBook } from "./types.js";
import { loadYieldFixture } from "./yields.js";

/** One USDC, under the $10 policy cap. The owner sends it. This process does not. */
export const LIVE_AMOUNT_USD = 1;

export type PendingLiveQuote = {
  depositAddress: string;
  amount: string;
  amountFormatted: string;
  deadline: string;
  recipient: string;
  refundTo: string;
  contractId: string;
  offChainApproved: true;
  contractApproved: true;
  quotedAt: string;
};

export type LiveQuoteSuccess = {
  ok: true;
  pending: PendingLiveQuote;
  lines: string[];
};

export type LiveQuoteStop = {
  ok: false;
  detail: string;
  lines: string[];
};

export function missingLiveSwitches(env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (env.LIVE !== "1") missing.push("LIVE=1");
  if (env.SLUICE_EXECUTE !== "yes") missing.push("SLUICE_EXECUTE=yes");
  return missing;
}

export function isDepositAddress(value: string): boolean {
  return /^[A-Za-z0-9._:-]{8,128}$/.test(value);
}

export function liveProposal(policy: Policy): Proposal {
  if (LIVE_AMOUNT_USD > policy.maxMoveUsd) {
    throw new Error(`${LIVE_AMOUNT_USD} USDC is above maxMoveUsd ${policy.maxMoveUsd}`);
  }
  return {
    fromChain: "base",
    toChain: "near",
    asset: "USDC",
    amountUsd: LIVE_AMOUNT_USD,
    fromProject: "fluid-lending",
    toProject: "rhea-lend",
    rationale: "Owner-signed proof. 1 USDC from Base to NEAR. The gate decides. Sluice does not sign the deposit.",
  };
}

function endpoint(env: NodeJS.ProcessEnv, name: "SLUICE_RECIPIENT" | "SLUICE_REFUND_TO"): string | null {
  const value = env[name]?.trim() ?? "";
  return value.length > 0 ? value : null;
}

function ppm(book: YieldBook, chain: Proposal["fromChain"], project: string): number {
  const venue = book.candidates.find((row) => row.chain === chain && row.project === project);
  if (!venue) return 0;
  const value = apyToPpm(venue.decisionApy);
  return Number.isSafeInteger(value) ? value : 0;
}

function previewArgs(proposal: Proposal, book: YieldBook): PreviewArgs {
  return {
    from_chain: proposal.fromChain,
    to_chain: proposal.toChain,
    asset: proposal.asset,
    amount_usd_cents: Math.round(proposal.amountUsd * 100),
    from_project: proposal.fromProject,
    to_project: proposal.toProject,
    recipient: "",
    source_apy_ppm: ppm(book, proposal.fromChain, proposal.fromProject),
    dest_apy_ppm: ppm(book, proposal.toChain, proposal.toProject),
  };
}

function stop(detail: string): LiveQuoteStop {
  return { ok: false, detail, lines: [detail, "No deposit address was printed. Nothing was signed."] };
}

export async function prepareLiveQuote(input: {
  env: NodeJS.ProcessEnv;
  now: Date;
  book: YieldBook;
  policy: Policy;
  preview: (args: PreviewArgs) => Promise<PreviewOutcome>;
  tokens: Token[];
  requestQuote: (request: QuoteRequest) => Promise<QuoteResponse>;
}): Promise<LiveQuoteSuccess | LiveQuoteStop> {
  const missing = missingLiveSwitches(input.env);
  if (missing.length > 0) {
    return stop(`Refusing a mainnet quote. Set ${missing.join(" and ")}.`);
  }
  const recipient = endpoint(input.env, "SLUICE_RECIPIENT");
  const refundTo = endpoint(input.env, "SLUICE_REFUND_TO");
  if (!recipient || !refundTo) {
    return stop("SLUICE_RECIPIENT and SLUICE_REFUND_TO are required. The model does not choose either address.");
  }
  const proposal = liveProposal(input.policy);
  const offChain = evaluateProposal(proposal, input.book, input.policy, input.now, null, false, null);
  if (!offChain.approved) {
    return stop(`Off-chain gate vetoed the 1 USDC move. ${offChain.reasons.join(" ")}`);
  }
  const preview = await input.preview(previewArgs(proposal, input.book));
  if (!preview.available || !preview.approved) {
    const why = preview.available ? preview.reasons.join(" ") : preview.error;
    return stop(`Contract preview did not approve. ${why}`);
  }
  const origin = findUsdc(input.tokens, "base");
  const destination = findUsdc(input.tokens, "near");
  const amount = usdToBaseUnits(LIVE_AMOUNT_USD, origin.decimals);
  const deadline = new Date(input.now.getTime() + input.policy.quoteDeadlineSeconds * 1000).toISOString();
  const previousLive = process.env.LIVE;
  process.env.LIVE = input.env.LIVE;
  let quote: QuoteResponse;
  let quoteDecision;
  try {
    const request = buildQuoteRequest({
      originAsset: origin.assetId,
      destinationAsset: destination.assetId,
      amount,
      recipient,
      refundTo,
      slippageToleranceBps: input.policy.slippageToleranceBps,
      deadline,
      dry: false,
    });
    quote = await input.requestQuote(request);
    const expected: QuoteExpectation = {
      originAsset: origin.assetId,
      destinationAsset: destination.assetId,
      amount,
      recipient,
      refundTo,
    };
    quoteDecision = evaluateQuote(input.policy, quote, expected);
  } finally {
    if (previousLive === undefined) delete process.env.LIVE;
    else process.env.LIVE = previousLive;
  }
  if (!quoteDecision.approved) {
    return stop(`Quote gate vetoed the 1Click response. ${quoteDecision.reasons.join(" ")}`);
  }
  const depositAddress = quote.quote.depositAddress;
  if (!depositAddress) {
    return stop("The live quote did not include a deposit address. Nothing was signed.");
  }
  const pending: PendingLiveQuote = {
    depositAddress,
    amount: quote.quote.amountIn,
    amountFormatted: quote.quote.amountInFormatted,
    deadline: quote.quote.deadline ?? deadline,
    recipient,
    refundTo,
    contractId: preview.contractId,
    offChainApproved: true,
    contractApproved: true,
    quotedAt: input.now.toISOString(),
  };
  const lines = [
    `Off-chain gate approved. Contract preview on ${preview.contractId} approved.`,
    `Send ${pending.amountFormatted} USDC on Base (${pending.amount} base units) to ${pending.depositAddress}.`,
    `Deadline: ${pending.deadline}.`,
    `Recipient on NEAR: ${recipient}.`,
    `Refund on Base: ${refundTo}.`,
    "Send it from your own wallet. Sluice does not hold a mainnet key and will not sign or broadcast this transfer.",
    `After it is sent: npm run live:status -- ${depositAddress}`,
  ];
  return { ok: true, pending, lines };
}

export function decisionFromStatus(
  pending: PendingLiveQuote | null,
  status: ExecutionStatus,
  depositAddress: string,
  at: string,
): PublicDecision {
  const links = statusExplorerLinks(status);
  const origin = status.swapDetails?.originChainTxHashes?.[0];
  const destination = status.swapDetails?.destinationChainTxHashes?.[0];
  const gate = pending
    ? `Off-chain gate approved. Contract preview on ${pending.contractId} approved.`
    : "Local quote record was not found.";
  const summary = [
    "1 USDC Base to NEAR.",
    `Deposit ${depositAddress}.`,
    gate,
    `1Click ${status.status}. ${interpretStatus(status).summary}`,
    origin ? `Deposit tx ${origin.hash}.` : "No deposit tx on the status.",
    destination ? `Destination tx ${destination.hash}.` : "No destination tx on the status.",
    pending ? `Deadline ${pending.deadline}.` : "",
    ...links.map((link) => link.url),
  ]
    .filter((part) => part.length > 0)
    .join(" ");
  return {
    id: `mainnet-${depositAddress.slice(0, 18)}`,
    at,
    source: "mainnet",
    approved: status.status === "SUCCESS",
    summary,
    explorerUrl: destination?.explorerUrl || origin?.explorerUrl || links[0]?.url || null,
  };
}

export function appendDecision(decisions: PublicDecision[], next: PublicDecision): PublicDecision[] {
  if (decisions.some((item) => item.id === next.id)) return decisions;
  return [...decisions, next];
}

export function pendingPath(): string {
  return resolve(rootDir, "fixtures", "live-pending.json");
}

export function decisionsPath(): string {
  return resolve(rootDir, "fixtures", "decisions.json");
}

export function readPending(depositAddress: string): PendingLiveQuote | null {
  const path = pendingPath();
  if (!existsSync(path)) return null;
  const body: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (typeof body !== "object" || body === null) return null;
  const item = body as PendingLiveQuote;
  if (item.depositAddress !== depositAddress) return null;
  if (item.offChainApproved !== true || item.contractApproved !== true) return null;
  return item;
}

export function writePending(pending: PendingLiveQuote): void {
  writeFileSync(pendingPath(), `${JSON.stringify(pending, null, 2)}\n`);
}

export function writeDecisions(decisions: PublicDecision[]): void {
  writeFileSync(decisionsPath(), `${JSON.stringify(decisions, null, 2)}\n`);
}

export async function quoteMainnetMove(env: NodeJS.ProcessEnv = process.env, now = new Date()): Promise<number> {
  const missing = missingLiveSwitches(env);
  if (missing.length > 0) {
    process.stdout.write(`Refusing a mainnet quote. Set ${missing.join(" and ")}.\nNo deposit address was printed. Nothing was signed.\n`);
    return 1;
  }
  const policy = loadPolicy();
  const book = loadYieldFixture(policy);
  const result = await prepareLiveQuote({
    env,
    now,
    book,
    policy,
    preview: (args) => previewOnTestnet(args),
    tokens: await getTokens(),
    requestQuote,
  });
  for (const line of result.lines) process.stdout.write(`${line}\n`);
  if (!result.ok) return 1;
  writePending(result.pending);
  return 0;
}

export async function statusMainnetMove(depositAddress: string, env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const missing = missingLiveSwitches(env);
  if (missing.length > 0) {
    process.stdout.write(`Refusing to poll 1Click. Set ${missing.join(" and ")}.\n`);
    return 1;
  }
  if (!isDepositAddress(depositAddress)) {
    process.stdout.write("Pass the deposit address from live:quote. Example: npm run live:status -- <depositAddress>\n");
    return 1;
  }
  const polled = await pollStatus(depositAddress, undefined, 15_000, 20 * 60_000);
  const record = decisionFromStatus(readPending(depositAddress), polled.raw, depositAddress, new Date().toISOString());
  writeDecisions(appendDecision(loadDecisions(), record));
  process.stdout.write(`${record.summary}\n`);
  if (record.explorerUrl) process.stdout.write(`${record.explorerUrl}\n`);
  process.stdout.write(`Recorded in fixtures/decisions.json. Approved: ${record.approved}.\n`);
  return polled.terminal ? 0 : 1;
}
