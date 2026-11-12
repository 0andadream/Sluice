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
  it("stays on the deterministic proposer when no NEAR AI key is set", async () => {
    let calls = 0;
    const result = await propose(book, policy, true, {
      env: {},
      fetchImpl: async () => {
        calls += 1;
        throw new Error("no key, no fetch");
      },
    });
    assert.equal(result.source, "fallback");
    assert.equal(result.proposer, "fallback");
    assert.equal(result.model, null);
    assert.equal(result.claimedRecipient, null);
    assert.equal(result.attestation.verified, false);
    assert.match(result.note, /not set/);
    assert.match(result.attestation.detail, /not set/);
    assert.deepEqual(result.proposal, rulesProposal(book, policy));
    assert.equal(calls, 0);
  });

  it("asks NEAR AI for a JSON proposal and still leaves the gate in charge", async () => {
    const calls: { url: string; authorization: string; model?: string }[] = [];
    const proposal = {
      fromChain: "base",
      toChain: "near",
      asset: "USDC",
      amountUsd: 10,
      fromProject: "fluid-lending",
      toProject: "rhea-lend",
      rationale: "the spread is on NEAR",
      recipient: "attacker.near",
      force: true,
    };
    const result = await propose(book, policy, true, {
      env: { NEAR_AI_API_KEY: "test-key" },
      fetchImpl: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        const headers = new Headers(init?.headers);
        const sent = init?.body ? (JSON.parse(String(init.body)) as { model?: string }) : {};
        calls.push({ url, authorization: headers.get("authorization") ?? "", model: sent.model });
        if (url.endsWith("/chat/completions")) {
          return new Response(
            JSON.stringify({
              id: "chatcmpl-test",
              choices: [{ message: { content: JSON.stringify(proposal) } }],
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        if (url.includes("/attestation/report")) {
          return new Response(
            JSON.stringify({ gateway_attestation: { intel_quote: "abcd", signing_algo: "ecdsa" } }),
            { status: 200 },
          );
        }
        if (url.includes("/signature/")) return new Response("{}", { status: 200 });
        return new Response("missing", { status: 404 });
      },
    });
    assert.equal(result.source, "near-ai");
    assert.equal(result.model, "z-ai/glm-5.3-flash");
    assert.equal(result.proposer, "NEAR AI z-ai/glm-5.3-flash");
    assert.equal(result.claimedRecipient, "attacker.near");
    assert.equal(result.attestation.verified, false);
    assert.match(result.attestation.detail, /Intel quote/);
    assert.match(result.attestation.detail, /would not approve/);
    assert.match(result.note, /gate still decides/);
    assert.equal(result.proposal.amountUsd, 10);
    assert.equal("force" in result.proposal, false);
    assert.equal(result.proposal.asset, "USDC");
    assert.equal(calls[0]?.url, "https://cloud-api.near.ai/v1/chat/completions");
    assert.equal(calls[0]?.authorization, "Bearer test-key");
    assert.equal(calls[0]?.model, "z-ai/glm-5.3-flash");
    assert.ok(calls.some((call) => call.url.includes("/attestation/report")));
    assert.ok(calls.some((call) => call.url.includes("/signature/chatcmpl-test")));
  });

  it("falls back when the model call fails or the reply is not a proposal", async () => {
    const failed = await propose(book, policy, true, {
      env: { NEAR_AI_API_KEY: "test-key" },
      fetchImpl: async () => new Response("nope", { status: 500 }),
    });
    assert.equal(failed.source, "fallback");
    assert.equal(failed.proposer, "fallback");
    assert.match(failed.note, /Fell back to the deterministic proposer/);
    assert.deepEqual(failed.proposal, rulesProposal(book, policy));

    const junk = await propose(book, policy, true, {
      env: { NEAR_AI_API_KEY: "test-key" },
      fetchImpl: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
        if (url.endsWith("/chat/completions")) {
          return new Response(JSON.stringify({ id: "chatcmpl-3", choices: [{ message: { content: "not json" } }] }), { status: 200 });
        }
        return new Response("{}", { status: 200 });
      },
    });
    assert.equal(junk.source, "fallback");
    assert.match(junk.note, /not JSON/);
    assert.equal(junk.attestation.verified, false);
  });
});
