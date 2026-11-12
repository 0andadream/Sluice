import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { rulesProposal } from "./brain.js";
import { evaluateProposal, evaluateQuote, loadPolicy, type QuoteExpectation } from "./gate.js";
import { loadQuoteFixture } from "./intents.js";
import { loadYieldFixture } from "./yields.js";

const policy = loadPolicy();
const book = loadYieldFixture(policy);
const proposal = rulesProposal(book, policy);
const now = new Date("2026-11-12T12:00:00.000Z");

function expectVeto(reasons: string[], fragment: string): void {
  assert.ok(
    reasons.some((reason) => reason.includes(fragment)),
    `missing "${fragment}" in ${reasons.join(" | ")}`,
  );
}

describe("evaluateProposal", () => {
  it("approves the recorded book at the 20 bp unauthenticated fee", () => {
    const decision = evaluateProposal(proposal, book, policy, now, null, false, null);
    assert.equal(decision.approved, true);
    assert.equal(decision.grossSpreadBps, 498);
    assert.equal(decision.feeBps, 20);
    assert.equal(decision.oneTimeCostBps, 70);
    assert.equal(decision.annualizedCostBps, 70);
    assert.equal(decision.netSpreadBps, 428);
    assert.ok(decision.paybackDays !== null && Math.abs(decision.paybackDays - 51.30522088353413) < 1e-9);
  });

  it("uses 1 bp when a 1Click key is configured", () => {
    const decision = evaluateProposal(proposal, book, policy, now, null, true, null);
    assert.equal(decision.approved, true);
    assert.equal(decision.feeBps, 1);
    assert.equal(decision.oneTimeCostBps, 51);
    assert.equal(decision.netSpreadBps, 447);
  });

  it("blocks a last-approval time in the future", () => {
    const future = new Date(now.getTime() + 60_000);
    const decision = evaluateProposal(proposal, book, policy, now, future, false, null);
    assert.equal(decision.approved, false);
    expectVeto(decision.reasons, "last approval time is in the future");
  });

  it("blocks inside the cooldown and allows the exact boundary", () => {
    const inside = new Date(now.getTime() - policy.cooldownSeconds * 1000 + 1);
    const blocked = evaluateProposal(proposal, book, policy, now, inside, false, null);
    assert.equal(blocked.approved, false);
    expectVeto(blocked.reasons, "cooldown");

    const boundary = new Date(now.getTime() - policy.cooldownSeconds * 1000);
    const open = evaluateProposal(proposal, book, policy, now, boundary, false, null);
    assert.equal(open.approved, true);
  });

  it("blocks $5000 and a named attacker recipient", () => {
    const attack = { ...proposal, amountUsd: 5000 };
    const decision = evaluateProposal(attack, book, policy, now, null, false, "attacker.near");
    assert.equal(decision.approved, false);
    expectVeto(decision.reasons, "amountUsd 5000 exceeds maxMoveUsd 10");
    expectVeto(decision.reasons, "recipient attacker.near is not an allowed recipient");
  });

  it("blocks a cap-sized move that names an attacker", () => {
    const decision = evaluateProposal(proposal, book, policy, now, null, false, "attacker.near");
    assert.equal(decision.approved, false);
    expectVeto(decision.reasons, "attacker.near");
    assert.equal(
      decision.reasons.some((reason) => reason.includes("exceeds maxMoveUsd")),
      false,
    );
  });
});

describe("evaluateQuote", () => {
  const recorded = loadQuoteFixture();
  const expected: QuoteExpectation = {
    originAsset: recorded.quoteRequest.originAsset,
    destinationAsset: recorded.quoteRequest.destinationAsset,
    amount: recorded.quoteRequest.amount,
    recipient: recorded.quoteRequest.recipient,
    refundTo: recorded.quoteRequest.refundTo,
  };

  it("accepts the recorded quote, including a differently cased refund address", () => {
    assert.equal(evaluateQuote(policy, recorded, expected).approved, true);
    const cased = {
      ...expected,
      refundTo: expected.refundTo.toLowerCase(),
    };
    assert.equal(evaluateQuote(policy, recorded, cased).approved, true);
  });

  it("rejects a different recipient, route, refund address, or amount", () => {
    const cases: Array<[string, QuoteExpectation]> = [
      ["recipient", { ...expected, recipient: "attacker.near" }],
      ["refund address", { ...expected, refundTo: "0x0000000000000000000000000000000000000001" }],
      ["from-asset", { ...expected, originAsset: "nep141:other.near" }],
      ["to-asset", { ...expected, destinationAsset: "nep141:other.near" }],
      ["amount", { ...expected, amount: "5000000000" }],
    ];
    for (const [label, next] of cases) {
      const decision = evaluateQuote(policy, recorded, next);
      assert.equal(decision.approved, false, label);
      expectVeto(decision.reasons, label);
    }
  });
});
