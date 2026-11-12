import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseProposal, propose } from "./brain.js";
import { envPresent, loadEnvFile, rootDir } from "./env.js";
import { evaluateProposal, evaluateQuote, loadPolicy, type QuoteExpectation } from "./gate.js";
import {
  asExecutionStatus,
  buildQuoteRequest,
  findUsdc,
  getTokens,
  interpretStatus,
  loadQuoteFixture,
  loadTokenFixture,
  requestQuote,
  usdToBaseUnits,
  type StatusRead,
} from "./intents.js";
import {
  CLICK_BLOCKCHAIN,
  LLAMA_CHAIN,
  type ChainId,
  type ExecutionStatus,
  type Policy,
  type Proposal,
  type QuoteResponse,
  type Token,
  type YieldBook,
} from "./types.js";
import { bookFromPools, fetchYieldBook, loadYieldFixture, YIELDS_URL } from "./yields.js";

const args = new Set(process.argv.slice(2));
const fixturesOnly = args.has("--fixtures");
const live = args.has("--live");
const record = args.has("--record");

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function money(amount: number): string {
  return amount.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
}

function tvl(amount: number): string {
  if (amount >= 1_000_000_000) return `$${(amount / 1_000_000_000).toFixed(2)}b`;
  if (amount >= 1_000_000) return `$${(amount / 1_000_000).toFixed(2)}m`;
  return money(amount);
}

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(`self-check failed: ${message}`);
}

function printDecision(title: string, decision: ReturnType<typeof evaluateProposal>): void {
  line(`${title}: ${decision.approved ? "APPROVE" : "VETO"}`);
  if (decision.grossSpreadBps !== null) {
    const payback =
      decision.paybackDays !== null && Number.isFinite(decision.paybackDays)
        ? `${decision.paybackDays.toFixed(1)} days`
        : "does not pay back";
    line(
      `  gross ${decision.grossSpreadBps} bps, fee ${decision.feeBps} bps, slippage in the cost, one-time ${decision.oneTimeCostBps} bps, annualized cost ${decision.annualizedCostBps} bps, net ${decision.netSpreadBps} bps, payback ${payback}`,
    );
  }
  for (const reason of decision.reasons) line(`  ${reason}`);
}

function printBook(book: YieldBook): void {
  line(`Yields (${book.source}, ${book.url}, ${book.fetchedAt})`);
  line("  decision APY is apyBase when DefiLlama has it, otherwise apy. TVL floor and venue list come from gate.policy.json.");
  for (const venue of book.candidates) {
    const meta = venue.poolMeta ? `  ${venue.poolMeta}` : "";
    line(
      `  ${venue.chain.padEnd(7)} ${venue.project.padEnd(16)} apyBase ${venue.apyBase ?? "n/a"}  apy ${venue.apy ?? "n/a"}  decision ${venue.decisionApy}  tvl ${tvl(venue.tvlUsd)}${meta}`,
    );
  }
  line("  best on each chain:");
  for (const chain of ["base", "near", "solana"] as const) {
    const venue = book.bestByChain[chain];
    line(venue ? `  ${chain.padEnd(7)} ${venue.project} at ${venue.decisionApy}%` : `  ${chain.padEnd(7)} none`);
  }
}

function printProposal(proposal: Proposal): void {
  line(
    `  ${money(proposal.amountUsd)} ${proposal.asset}  ${proposal.fromChain}/${proposal.fromProject} -> ${proposal.toChain}/${proposal.toProject}`,
  );
  line(`  ${proposal.rationale}`);
}

async function loadBook(policy: Policy): Promise<YieldBook> {
  if (fixturesOnly) return loadYieldFixture(policy);
  try {
    if (record) return await recordYields(policy);
    return await fetchYieldBook(policy);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    line(`Live yields failed (${message}). Using fixtures/yields.json.`);
    return loadYieldFixture(policy);
  }
}

async function recordYields(policy: Policy): Promise<YieldBook> {
  const response = await fetch(YIELDS_URL, { signal: AbortSignal.timeout(30_000) });
  if (!response.ok) throw new Error(`DefiLlama yields ${response.status}`);
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null || !("data" in body) || !Array.isArray(body.data)) {
    throw new Error("DefiLlama yields response has no data array");
  }
  const allowed = new Set(policy.venues.map((venue) => `${LLAMA_CHAIN[venue.chain]}:${venue.project}`));
  const pools = body.data.filter((row) => {
    if (typeof row !== "object" || row === null) return false;
    const pool = row as Record<string, unknown>;
    return (
      pool.stablecoin === true &&
      pool.symbol === "USDC" &&
      pool.exposure === "single" &&
      pool.ilRisk === "no" &&
      typeof pool.chain === "string" &&
      typeof pool.project === "string" &&
      allowed.has(`${pool.chain}:${pool.project}`)
    );
  });
  const recordedAt = new Date().toISOString();
  mkdirSync(resolve(rootDir, "fixtures"), { recursive: true });
  writeFileSync(
    resolve(rootDir, "fixtures", "yields.json"),
    JSON.stringify({ recordedAt, source: YIELDS_URL, pools }, null, 2) + "\n",
  );
  return bookFromPools(pools, policy, "live", recordedAt);
}

async function loadTokens(): Promise<{ source: "live" | "fixture"; tokens: Token[] }> {
  if (fixturesOnly) return { source: "fixture", tokens: loadTokenFixture() };
  try {
    const tokens = await getTokens();
    if (record) {
      const keep = tokens.filter(
        (token) =>
          (token.symbol === "USDC" || token.symbol === "sUSDC") &&
          (token.blockchain === "base" || token.blockchain === "near" || token.blockchain === "sol"),
      );
      writeFileSync(
        resolve(rootDir, "fixtures", "tokens.json"),
        JSON.stringify(
          { recordedAt: new Date().toISOString(), source: "https://1click.chaindefuser.com/v0/tokens", tokens: keep },
          null,
          2,
        ) + "\n",
      );
    }
    return { source: "live", tokens };
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown error";
    line(`Live tokens failed (${message}). Using fixtures/tokens.json.`);
    return { source: "fixture", tokens: loadTokenFixture() };
  }
}

function readStatusFixture(name: string): ExecutionStatus {
  const body: unknown = JSON.parse(readFileSync(resolve(rootDir, "fixtures", name), "utf8"));
  return asExecutionStatus(body);
}

function expectOutcome(read: StatusRead, outcome: StatusRead["outcome"]): void {
  check(read.outcome === outcome && read.terminal === (outcome !== "pending"), `${read.status} -> ${read.outcome}`);
}

async function main(): Promise<void> {
  loadEnvFile();
  if (!live && !fixturesOnly) {
    line("Pass --fixtures for the recorded path, or --live to read DefiLlama and request a dry quote.");
    line("Running the recorded path.");
  }
  const policy = loadPolicy();
  const useFixtures = fixturesOnly || !live;
  const hasOneClickKey = envPresent("ONECLICK_API_KEY");
  line("Sluice dry-run");
  line("The model can propose. The gate decides. This run does not sign, spend, or submit a deposit.");
  line(
    `Policy cap ${money(policy.maxMoveUsd)} ${policy.allowedAssets.join(",")} on ${policy.allowedChains.join(", ")}. Min net ${policy.minNetSpreadBps} bps. Slippage budget ${policy.slippageToleranceBps} bps. Fee assumption ${hasOneClickKey ? policy.stablecoinRouteFeeBps : policy.unauthenticatedFeeBps} bps (${hasOneClickKey ? "ONECLICK_API_KEY set, stablecoin schedule" : "no 1Click key, unauthenticated schedule"}).`,
  );
  line("");

  const book = useFixtures ? loadYieldFixture(policy) : await loadBook(policy);
  printBook(book);
  line("");

  const brain = await propose(book, policy, live && !fixturesOnly);
  line(`Brain: ${brain.source}`);
  line(`  ${brain.note}`);
  if (brain.claimedRecipient) line(`  Model named recipient ${brain.claimedRecipient}. The gate treats that as a claim.`);
  line(`  ${brain.attestation.detail}`);
  printProposal(brain.proposal);
  line("");

  const now = new Date();
  const decision = evaluateProposal(
    brain.proposal,
    book,
    policy,
    now,
    null,
    hasOneClickKey,
    brain.claimedRecipient,
  );
  printDecision("Gate", decision);
  line("");

  line("Gate probes. These are not the brain's proposal.");
  const overCap: Proposal = { ...brain.proposal, amountUsd: policy.maxMoveUsd + 40, rationale: "probe over cap" };
  const overDecision = evaluateProposal(overCap, book, policy, now, null, hasOneClickKey, null);
  printDecision("  amount over cap", overDecision);
  check(!overDecision.approved, "over-cap proposal was approved");

  const badAsset: Proposal = { ...brain.proposal, asset: "ETH", rationale: "probe asset" };
  const assetDecision = evaluateProposal(badAsset, book, policy, now, null, hasOneClickKey, null);
  printDecision("  asset ETH", assetDecision);
  check(!assetDecision.approved, "ETH proposal was approved");

  const narrowed: Policy = { ...policy, allowedChains: [policy.capitalChain] };
  const chainDecision = evaluateProposal(brain.proposal, book, narrowed, now, null, hasOneClickKey, null);
  printDecision("  destination chain removed from policy", chainDecision);
  check(!chainDecision.approved, "disallowed chain was approved");

  const oneSecondAgo = new Date(now.getTime() - 1000);
  const cooling = evaluateProposal(brain.proposal, book, policy, now, oneSecondAgo, hasOneClickKey, null);
  printDecision("  approved move one second ago", cooling);
  check(!cooling.approved, "cooldown did not veto");

  const future = new Date(now.getTime() + 60_000);
  const futureDecision = evaluateProposal(brain.proposal, book, policy, now, future, hasOneClickKey, null);
  printDecision("  last approval is one minute in the future", futureDecision);
  check(!futureDecision.approved, "future last-approval was not blocked");
  check(
    futureDecision.reasons.some((reason) => reason.includes("future")),
    "future last-approval did not say so",
  );

  const reverse: Proposal = {
    ...brain.proposal,
    fromChain: brain.proposal.toChain,
    toChain: brain.proposal.fromChain,
    fromProject: brain.proposal.toProject,
    toProject: brain.proposal.fromProject,
    rationale: "probe reverse",
  };
  const reverseDecision = evaluateProposal(reverse, book, policy, now, null, hasOneClickKey, null);
  printDecision("  reverse the move", reverseDecision);
  if ((decision.grossSpreadBps ?? 0) > 0) check(!reverseDecision.approved, "reverse move was approved");

  const forced = parseProposal({ ...brain.proposal, force: true, approved: true, skipGate: true });
  check(!("error" in forced), "probe proposal did not parse");
  if (!("error" in forced)) {
    const forcedDecision = evaluateProposal(forced, book, policy, now, null, hasOneClickKey, null);
    line(
      `  extra force/approved/skipGate fields are dropped by the parser. Gate on that object: ${forcedDecision.approved ? "APPROVE" : "VETO"}. Same economics as the brain proposal: ${forcedDecision.approved === decision.approved}.`,
    );
    check(forcedDecision.approved === decision.approved, "force flag changed the gate");
  }
  line("");

  let threw = false;
  try {
    buildQuoteRequest({
      originAsset: "nep141:example",
      destinationAsset: "nep141:example",
      amount: "1",
      recipient: "example.near",
      refundTo: "0x0000000000000000000000000000000000000000",
      slippageToleranceBps: policy.slippageToleranceBps,
      deadline: new Date(Date.now() + 60_000).toISOString(),
      dry: false,
    });
  } catch {
    threw = true;
  }
  check(threw && process.env.LIVE !== "1", "live quote was allowed without LIVE=1");
  line("1Click client refuses dry:false unless LIVE=1. LIVE is not set. No quote in this run asks for a deposit address.");
  line("");

  const tokenLoad = useFixtures ? { source: "fixture" as const, tokens: loadTokenFixture() } : await loadTokens();
  line(`Tokens (${tokenLoad.source}, GET /v0/tokens). Symbol USDC must match exactly one row per chain.`);
  const wanted: ChainId[] = ["base", "near", "solana"];
  const resolved = new Map<ChainId, Token>();
  for (const chain of wanted) {
    const token = findUsdc(tokenLoad.tokens, chain);
    resolved.set(chain, token);
    line(
      `  ${chain.padEnd(7)} ${CLICK_BLOCKCHAIN[chain].padEnd(4)} ${token.symbol}  decimals ${token.decimals}  ${token.assetId}`,
    );
  }
  const baseUsdc = resolved.get("base");
  const nearUsdc = resolved.get("near");
  check(Boolean(baseUsdc && nearUsdc), "USDC tokens missing");
  check(!tokenLoad.tokens.some((token) => token.symbol === "sUSDC" && token.assetId === baseUsdc?.assetId), "sUSDC collided with USDC");
  line("");

  if (!decision.approved) {
    line("Quote skipped. The gate vetoed the proposal, so nothing is priced for execution.");
  } else if (!baseUsdc || !nearUsdc) {
    line("Quote skipped. USDC asset ids were not resolved.");
  } else if (brain.proposal.fromChain !== "base" || brain.proposal.toChain !== "near") {
    line(
      `Quote skipped. The approved move is ${brain.proposal.fromChain} -> ${brain.proposal.toChain}. The dry quote wired in this step is Base USDC -> NEAR USDC, which is the live path. A different route is not guessed.`,
    );
  } else {
    const amount = usdToBaseUnits(brain.proposal.amountUsd, baseUsdc.decimals);
    const recipient = process.env.SLUICE_RECIPIENT?.trim() ?? "";
    const refundTo = process.env.SLUICE_REFUND_TO?.trim() ?? "";
    let quote: QuoteResponse | undefined;
    let quoteSource: "live" | "fixture" = "fixture";
    if (!useFixtures && recipient && refundTo) {
      const request = buildQuoteRequest({
        originAsset: baseUsdc.assetId,
        destinationAsset: nearUsdc.assetId,
        amount,
        recipient,
        refundTo,
        slippageToleranceBps: policy.slippageToleranceBps,
        deadline: new Date(Date.now() + policy.quoteDeadlineSeconds * 1000).toISOString(),
        dry: true,
      });
      line(`Quote POST /v0/quote dry:true amount ${amount} (base units) slippage ${policy.slippageToleranceBps} bps`);
      try {
        quote = await requestQuote(request);
        quoteSource = "live";
        if (record) {
          writeFileSync(
            resolve(rootDir, "fixtures", "quote.json"),
            JSON.stringify({ recordedAt: new Date().toISOString(), response: quote }, null, 2) + "\n",
          );
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : "unknown error";
        line(`Live dry quote failed (${message}).`);
      }
    } else if (!useFixtures) {
      line("Live dry quote skipped. Set SLUICE_RECIPIENT and SLUICE_REFUND_TO. No funds would move either way.");
    }
    if (!quote) {
      quote = loadQuoteFixture();
      quoteSource = "fixture";
      line("Quote from fixtures/quote.json. Recorded earlier with dry:true. It is not a new request.");
    }
    const quoted = quote.quote;
    line(`Quote (${quoteSource}) correlation ${quote.correlationId}`);
    line(`  amountIn ${quoted.amountInFormatted} (${quoted.amountIn} base units, ${quoted.amountInUsd} USD)`);
    line(`  amountOut ${quoted.amountOutFormatted} (${quoted.amountOutUsd} USD)`);
    line(`  minAmountOut ${quoted.minAmountOut} base units`);
    line(`  timeEstimate ${quoted.timeEstimate}s`);
    line(`  depositAddress ${quoted.depositAddress ?? "absent, as documented for dry:true"}`);
    const fees = quote.quoteRequest.appFees ?? [];
    line(`  appFees ${fees.length === 0 ? "none on the response" : fees.map((fee) => `${fee.fee} bps`).join(", ")}`);
    const expected: QuoteExpectation = {
      originAsset: baseUsdc.assetId,
      destinationAsset: nearUsdc.assetId,
      amount,
      recipient: quoteSource === "live" ? recipient : quote.quoteRequest.recipient,
      refundTo: quoteSource === "live" ? refundTo : quote.quoteRequest.refundTo,
    };
    const quoteDecision = evaluateQuote(policy, quote, expected);
    printDecision("Quote gate", quoteDecision);
    check(!quoted.depositAddress, "dry quote included a deposit address");
    const mismatched = quoteDecision.reasons.some(
      (reason) => reason.includes("does not match") || reason.includes("is empty") || reason.includes("is missing"),
    );
    check(!mismatched, `quote does not match the approved proposal: ${quoteDecision.reasons.join("; ")}`);
    if (quoteSource === "fixture") check(quoteDecision.approved, "recorded quote was not approved");
  }
  line("");

  const probeBase = resolved.get("base");
  const probeNear = resolved.get("near");
  if (probeBase && probeNear) {
    line("Quote match probes. A quote for another route, recipient, refund address, or amount must veto.");
    const recorded = loadQuoteFixture();
    const approved: QuoteExpectation = {
      originAsset: recorded.quoteRequest.originAsset,
      destinationAsset: recorded.quoteRequest.destinationAsset,
      amount: recorded.quoteRequest.amount,
      recipient: recorded.quoteRequest.recipient,
      refundTo: recorded.quoteRequest.refundTo,
    };
    check(evaluateQuote(policy, recorded, approved).approved, "recorded quote did not match its own request");
    const cases: Array<[string, (copy: QuoteResponse) => void]> = [
      ["recipient", (copy) => { copy.quoteRequest.recipient = "attacker.near"; }],
      ["refund address", (copy) => { copy.quoteRequest.refundTo = "0x0000000000000000000000000000000000000001"; }],
      ["from-asset", (copy) => { copy.quoteRequest.originAsset = "nep141:not-the-approved-asset.near"; }],
      ["to-asset", (copy) => { copy.quoteRequest.destinationAsset = "nep141:not-the-approved-asset.near"; }],
      ["amount", (copy) => { copy.quoteRequest.amount = "5000000000"; copy.quote.amountIn = "5000000000"; }],
    ];
    for (const [label, edit] of cases) {
      const copy = structuredClone(recorded);
      edit(copy);
      const verdict = evaluateQuote(policy, copy, approved);
      printDecision(`  quote ${label} swapped`, verdict);
      check(!verdict.approved, `swapped ${label} was approved`);
    }
    line("");
  }

  line("Status handling uses recorded fixtures. There is no deposit address to poll.");
  const samples: Array<[string, StatusRead["outcome"]]> = [
    ["status-pending.json", "pending"],
    ["status-success.json", "settled"],
    ["status-refunded.json", "refunded"],
    ["status-failed.json", "failed"],
    ["status-incomplete.json", "incomplete"],
  ];
  for (const [name, outcome] of samples) {
    const read = interpretStatus(readStatusFixture(name));
    expectOutcome(read, outcome);
    line(`  ${name}: ${read.status} -> ${read.outcome}. ${read.summary}`);
  }
  line("");
  line("Dry-run finished. No transaction was signed or broadcast.");
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : "unknown error";
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
