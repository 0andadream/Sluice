import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { claimedRecipient, parseProposal, propose, rulesProposal } from "./brain.js";
import { loadPolicy } from "./gate.js";
import { loadYieldFixture } from "./yields.js";

const policy = loadPolicy();
const book = loadYieldFixture(policy);

describe("parseProposal", () => {
  const valid = {
    fromChain: "base",
    toChain: "near",
    asset: "USDC",
    amountUsd: 10,
    fromProject: "fluid-lending",
    toProject: "rhea-lend",
    rationale: "because the spread is there",
  };

  it("keeps the seven proposal fields and drops force, approved, and skipGate", () => {
    const parsed = parseProposal({ ...valid, force: true, approved: true, skipGate: true, recipient: "attacker.near" });
    assert.ok(!("error" in parsed));
    if ("error" in parsed) return;
    assert.deepEqual(parsed, valid);
    assert.equal("force" in parsed, false);
    assert.equal(claimedRecipient({ ...valid, recipient: " attacker.near " }), "attacker.near");
  });

  it("accepts a numeric string amount and a wrapped proposal", () => {
    const parsed = parseProposal({ proposal: { ...valid, amountUsd: "10" } });
    assert.ok(!("error" in parsed));
    if (!("error" in parsed)) assert.equal(parsed.amountUsd, 10);
  });

  it("rejects a missing rationale and an unknown chain", () => {
    assert.equal("error" in parseProposal({ ...valid, rationale: "  " }), true);
    assert.equal("error" in parseProposal({ ...valid, toChain: "ethereum" }), true);
  });

  it("truncates a long rationale", () => {
    const parsed = parseProposal({ ...valid, rationale: "x".repeat(800) });
    assert.ok(!("error" in parsed));
    if (!("error" in parsed)) assert.equal(parsed.rationale.length, 500);
  });
});

describe("propose", () => {
  it("stays on the rules proposal when no NEAR AI key is set", async () => {
    const previous = process.env.NEAR_AI_API_KEY;
    delete process.env.NEAR_AI_API_KEY;
    try {
      const result = await propose(book, policy, true);
      assert.equal(result.source, "rules");
      assert.equal(result.claimedRecipient, null);
      assert.equal(result.attestation.verified, false);
      assert.match(result.attestation.detail, /not set/);
      assert.deepEqual(result.proposal, rulesProposal(book, policy));
    } finally {
      if (previous === undefined) delete process.env.NEAR_AI_API_KEY;
      else process.env.NEAR_AI_API_KEY = previous;
    }
  });
});
