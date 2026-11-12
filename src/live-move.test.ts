import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { loadPolicy } from "./gate.js";
import { findUsdc, loadTokenFixture, usdToBaseUnits } from "./intents.js";
import {
  appendDecision,
  decisionFromStatus,
  isDepositAddress,
  LIVE_AMOUNT_USD,
  missingLiveSwitches,
  prepareLiveQuote,
} from "./live-move.js";
import type { PreviewOutcome } from "./near-preview.js";
import type { QuoteRequest, QuoteResponse } from "./types.js";
import { loadYieldFixture } from "./yields.js";

const policy = loadPolicy();
const book = loadYieldFixture(policy);
const tokens = loadTokenFixture();
const now = new Date("2026-11-12T21:00:00.000Z");
const env = {
  LIVE: "1",
  SLUICE_EXECUTE: "yes",
  SLUICE_RECIPIENT: "owner.near",
  SLUICE_REFUND_TO: "0x1111111111111111111111111111111111111111",
};

function approvedPreview(): PreviewOutcome {
  return {
    available: true,
    approved: true,
    reasons: [],
    grossSpreadBps: 498,
    netSpreadBps: 428,
    contractId: "sluice-0andadream.testnet",
    network: "testnet",
    method: "preview",
  };
}

function quoteFor(request: QuoteRequest, depositAddress: string | undefined): QuoteResponse {
  return {
    correlationId: "test",
    timestamp: now.toISOString(),
    signature: "test",
    quoteRequest: request,
    quote: {
      depositAddress,
      amountIn: request.amount,
      amountInFormatted: "1",
      amountInUsd: "1",
      minAmountIn: request.amount,
      amountOut: request.amount,
      amountOutFormatted: "1",
      amountOutUsd: "1",
      minAmountOut: request.amount,
      timeEstimate: 60,
      deadline: request.deadline,
    },
  };
}

describe("owner-signed mainnet quote", () => {
  it("requires both live switches and does not ask for a quote without them", async () => {
    assert.deepEqual(missingLiveSwitches({}), ["LIVE=1", "SLUICE_EXECUTE=yes"]);
    let quotes = 0;
    const result = await prepareLiveQuote({
      env: { SLUICE_RECIPIENT: "owner.near", SLUICE_REFUND_TO: env.SLUICE_REFUND_TO },
      now,
      book,
      policy,
      preview: async () => approvedPreview(),
      tokens,
      requestQuote: async () => {
        quotes += 1;
        throw new Error("should not quote");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(quotes, 0);
    if (!result.ok) assert.match(result.detail, /LIVE=1 and SLUICE_EXECUTE=yes/);
  });

  it("does not quote when the contract preview vetoes", async () => {
    let quotes = 0;
    const result = await prepareLiveQuote({
      env,
      now,
      book,
      policy,
      preview: async (): Promise<PreviewOutcome> => ({
        available: true,
        approved: false,
        reasons: ["amount over the cap"],
        grossSpreadBps: 498,
        netSpreadBps: 428,
        contractId: "sluice-0andadream.testnet",
        network: "testnet",
        method: "preview",
      }),
      tokens,
      requestQuote: async () => {
        quotes += 1;
        throw new Error("should not quote");
      },
    });
    assert.equal(result.ok, false);
    assert.equal(quotes, 0);
    if (!result.ok) assert.match(result.detail, /Contract preview did not approve/);
  });

  it("prints a deposit address only after both gates and the quote match", async () => {
    const seen: QuoteRequest[] = [];
    const result = await prepareLiveQuote({
      env,
      now,
      book,
      policy,
      preview: async (args) => {
        assert.equal(args.amount_usd_cents, LIVE_AMOUNT_USD * 100);
        assert.equal(args.recipient, "");
        assert.equal(args.from_chain, "base");
        assert.equal(args.to_chain, "near");
        return approvedPreview();
      },
      tokens,
      requestQuote: async (request) => {
        seen.push(request);
        return quoteFor(request, "0xdeposit");
      },
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const origin = findUsdc(tokens, "base");
    assert.equal(seen.length, 1);
    assert.equal(seen[0]?.dry, false);
    assert.equal(seen[0]?.amount, usdToBaseUnits(1, origin.decimals));
    assert.equal(seen[0]?.recipient, "owner.near");
    assert.equal(seen[0]?.refundTo, env.SLUICE_REFUND_TO);
    assert.equal(result.pending.depositAddress, "0xdeposit");
    assert.equal(result.pending.contractId, "sluice-0andadream.testnet");
    assert.match(result.lines.join("\n"), /Send 1 USDC on Base/);
    assert.match(result.lines.join("\n"), /does not hold a mainnet key/);
  });

  it("withholds the deposit address when the quote does not match the approved move", async () => {
    const result = await prepareLiveQuote({
      env,
      now,
      book,
      policy,
      preview: async () => approvedPreview(),
      tokens,
      requestQuote: async (request) => quoteFor({ ...request, recipient: "someone-else.near" }, "0xdeposit"),
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.match(result.detail, /Quote gate vetoed/);
      assert.equal(result.lines.some((line) => line.includes("0xdeposit")), false);
    }
  });

  it("records a settled status with the deposit and destination transactions", () => {
    assert.equal(isDepositAddress("0xdeposit"), true);
    assert.equal(isDepositAddress("short"), false);
    const record = decisionFromStatus(
      {
        depositAddress: "0xdepositaddress",
        amount: "1000000",
        amountFormatted: "1",
        deadline: "2026-11-12T21:30:00.000Z",
        recipient: "owner.near",
        refundTo: env.SLUICE_REFUND_TO,
        contractId: "sluice-0andadream.testnet",
        offChainApproved: true,
        contractApproved: true,
        quotedAt: now.toISOString(),
      },
      {
        status: "SUCCESS",
        swapDetails: {
          originChainTxHashes: [{ hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" }],
          destinationChainTxHashes: [{ hash: "nearhash", explorerUrl: "https://nearblocks.io/txns/nearhash" }],
        },
      },
      "0xdepositaddress",
      now.toISOString(),
    );
    assert.equal(record.source, "mainnet");
    assert.equal(record.approved, true);
    assert.match(record.summary, /sluice-0andadream\.testnet/);
    assert.match(record.summary, /0xabc/);
    assert.match(record.summary, /nearhash/);
    assert.equal(record.explorerUrl, "https://nearblocks.io/txns/nearhash");
    const again = appendDecision([record], record);
    assert.equal(again.length, 1);
  });
});
