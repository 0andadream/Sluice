import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, it } from "node:test";
import { resolve } from "node:path";
import { rootDir } from "./env.js";
import { loadPolicy } from "./gate.js";
import {
  STATE_CACHE_MS,
  STATE_FETCH_TIMEOUT_MS,
  buildPublicState,
  clearControlBookCache,
  fixtureFeedLine,
  loadDeployment,
  parseDeployment,
} from "./snapshot.js";

const JUNK = "JUNK_POOL_SHOULD_NOT_LEAK";

function usdc(chain: string, project: string, apyBase: number, pool: string) {
  return {
    chain,
    project,
    symbol: "USDC",
    tvlUsd: 5_000_000,
    apyBase,
    apy: apyBase,
    apyReward: null,
    pool,
    stablecoin: true,
    ilRisk: "no",
    exposure: "single",
    poolMeta: null,
  };
}

function llama(pools: unknown[]): Response {
  return new Response(JSON.stringify({ data: pools }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

const livePools = [
  usdc("Base", "fluid-lending", 5, "fluid-live"),
  usdc("Near", "rhea-lend", 20, "rhea-live"),
  usdc("Solana", "save", 4, "save-live"),
  {
    chain: "Ethereum",
    project: "aave-v3",
    symbol: "WETH",
    stablecoin: false,
    ilRisk: "yes",
    exposure: "multi",
    pool: "junk",
    tvlUsd: 9_000_000_000,
    apyBase: 80,
    blob: `${JUNK}${"z".repeat(4000)}`,
  },
];

afterEach(() => {
  clearControlBookCache();
});

describe("control yield feed", { concurrency: 1 }, () => {
  it("evaluates the live book and drops pools that are not candidates", async () => {
    clearControlBookCache();
    let calls = 0;
    const fetchImpl: typeof fetch = async (input, init) => {
      calls += 1;
      assert.equal(String(input), "https://yields.llama.fi/pools");
      assert.ok(init?.signal);
      return llama(livePools);
    };
    const state = await buildPublicState(new Date(), { fetchImpl });
    assert.equal(state.feed, "live");
    assert.equal(state.book.source, "live");
    assert.match(state.feedLine, /^Live, updated \d+s ago$/);
    assert.equal(state.decision.grossSpreadBps, 1500);
    assert.equal(state.decision.approved, true);
    assert.equal(state.proposal.fromProject, "fluid-lending");
    assert.equal(state.proposal.toProject, "rhea-lend");
    assert.equal(state.proposal.amountUsd, 10);
    const projects = state.book.candidates.map((venue) => venue.project);
    assert.deepEqual(projects.sort(), ["fluid-lending", "rhea-lend", "save"]);
    assert.equal(JSON.stringify(state.book).includes(JUNK), false);
    assert.equal(JSON.stringify(state).includes("z".repeat(200)), false);
    assert.ok(calls >= 1);

    const again = await buildPublicState(new Date(), {
      fetchImpl: async () => {
        throw new Error("cache should have answered");
      },
    });
    assert.equal(again.feed, "live");
    assert.equal(again.decision.grossSpreadBps, 1500);
    assert.equal(calls, 1);
  });

  it("refetches after the cache window", async () => {
    clearControlBookCache();
    let calls = 0;
    const fetchImpl: typeof fetch = async () => {
      calls += 1;
      return llama([usdc("Base", "fluid-lending", 5, "fluid"), usdc("Near", "rhea-lend", 12, "rhea")]);
    };
    const start = new Date("2026-11-12T12:00:00.000Z");
    await buildPublicState(start, { fetchImpl, cacheMs: STATE_CACHE_MS });
    await buildPublicState(new Date(start.getTime() + STATE_CACHE_MS - 1), { fetchImpl });
    await buildPublicState(new Date(start.getTime() + STATE_CACHE_MS + 1), { fetchImpl });
    assert.equal(calls, 2);
  });

  it("labels the saved snapshot when the live feed fails", async () => {
    clearControlBookCache();
    const fetchImpl: typeof fetch = async () => {
      throw new Error("llama down");
    };
    const state = await buildPublicState(new Date("2026-11-12T18:00:00.000Z"), { fetchImpl, env: {} });
    assert.equal(state.feed, "fixture");
    assert.equal(state.book.source, "fixture");
    assert.equal(state.feedLine, fixtureFeedLine(state.fetchedAt));
    assert.equal(state.feedLine, "Live feed unavailable, showing saved snapshot from 2026-11-10");
    assert.equal(state.decision.grossSpreadBps, 498);
    assert.equal(state.proposer, "fallback");
    assert.equal(state.brainSource, "fallback");
    assert.equal(state.model, null);
  });

  it("stops waiting when the live read exceeds the timeout", async () => {
    clearControlBookCache();
    assert.equal(STATE_FETCH_TIMEOUT_MS, 4_000);
    const started = Date.now();
    let aborted = false;
    const fetchImpl: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        const signal = init?.signal;
        const giveUp = setTimeout(() => {
          aborted = signal?.aborted === true;
          reject(new Error(aborted ? "aborted" : "timed out without abort"));
        }, 250);
        signal?.addEventListener(
          "abort",
          () => {
            clearTimeout(giveUp);
            aborted = true;
            reject(new Error("aborted"));
          },
          { once: true },
        );
      });
    const state = await buildPublicState(new Date(), { fetchImpl, timeoutMs: 40 });
    assert.equal(aborted, true);
    assert.equal(state.feed, "fixture");
    assert.match(state.feedLine, /Live feed unavailable, showing saved snapshot from 2026-11-10/);
    assert.ok(Date.now() - started < 2_000);
  });

  it("reads the deployed gate, including the file the state function bundles", async () => {
    const source = readFileSync(resolve(rootDir, "api", "state.js"), "utf8");
    assert.match(source, /contracts\/sluice-gate\/deployed\.json/);
    assert.match(source, /parseDeployment\(deployed\)/);
    const raw = JSON.parse(readFileSync(resolve(rootDir, "contracts", "sluice-gate", "deployed.json"), "utf8")) as {
      contractId: string;
      explorerAccount: string;
      deployTx: string;
      attackVetoTx: string;
    };
    const parsed = parseDeployment(raw);
    assert.ok(parsed);
    assert.equal(parsed.contractId, "sluice-0andadream.testnet");
    assert.equal(parsed.explorerAccount, "https://testnet.nearblocks.io/address/sluice-0andadream.testnet");
    assert.equal(parsed.deployTx, raw.deployTx);
    assert.equal(parsed.attackVetoTx, raw.attackVetoTx);
    assert.equal(loadDeployment()?.contractId, parsed.contractId);
    assert.equal(parseDeployment({ contractId: "not a near account", network: "testnet" }), null);

    clearControlBookCache();
    const state = await buildPublicState(new Date("2026-11-12T18:00:00.000Z"), {
      fetchImpl: async () => {
        throw new Error("llama down");
      },
      env: {},
      deployment: parsed,
      includePreview: true,
      preview: async (args) => {
        assert.equal(args.recipient, "");
        assert.ok(args.amount_usd_cents > 0);
        return {
          available: true,
          approved: false,
          reasons: ["amount_usd_cents 500000 exceeds max_move_usd_cents 1000"],
          grossSpreadBps: 498,
          netSpreadBps: 428,
          contractId: parsed.contractId,
          network: "testnet",
          method: "preview",
        };
      },
    });
    assert.equal(state.gate?.contractId, "sluice-0andadream.testnet");
    assert.equal(state.gate?.deployTx, raw.deployTx);
    assert.equal(state.preview?.available, true);
    if (state.preview?.available) {
      assert.equal(state.preview.approved, false);
      assert.match(state.preview.reasons.join(" "), /500000/);
    }
  });
});
