import { rulesProposal } from "./brain.js";
import { evaluateProposal, evaluateQuote, loadPolicy } from "./gate.js";
import { buildQuoteRequest, findUsdc, getTokens, requestQuote, usdToBaseUnits } from "./intents.js";
import { loadYieldFixture } from "./yields.js";

export type DryQuoteResult =
  | {
      ok: true;
      correlationId: string;
      amountInFormatted: string;
      amountOutFormatted: string;
      minAmountOut: string;
      timeEstimate: number;
      depositAddress: null;
      approved: boolean;
      reasons: string[];
    }
  | { ok: false; error: string };

/**
 * A dry quote only. LIVE is ignored. dry:false is never sent.
 * The recipient and refund address come from the server environment, not the request body.
 */
export async function runServerDryQuote(): Promise<DryQuoteResult> {
  const recipient = process.env.SLUICE_RECIPIENT?.trim() ?? "";
  const refundTo = process.env.SLUICE_REFUND_TO?.trim() ?? "";
  if (!recipient || !refundTo) {
    return {
      ok: false,
      error: "SLUICE_RECIPIENT and SLUICE_REFUND_TO are not set on the server. A dry quote was not requested.",
    };
  }
  const policy = loadPolicy();
  const book = loadYieldFixture(policy);
  const proposal = rulesProposal(book, policy);
  const decision = evaluateProposal(proposal, book, policy, new Date(), null, false, null);
  if (!decision.approved) {
    return { ok: false, error: `Gate vetoed the recorded proposal. ${decision.reasons.join("; ")}` };
  }
  if (proposal.fromChain !== "base" || proposal.toChain !== "near") {
    return { ok: false, error: "The recorded proposal is not Base USDC to NEAR USDC. No quote was requested." };
  }
  const saved = process.env.LIVE;
  delete process.env.LIVE;
  try {
    const tokens = await getTokens();
    const base = findUsdc(tokens, "base");
    const near = findUsdc(tokens, "near");
    const amount = usdToBaseUnits(proposal.amountUsd, base.decimals);
    const request = buildQuoteRequest({
      originAsset: base.assetId,
      destinationAsset: near.assetId,
      amount,
      recipient,
      refundTo,
      slippageToleranceBps: policy.slippageToleranceBps,
      deadline: new Date(Date.now() + policy.quoteDeadlineSeconds * 1000).toISOString(),
      dry: true,
    });
    if (request.dry !== true) return { ok: false, error: "Refusing a quote that is not dry." };
    const quote = await requestQuote(request);
    if (quote.quote.depositAddress) {
      return { ok: false, error: "The dry quote included a deposit address. It was not shown." };
    }
    const verdict = evaluateQuote(policy, quote, {
      originAsset: base.assetId,
      destinationAsset: near.assetId,
      amount,
      recipient,
      refundTo,
    });
    return {
      ok: true,
      correlationId: quote.correlationId,
      amountInFormatted: quote.quote.amountInFormatted,
      amountOutFormatted: quote.quote.amountOutFormatted,
      minAmountOut: quote.quote.minAmountOut,
      timeEstimate: quote.quote.timeEstimate,
      depositAddress: null,
      approved: verdict.approved,
      reasons: verdict.reasons,
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "dry quote failed" };
  } finally {
    if (saved === undefined) delete process.env.LIVE;
    else process.env.LIVE = saved;
  }
}
