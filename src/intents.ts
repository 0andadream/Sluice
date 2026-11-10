import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rootDir } from "./env.js";
import {
  CLICK_BLOCKCHAIN,
  SWAP_STATUSES,
  type ChainId,
  type ExecutionStatus,
  type QuoteRequest,
  type QuoteResponse,
  type SwapStatus,
  type Token,
} from "./types.js";

export const ONECLICK_ORIGIN = "https://1click.chaindefuser.com";

function origin(): string {
  return (process.env.ONECLICK_BASE_URL?.trim() || ONECLICK_ORIGIN).replace(/\/$/, "");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function headers(): Record<string, string> {
  const out: Record<string, string> = {
    accept: "application/json",
    "content-type": "application/json",
  };
  const key = process.env.ONECLICK_API_KEY?.trim();
  if (key) out["x-api-key"] = key;
  return out;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = { message: text };
  }
  if (!response.ok) {
    const message = isRecord(body) && typeof body.message === "string" ? body.message : text.slice(0, 300);
    throw new Error(`1Click ${response.status} ${message}`);
  }
  return body;
}

function asToken(value: unknown): Token | null {
  if (!isRecord(value)) return null;
  if (typeof value.assetId !== "string") return null;
  if (typeof value.decimals !== "number") return null;
  if (typeof value.blockchain !== "string") return null;
  if (typeof value.symbol !== "string") return null;
  if (typeof value.price !== "number") return null;
  if (typeof value.priceUpdatedAt !== "string") return null;
  return {
    assetId: value.assetId,
    decimals: value.decimals,
    blockchain: value.blockchain,
    symbol: value.symbol,
    price: value.price,
    priceUpdatedAt: value.priceUpdatedAt,
    contractAddress: typeof value.contractAddress === "string" ? value.contractAddress : undefined,
  };
}

export async function getTokens(): Promise<Token[]> {
  const response = await fetch(`${origin()}/v0/tokens`, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  const body = await readBody(response);
  if (!Array.isArray(body)) throw new Error("1Click /v0/tokens did not return an array");
  return body.flatMap((row) => {
    const token = asToken(row);
    return token ? [token] : [];
  });
}

export function loadTokenFixture(): Token[] {
  const path = resolve(rootDir, "fixtures", "tokens.json");
  const body: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(body) || !Array.isArray(body.tokens)) throw new Error("fixtures/tokens.json is missing tokens");
  return body.tokens.flatMap((row) => {
    const token = asToken(row);
    return token ? [token] : [];
  });
}

export function findUsdc(tokens: Token[], chain: ChainId): Token {
  const blockchain = CLICK_BLOCKCHAIN[chain];
  const matches = tokens.filter((token) => token.symbol === "USDC" && token.blockchain === blockchain);
  if (matches.length !== 1) {
    throw new Error(`Expected one USDC on ${blockchain} from GET /v0/tokens, found ${matches.length}`);
  }
  const token = matches[0];
  if (!token) throw new Error(`USDC on ${blockchain} is missing`);
  return token;
}

export function usdToBaseUnits(amountUsd: number, decimals: number): string {
  const cents = Math.round(amountUsd * 100);
  if (!Number.isFinite(amountUsd) || cents <= 0) throw new Error("amountUsd must be positive");
  if (decimals < 2 || !Number.isInteger(decimals)) throw new Error("token decimals are invalid");
  const scale = 10n ** BigInt(decimals - 2);
  return (BigInt(cents) * scale).toString();
}

export function buildQuoteRequest(input: {
  originAsset: string;
  destinationAsset: string;
  amount: string;
  recipient: string;
  refundTo: string;
  slippageToleranceBps: number;
  deadline: string;
  dry?: boolean;
}): QuoteRequest {
  const dry = input.dry !== false;
  if (!dry && process.env.LIVE !== "1") {
    throw new Error("Refusing a live quote. dry defaults to true. LIVE=1 is required before a deposit address is requested, and that still does not send funds.");
  }
  return {
    dry,
    swapType: "EXACT_INPUT",
    slippageTolerance: input.slippageToleranceBps,
    originAsset: input.originAsset,
    depositType: "ORIGIN_CHAIN",
    destinationAsset: input.destinationAsset,
    amount: input.amount,
    refundTo: input.refundTo,
    refundType: "ORIGIN_CHAIN",
    recipient: input.recipient,
    recipientType: "DESTINATION_CHAIN",
    deadline: input.deadline,
    quoteWaitingTimeMs: 0,
  };
}

function asQuoteResponse(value: unknown): QuoteResponse {
  if (!isRecord(value) || !isRecord(value.quote) || !isRecord(value.quoteRequest)) {
    throw new Error("1Click quote response is missing quote or quoteRequest");
  }
  const quote = value.quote;
  for (const key of ["amountIn", "amountInFormatted", "amountInUsd", "minAmountIn", "amountOut", "amountOutFormatted", "amountOutUsd", "minAmountOut"]) {
    if (typeof quote[key] !== "string") throw new Error(`1Click quote.${key} is missing`);
  }
  if (typeof quote.timeEstimate !== "number") throw new Error("1Click quote.timeEstimate is missing");
  return value as QuoteResponse;
}

export async function requestQuote(request: QuoteRequest): Promise<QuoteResponse> {
  if (request.dry !== true && process.env.LIVE !== "1") {
    throw new Error("Refusing POST /v0/quote with dry:false while LIVE is not 1");
  }
  const response = await fetch(`${origin()}/v0/quote`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(request),
    signal: AbortSignal.timeout(40_000),
  });
  return asQuoteResponse(await readBody(response));
}

export function loadQuoteFixture(): QuoteResponse {
  const path = resolve(rootDir, "fixtures", "quote.json");
  const body: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!isRecord(body) || !isRecord(body.response)) throw new Error("fixtures/quote.json is missing response");
  return asQuoteResponse(body.response);
}

export type DepositNotice = {
  depositAddress: string;
  memo?: string;
  amount: string;
  assetId: string;
  note: string;
};

export function depositNotice(quoteResponse: QuoteResponse, assetId: string): DepositNotice {
  const address = quoteResponse.quote.depositAddress;
  if (!address) {
    throw new Error("This quote has no depositAddress. Dry quotes omit it. Nothing was sent.");
  }
  if (process.env.LIVE !== "1") {
    throw new Error("Refusing to describe a deposit while LIVE is not 1. Nothing was sent.");
  }
  return {
    depositAddress: address,
    memo: quoteResponse.quote.depositMemo,
    amount: quoteResponse.quote.amountIn,
    assetId,
    note: "Send the origin asset to depositAddress yourself. Sluice does not sign or broadcast that transfer in this build.",
  };
}

export async function submitDepositTxHash(input: {
  depositAddress: string;
  txHash: string;
  memo?: string;
}): Promise<ExecutionStatus> {
  if (process.env.LIVE !== "1") {
    throw new Error("Refusing POST /v0/deposit/submit while LIVE is not 1");
  }
  const response = await fetch(`${origin()}/v0/deposit/submit`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      depositAddress: input.depositAddress,
      txHash: input.txHash,
      memo: input.memo,
    }),
    signal: AbortSignal.timeout(30_000),
  });
  return asExecutionStatus(await readBody(response));
}

export async function getStatus(depositAddress: string, depositMemo?: string): Promise<ExecutionStatus> {
  const url = new URL(`${origin()}/v0/status`);
  url.searchParams.set("depositAddress", depositAddress);
  if (depositMemo) url.searchParams.set("depositMemo", depositMemo);
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(30_000),
  });
  return asExecutionStatus(await readBody(response));
}

function isStatus(value: unknown): value is SwapStatus {
  return typeof value === "string" && (SWAP_STATUSES as readonly string[]).includes(value);
}

export function asExecutionStatus(value: unknown): ExecutionStatus {
  if (!isRecord(value) || !isStatus(value.status)) {
    throw new Error("1Click status response has no known status");
  }
  const details = isRecord(value.swapDetails) ? value.swapDetails : undefined;
  return {
    correlationId: typeof value.correlationId === "string" ? value.correlationId : undefined,
    status: value.status,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : undefined,
    swapDetails: details
      ? {
          refundedAmount: typeof details.refundedAmount === "string" ? details.refundedAmount : undefined,
          refundedAmountFormatted:
            typeof details.refundedAmountFormatted === "string" ? details.refundedAmountFormatted : undefined,
          refundedAmountUsd: typeof details.refundedAmountUsd === "string" ? details.refundedAmountUsd : undefined,
          refundReason: typeof details.refundReason === "string" ? details.refundReason : undefined,
          amountOut: typeof details.amountOut === "string" ? details.amountOut : undefined,
          amountOutFormatted: typeof details.amountOutFormatted === "string" ? details.amountOutFormatted : undefined,
          nearTxHashes: Array.isArray(details.nearTxHashes)
            ? details.nearTxHashes.filter((hash): hash is string => typeof hash === "string")
            : undefined,
        }
      : undefined,
  };
}

export type StatusRead = {
  status: SwapStatus;
  terminal: boolean;
  outcome: "pending" | "settled" | "refunded" | "failed" | "incomplete";
  summary: string;
};

export function interpretStatus(status: ExecutionStatus): StatusRead {
  const refunded = status.swapDetails?.refundedAmountFormatted;
  const reason = status.swapDetails?.refundReason;
  switch (status.status) {
    case "SUCCESS":
      return {
        status: status.status,
        terminal: true,
        outcome: "settled",
        summary: "Swap delivered the destination asset.",
      };
    case "REFUNDED":
      return {
        status: status.status,
        terminal: true,
        outcome: "refunded",
        summary: `Swap failed and funds were returned to refundTo${refunded ? ` (${refunded})` : ""}${reason ? `: ${reason}` : ""}.`,
      };
    case "FAILED":
      return {
        status: status.status,
        terminal: true,
        outcome: "failed",
        summary: [
          "Swap failed.",
          refunded ? `Reported refund ${refunded}.` : "No refunded amount was on this status.",
          reason ? `Reason: ${reason}.` : "",
        ]
          .filter(Boolean)
          .join(" "),
      };
    case "INCOMPLETE_DEPOSIT":
      return {
        status: status.status,
        terminal: true,
        outcome: "incomplete",
        summary: "Deposit was below the required amount. 1Click refunds a short deposit by the deadline on EXACT_INPUT.",
      };
    default:
      return {
        status: status.status,
        terminal: false,
        outcome: "pending",
        summary: `${status.status}: keep polling /v0/status.`,
      };
  }
}

export async function pollStatus(
  depositAddress: string,
  depositMemo: string | undefined,
  intervalMs: number,
  timeoutMs: number,
): Promise<StatusRead & { raw: ExecutionStatus }> {
  const started = Date.now();
  let latest: ExecutionStatus | undefined;
  while (Date.now() - started <= timeoutMs) {
    latest = await getStatus(depositAddress, depositMemo);
    const read = interpretStatus(latest);
    if (read.terminal) return { ...read, raw: latest };
    await new Promise((resolveWait) => setTimeout(resolveWait, intervalMs));
  }
  if (!latest) throw new Error("status poll produced no response");
  const read = interpretStatus(latest);
  return { ...read, raw: latest };
}
