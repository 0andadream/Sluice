import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evaluateQuote, loadPolicy, type QuoteExpectation } from "./gate.js";
import { broadcastBase, missingSwitches, runLiveMove, type OnchainApproval } from "./execute.js";
import { loadQuoteFixture } from "./intents.js";
import { statusExplorerLinks } from "./links.js";
import type { QuoteResponse } from "./types.js";

const policy = loadPolicy();
const recorded = loadQuoteFixture();
const expected: QuoteExpectation = {
  originAsset: recorded.quoteRequest.originAsset,
  destinationAsset: recorded.quoteRequest.destinationAsset,
  amount: recorded.quoteRequest.amount,
  recipient: recorded.quoteRequest.recipient,
  refundTo: recorded.quoteRequest.refundTo,
};
const approval: OnchainApproval = { source: "onchain", approved: true, id: "7" };

function io(overrides: Partial<Parameters<typeof runLiveMove>[0]> = {}) {
  const calls: string[] = [];
  const base = {
    armed: true,
    approval,
    policy,
    expected,
    requestQuote: async () => {
      calls.push("quote");
      return recorded;
    },
    signAndBroadcast: async () => {
      calls.push("sign");
      return { hash: "0xabc", explorerUrl: "https://basescan.org/tx/0xabc" };
    },
    notifyDeposit: async () => {
      calls.push("notify");
    },
    poll: async () => {
      calls.push("poll");
      return { outcome: "settled", summary: "Swap delivered the destination asset.", links: [] };
    },
    calls,
  };
  return { ...base, ...overrides, calls };
}

describe("runLiveMove", () => {
  it("does not quote when the on-chain gate has not approved", async () => {
    const harness = io({ approval: null });
    const result = await runLiveMove(harness);
    assert.equal(result.released, false);
    assert.equal(result.stoppedAt, "onchain-gate");
    assert.deepEqual(harness.calls, []);
  });

  it("does not quote when the live switches are off", async () => {
    const harness = io({ armed: false });
    const result = await runLiveMove(harness);
    assert.equal(result.stoppedAt, "live-switch");
    assert.deepEqual(harness.calls, []);
  });

  it("does not sign when the quote recipient does not match", async () => {
    const harness = io({ expected: { ...expected, recipient: "attacker.near" } });
    const result = await runLiveMove(harness);
    assert.equal(result.released, false);
    assert.equal(result.stoppedAt, "quote-gate");
    assert.deepEqual(harness.calls, ["quote"]);
    assert.match(result.detail, /recipient/);
  });

  it("polls SUCCESS, REFUNDED, and FAILED only after the gates", async () => {
    const previous = process.env.LIVE;
    process.env.LIVE = "1";
    try {
      for (const outcome of ["settled", "refunded", "failed"] as const) {
        const liveQuote = structuredClone(recorded);
        liveQuote.quoteRequest.dry = false;
        liveQuote.quote.depositAddress = "0x2222222222222222222222222222222222222222";
        const harness = io({
          requestQuote: async () => {
            harness.calls.push("quote");
            return liveQuote;
          },
          poll: async () => {
            harness.calls.push("poll");
            return { outcome, summary: outcome, links: [] };
          },
        });
        const result = await runLiveMove(harness);
        assert.equal(result.released, true);
        assert.equal(result.outcome, outcome);
        assert.deepEqual(harness.calls, ["quote", "sign", "notify", "poll"]);
      }
    } finally {
      if (previous === undefined) delete process.env.LIVE;
      else process.env.LIVE = previous;
    }
  });

  it("keeps explorer links from a status body", () => {
    const links = statusExplorerLinks({
      status: "SUCCESS",
      swapDetails: {
        nearTxHashes: ["abc123"],
        originChainTxHashes: [{ hash: "0xorigin", explorerUrl: "https://basescan.org/tx/0xorigin" }],
      },
    });
    assert.equal(links[0]?.url, "https://nearblocks.io/txns/abc123");
    assert.equal(links[1]?.url, "https://basescan.org/tx/0xorigin");
  });
});

describe("broadcast and switches", () => {
  it("refuses to broadcast when the process is not armed", async () => {
    let called = false;
    await assert.rejects(
      () =>
        broadcastBase("0x02aa", "https://example.invalid", {}, async () => {
          called = true;
          return new Response("{}");
        }),
      /Refusing to sign or broadcast/,
    );
    assert.equal(called, false);
  });

  it("posts a raw transaction only when armed", async () => {
    let body = "";
    const hash = await broadcastBase("0x02aa", "https://example.invalid", { LIVE: "1", SLUICE_EXECUTE: "yes" }, async (_url, init) => {
      body = String(init?.body ?? "");
      return new Response(JSON.stringify({ result: "0xhash" }));
    });
    assert.equal(hash, "0xhash");
    assert.match(body, /eth_sendRawTransaction/);
  });

  it("lists every missing live switch", () => {
    assert.deepEqual(missingSwitches([], {}), ["--live", "LIVE=1", "SLUICE_EXECUTE=yes"]);
    assert.deepEqual(missingSwitches(["--live"], { LIVE: "1", SLUICE_EXECUTE: "yes" }), []);
  });
});

describe("quote gate still binds the recorded quote", () => {
  it("accepts the fixture and rejects a swapped amount on the same object", () => {
    assert.equal(evaluateQuote(policy, recorded, expected).approved, true);
    const swapped: QuoteResponse = structuredClone(recorded);
    swapped.quoteRequest.amount = "1";
    swapped.quote.amountIn = "1";
    assert.equal(evaluateQuote(policy, swapped, expected).approved, false);
  });
});
