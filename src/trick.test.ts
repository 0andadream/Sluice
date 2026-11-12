import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { INJECTED } from "./attack-demo.js";
import { assessAttack } from "./attack-demo.js";
import { handleTrick, listPresets, resetTrickLimits, runTrick, TEXT_MAX, type TrickSuccess } from "./trick.js";

const now = new Date("2026-11-12T17:00:00.000Z");

function isSuccess(body: unknown): body is TrickSuccess {
  return typeof body === "object" && body !== null && "ok" in body && body.ok === true && "offChain" in body;
}

function decisionBytes(decision: unknown): number[] {
  return [...Buffer.from(JSON.stringify(decision))];
}

function rpcResponse(decision: unknown, encoding: "bytes" | "base64" = "bytes"): Response {
  const encoded = Buffer.from(JSON.stringify(decision));
  const result = encoding === "base64" ? encoded.toString("base64") : [...encoded];
  return new Response(
    JSON.stringify({ jsonrpc: "2.0", id: "sluice-preview", result: { result, logs: [] } }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

function veto(reasons: string[]): Response {
  return rpcResponse({
    approved: false,
    reasons,
    gross_spread_bps: 498,
    net_spread_bps: 428,
  });
}

type Call = { url: string; init: RequestInit | undefined };

function mockFetch(handler: (call: Call, index: number) => Response | Promise<Response>): {
  fetch: typeof fetch;
  calls: Call[];
} {
  const calls: Call[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const call = { url, init };
    calls.push(call);
    return handler(call, calls.length - 1);
  };
  return { fetch: fetchImpl, calls };
}

function proposalArgs(call: Call): { proposal: Record<string, unknown> } {
  assert.equal(typeof call.init?.body, "string");
  const body = JSON.parse(String(call.init?.body)) as {
    method?: string;
    params?: { method_name?: string; account_id?: string; request_type?: string; args_base64?: string };
  };
  assert.equal(body.method, "query");
  assert.equal(body.params?.request_type, "call_function");
  assert.equal(body.params?.method_name, "preview");
  assert.equal(body.params?.account_id, "sluice-gate-df46.testnet");
  assert.equal(typeof body.params?.args_base64, "string");
  return JSON.parse(Buffer.from(body.params?.args_base64 ?? "", "base64").toString("utf8")) as {
    proposal: Record<string, unknown>;
  };
}

afterEach(() => {
  resetTrickLimits();
});

describe("trick presets and the parser", () => {
  it("keeps the recorded attack in the cap preset", () => {
    const preset = listPresets().find((item) => item.id === "cap-attacker");
    assert.ok(preset);
    assert.equal(preset.move.amountUsd, INJECTED.amountUsd);
    assert.equal(preset.move.recipient, INJECTED.recipient);
    assert.match(preset.text, /skipGate/);
    assert.match(preset.text, /force/);
  });

  it("drops force, approved, and skipGate and vetoes the $5,000 attack", async () => {
    const rpc = mockFetch(() =>
      veto([
        "amount_usd_cents 500000 exceeds max_move_usd_cents 1000",
        "recipient attacker.near is not an allowed recipient",
      ]),
    );
    const result = await runTrick({ preset: "cap-attacker" }, { now, fetch: rpc.fetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.signed, false);
    assert.equal(result.broadcast, false);
    assert.equal(result.network, "testnet");
    assert.equal(result.parser.ok, true);
    if (result.parser.ok) {
      assert.equal(result.parser.proposal.amountUsd, 5000);
      assert.equal("force" in result.parser.proposal, false);
      assert.equal("rationale" in result.parser.proposal, false);
    }
    assert.deepEqual(result.droppedFlags, ["force", "approved", "skipGate"]);
    assert.equal(result.claimedRecipient, "attacker.near");
    assert.equal(result.offChain.approved, false);
    assert.ok(result.offChain.reasons.some((reason) => reason.includes("amountUsd 5000 exceeds maxMoveUsd 10")));
    assert.ok(result.offChain.reasons.some((reason) => reason.includes("attacker.near")));
    assert.equal(result.contract.available, true);
    if (result.contract.available) {
      assert.equal(result.contract.approved, false);
      assert.equal(result.contract.method, "preview");
      assert.match(result.contract.reasons.join(" "), /500000/);
    }
    assert.match(result.share, /I tried to make Sluice send \$5,000 to attacker\.near\. It said no\./);
    assert.equal(rpc.calls.length, 1);
    const call = rpc.calls[0];
    assert.ok(call);
    assert.equal(new URL(call.url).hostname, "rpc.testnet.near.org");
    const args = proposalArgs(call);
    assert.deepEqual(args.proposal, assessAttack(now).contractArgs);
    assert.equal(JSON.stringify(args).includes("mainnet"), false);
  });

  it("reads a prompt-injection reply wrapped around JSON", async () => {
    const preset = listPresets().find((item) => item.id === "prompt-injection");
    assert.ok(preset);
    const rpc = mockFetch(() => veto(["amount_usd_cents 500000 exceeds max_move_usd_cents 1000"]));
    const result = await runTrick({ text: preset.text }, { now, fetch: rpc.fetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.parser.ok, true);
    assert.deepEqual(result.droppedFlags, ["force", "approved", "skipGate"]);
    assert.equal(result.offChain.approved, false);
    assert.match(result.share, /\$5,000 to attacker\.near/);
    assert.match(result.note ?? "", /dropped by the parser/);
  });

  it("accepts a fenced reply and a wrapped proposal", async () => {
    const rpc = mockFetch(() => rpcResponse({ approved: true, reasons: [], gross_spread_bps: 498, net_spread_bps: 428 }));
    const text = [
      "```json",
      JSON.stringify({
        proposal: {
          fromChain: "base",
          toChain: "near",
          asset: "USDC",
          amountUsd: "10",
          fromProject: "fluid-lending",
          toProject: "rhea-lend",
          rationale: "wrapped",
          force: true,
        },
      }),
      "```",
    ].join("\n");
    const result = await runTrick({ text }, { now, fetch: rpc.fetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.parser.ok, true);
    if (result.parser.ok) assert.equal(result.parser.proposal.amountUsd, 10);
    assert.deepEqual(result.droppedFlags, ["force"]);
    assert.equal(result.offChain.approved, true);
    assert.match(result.share, /Both checks said yes/);
  });

  it("lets the move form replace the reply", async () => {
    const rpc = mockFetch(() => veto(["amount_usd_cents 500000 exceeds max_move_usd_cents 1000"]));
    const result = await runTrick(
      {
        text: JSON.stringify({
          fromChain: "base",
          toChain: "near",
          asset: "USDC",
          amountUsd: 10,
          fromProject: "fluid-lending",
          toProject: "rhea-lend",
          rationale: "ten dollars",
          skipGate: true,
        }),
        move: { amountUsd: 5000, recipient: "attacker.near" },
      },
      { now, fetch: rpc.fetch },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    if (result.parser.ok) assert.equal(result.parser.proposal.amountUsd, 5000);
    assert.equal(result.claimedRecipient, "attacker.near");
    assert.equal(result.offChain.approved, false);
    assert.ok(result.offChain.reasons.some((reason) => reason.includes("5000")));
    const call = rpc.calls[0];
    assert.ok(call);
    assert.equal(proposalArgs(call).proposal.amount_usd_cents, 500000);
    assert.equal(proposalArgs(call).proposal.recipient, "attacker.near");
  });
});

describe("trick gate paths", () => {
  it("vetoes ETH before it can be treated as USDC", async () => {
    const rpc = mockFetch(() =>
      rpcResponse({ approved: false, reasons: ["asset ETH is not in allowedAssets"], gross_spread_bps: 498, net_spread_bps: 428 }),
    );
    const result = await runTrick({ preset: "eth-asset" }, { now, fetch: rpc.fetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.offChain.approved, false);
    assert.ok(result.offChain.reasons.some((reason) => reason.includes("asset ETH is not in allowedAssets")));
    assert.match(result.share, /\$10 of ETH/);
    assert.match(result.share, /It said no/);
    const call = rpc.calls[0];
    assert.ok(call);
    assert.equal(proposalArgs(call).proposal.asset, "ETH");
    assert.equal(proposalArgs(call).proposal.amount_usd_cents, 1000);
  });

  it("stops an unlisted chain at the parser and still asks the contract", async () => {
    const rpc = mockFetch(() =>
      veto(["toChain ethereum is not allowed", "toProject uniswap is not an allowed venue"]),
    );
    const result = await runTrick({ preset: "unlisted-chain" }, { now, fetch: rpc.fetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.parser.ok, false);
    if (!result.parser.ok) assert.match(result.parser.error, /not a known chain/);
    assert.equal(result.offChain.evaluated, false);
    assert.equal(result.offChain.approved, null);
    assert.equal(result.contract.available, true);
    if (result.contract.available) assert.match(result.contract.reasons.join(" "), /ethereum/);
    const call = rpc.calls[0];
    assert.ok(call);
    const proposal = proposalArgs(call).proposal;
    assert.equal(proposal.to_chain, "ethereum");
    assert.equal(proposal.dest_apy_ppm, 0);
    assert.match(result.share, /\$10 on ethereum/);
    assert.match(result.share, /It said no/);
  });

  it("simulates the cooldown off chain and does not ask the contract to store one", async () => {
    const rpc = mockFetch(() =>
      rpcResponse({
        approved: false,
        reasons: ["spread is not positive, so the fee and slippage are not earned back"],
        gross_spread_bps: -498,
        net_spread_bps: -568,
      }),
    );
    const result = await runTrick({ preset: "reverse-cooldown" }, { now, fetch: rpc.fetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.simulateCooldown, true);
    assert.equal(result.offChain.approved, false);
    assert.ok(result.offChain.reasons.some((reason) => reason.includes("cooldown")));
    assert.ok(result.offChain.reasons.some((reason) => reason.includes("spread is not positive")));
    assert.match(result.note ?? "", /60 seconds ago/);
    assert.match(result.note ?? "", /does not approve/);
    const call = rpc.calls[0];
    assert.ok(call);
    const proposal = proposalArgs(call).proposal;
    assert.equal(proposal.from_chain, "near");
    assert.equal(proposal.to_chain, "base");
    assert.equal(proposal.from_project, "rhea-lend");
    assert.equal(proposal.to_project, "fluid-lending");
    assert.equal(JSON.stringify(proposal).includes("cooldown"), false);
  });

  it("approves the $10 USDC move when both checks agree", async () => {
    const rpc = mockFetch(() =>
      rpcResponse({ approved: true, reasons: [], gross_spread_bps: 498, net_spread_bps: 428 }),
    );
    const result = await runTrick({ preset: "allowed-move" }, { now, fetch: rpc.fetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.offChain.approved, true);
    assert.equal(result.offChain.reasons.length, 0);
    assert.equal(result.offChain.grossSpreadBps, 498);
    assert.equal(result.offChain.netSpreadBps, 428);
    assert.equal(result.contract.available, true);
    if (result.contract.available) assert.equal(result.contract.approved, true);
    assert.match(result.share, /I tried to make Sluice send \$10\. Both checks said yes\./);
    assert.equal(result.droppedFlags.length, 0);
  });

  it("ignores flags on a move the policy already allows", async () => {
    const rpc = mockFetch(() => rpcResponse({ approved: true, reasons: [], gross_spread_bps: 498, net_spread_bps: 428 }));
    const preset = listPresets().find((item) => item.id === "allowed-move");
    assert.ok(preset);
    const result = await runTrick(
      {
        text: JSON.stringify({ ...preset.move, force: true, approved: true, skipGate: true }),
      },
      { now, fetch: rpc.fetch },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.offChain.approved, true);
    assert.deepEqual(result.droppedFlags, ["force", "approved", "skipGate"]);
    assert.match(result.note ?? "", /did not decide the move/);
  });
});

describe("trick RPC failures", () => {
  it("keeps the off-chain veto when the RPC is unreachable", async () => {
    const rpc = mockFetch(() => {
      throw new Error("network down");
    });
    const result = await runTrick(
      { preset: "cap-attacker", rpcUrl: "https://rpc.mainnet.near.org", method_name: "approve", account_id: "sluice.near" },
      { now, fetch: rpc.fetch },
    );
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.offChain.approved, false);
    assert.equal(result.contract.available, false);
    if (!result.contract.available) assert.match(result.contract.error, /contract check was unavailable/);
    assert.match(result.note ?? "", /contract check was unavailable/);
    assert.match(result.share, /It said no/);
    assert.deepEqual(
      rpc.calls.map((call) => new URL(call.url).hostname),
      ["rpc.testnet.near.org", "test.rpc.fastnear.com"],
    );
    for (const call of rpc.calls) {
      assert.equal(call.url.includes("mainnet"), false);
      assert.equal(proposalArgs(call).proposal.recipient, "attacker.near");
    }
  });

  it("uses the fallback testnet RPC and accepts a base64 result", async () => {
    const rpc = mockFetch((_call, index) => {
      if (index === 0) return new Response("nope", { status: 500 });
      return rpcResponse(
        { approved: false, reasons: ["asset ETH is not in allowedAssets"], gross_spread_bps: 498, net_spread_bps: 428 },
        "base64",
      );
    });
    const result = await runTrick({ preset: "eth-asset" }, { now, fetch: rpc.fetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.contract.available, true);
    if (result.contract.available) assert.match(result.contract.reasons.join(" "), /ETH/);
    assert.deepEqual(
      rpc.calls.map((call) => new URL(call.url).hostname),
      ["rpc.testnet.near.org", "test.rpc.fastnear.com"],
    );
  });

  it("says the contract was unavailable when the off-chain gate would approve", async () => {
    const rpc = mockFetch(async () => new Response(JSON.stringify({ error: { message: "down" } }), { status: 200 }));
    const result = await runTrick({ preset: "allowed-move" }, { now, fetch: rpc.fetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.offChain.approved, true);
    assert.equal(result.contract.available, false);
    assert.match(result.share, /The off-chain gate said yes\. The contract check was unavailable\./);
  });

  it("records a disagreement without hiding either verdict", async () => {
    const rpc = mockFetch(() => rpcResponse({ approved: true, reasons: [], gross_spread_bps: 498, net_spread_bps: 428 }));
    const result = await runTrick({ preset: "eth-asset" }, { now, fetch: rpc.fetch });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.offChain.approved, false);
    assert.equal(result.contract.available, true);
    if (result.contract.available) assert.equal(result.contract.approved, true);
    assert.match(result.note ?? "", /do not agree/);
    assert.match(result.share, /It said no/);
  });
});

describe("trick HTTP limits", () => {
  it("lists presets and the testnet contract without calling an RPC", async () => {
    const rpc = mockFetch(() => {
      throw new Error("GET must not call RPC");
    });
    const response = await handleTrick({ method: "GET", fetch: rpc.fetch });
    assert.equal(response.status, 200);
    assert.equal(isSuccess(response.body), false);
    const body = response.body as { ok: boolean; contractId: string; network: string; presets: { id: string }[]; maxMoveUsd: number };
    assert.equal(body.ok, true);
    assert.equal(body.network, "testnet");
    assert.equal(body.contractId, "sluice-gate-df46.testnet");
    assert.equal(body.maxMoveUsd, 10);
    assert.deepEqual(
      body.presets.map((preset) => preset.id),
      ["cap-attacker", "unlisted-chain", "eth-asset", "reverse-cooldown", "prompt-injection", "allowed-move"],
    );
    assert.equal(rpc.calls.length, 0);
  });

  it("rejects a missing body, an unknown preset, a long reply, and a huge field", async () => {
    const rpc = mockFetch(() => {
      throw new Error("should not call");
    });
    const empty = await handleTrick({ method: "POST", rawBody: "{}", ip: "empty", fetch: rpc.fetch });
    assert.equal(empty.status, 400);
    const unknown = await handleTrick({
      method: "POST",
      rawBody: JSON.stringify({ preset: "nope" }),
      ip: "unknown-preset",
      fetch: rpc.fetch,
    });
    assert.equal(unknown.status, 400);
    const longText = await handleTrick({
      method: "POST",
      rawBody: JSON.stringify({ text: "x".repeat(TEXT_MAX + 1) }),
      ip: "long-text",
      fetch: rpc.fetch,
    });
    assert.equal(longText.status, 400);
    const longField = await runTrick({ move: { recipient: "a".repeat(161), amountUsd: 10 } }, { fetch: rpc.fetch });
    assert.equal(longField.ok, false);
    const huge = await handleTrick({
      method: "POST",
      rawBody: "x".repeat(12_001),
      ip: "huge",
      fetch: rpc.fetch,
    });
    assert.equal(huge.status, 413);
    const badMethod = await handleTrick({ method: "PUT", ip: "put", fetch: rpc.fetch });
    assert.equal(badMethod.status, 405);
    assert.equal(rpc.calls.length, 0);
  });

  it("rate limits a single address", async () => {
    const rpc = mockFetch(() => veto(["amount_usd_cents 500000 exceeds max_move_usd_cents 1000"]));
    const body = JSON.stringify({ preset: "cap-attacker" });
    let last = 0;
    for (let i = 0; i < 30; i++) {
      const response = await handleTrick({ method: "POST", rawBody: body, ip: "203.0.113.9", now, fetch: rpc.fetch });
      last = response.status;
    }
    assert.equal(last, 200);
    const blocked = await handleTrick({ method: "POST", rawBody: body, ip: "203.0.113.9", now, fetch: rpc.fetch });
    assert.equal(blocked.status, 429);
    const other = await handleTrick({ method: "POST", rawBody: body, ip: "203.0.113.10", now, fetch: rpc.fetch });
    assert.equal(other.status, 200);
  });

  it("runs a preset through the HTTP handler", async () => {
    const rpc = mockFetch(() => veto(["recipient attacker.near is not an allowed recipient"]));
    const response = await handleTrick({
      method: "post",
      rawBody: JSON.stringify({ preset: "cap-attacker" }),
      ip: "handler",
      now,
      fetch: rpc.fetch,
    });
    assert.equal(response.status, 200);
    assert.equal(isSuccess(response.body), true);
    if (!isSuccess(response.body)) return;
    assert.equal(response.body.offChain.approved, false);
    assert.equal(response.body.signed, false);
    assert.equal(response.body.broadcast, false);
  });
});
