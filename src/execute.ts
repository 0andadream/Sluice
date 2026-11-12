import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { propose } from "./brain.js";
import { loadEnvFile, rootDir } from "./env.js";
import { evaluateProposal, evaluateQuote, loadPolicy, type QuoteExpectation } from "./gate.js";
import { apyToPpm } from "./policy-math.js";
import {
  asExecutionStatus,
  buildQuoteRequest,
  findUsdc,
  getTokens,
  interpretStatus,
  loadQuoteFixture,
  requestQuote,
  usdToBaseUnits,
} from "./intents.js";
import { statusExplorerLinks, type ExplorerLink, baseTxUrl } from "./links.js";
import {
  assertArmed,
  DEFAULT_DERIVATION_PATH,
  liveArmed,
  mpcContractId,
  mpcSignRequest,
  SIGN_DEPOSIT_YOCTO,
  usdcDepositCall,
} from "./signer.js";
import type { ExecutionStatus, Policy, QuoteResponse } from "./types.js";
import { loadYieldFixture } from "./yields.js";

export type OnchainApproval = {
  source: "onchain";
  approved: boolean;
  id: string;
  txHash?: string;
  explorerUrl?: string;
};

export type MoveResult = {
  released: boolean;
  stoppedAt: "onchain-gate" | "live-switch" | "quote-gate" | "status";
  detail: string;
  outcome?: string;
  txHash?: string;
  links: ExplorerLink[];
};

export type MoveIO = {
  armed: boolean;
  approval: OnchainApproval | null;
  policy: Policy;
  expected: QuoteExpectation;
  requestQuote: () => Promise<QuoteResponse>;
  signAndBroadcast: (quote: QuoteResponse) => Promise<{ hash: string; explorerUrl: string }>;
  notifyDeposit: (hash: string, quote: QuoteResponse) => Promise<void>;
  poll: (quote: QuoteResponse) => Promise<{ outcome: string; summary: string; links: ExplorerLink[] }>;
};

/**
 * Funds move only after an on-chain approval and only when the live switches
 * are on. A quote mismatch never reaches the signer.
 */
export async function runLiveMove(io: MoveIO): Promise<MoveResult> {
  if (!io.approval || io.approval.source !== "onchain" || !io.approval.approved || !io.approval.id) {
    return {
      released: false,
      stoppedAt: "onchain-gate",
      detail: "The on-chain gate has not approved this move. No quote was requested.",
      links: io.approval?.explorerUrl ? [{ label: "gate", url: io.approval.explorerUrl }] : [],
    };
  }
  if (!io.armed) {
    return {
      released: false,
      stoppedAt: "live-switch",
      detail: "The on-chain gate approved. LIVE=1 and SLUICE_EXECUTE=yes are not both set, so no quote was requested.",
      links: io.approval.explorerUrl ? [{ label: "gate", url: io.approval.explorerUrl }] : [],
    };
  }
  const quote = await io.requestQuote();
  const decision = evaluateQuote(io.policy, quote, io.expected);
  if (!decision.approved) {
    return {
      released: false,
      stoppedAt: "quote-gate",
      detail: decision.reasons.join("; "),
      links: [],
    };
  }
  const deposit = quote.quote.depositAddress;
  if (!deposit) {
    return {
      released: false,
      stoppedAt: "quote-gate",
      detail: "Live quote did not include a deposit address. Nothing was signed.",
      links: [],
    };
  }
  const tx = await io.signAndBroadcast(quote);
  await io.notifyDeposit(tx.hash, quote);
  const status = await io.poll(quote);
  return {
    released: true,
    stoppedAt: "status",
    detail: status.summary,
    outcome: status.outcome,
    txHash: tx.hash,
    links: [{ label: "Base deposit", url: tx.explorerUrl }, ...status.links],
  };
}

export function missingSwitches(argv: readonly string[], env: NodeJS.ProcessEnv): string[] {
  const missing: string[] = [];
  if (!argv.includes("--live")) missing.push("--live");
  if (env.LIVE !== "1") missing.push("LIVE=1");
  if (env.SLUICE_EXECUTE !== "yes") missing.push("SLUICE_EXECUTE=yes");
  return missing;
}

/** near-cli-rs invocation. Not run unless the process is armed. */
export function gateApproveCommand(contract: string, args: unknown, account: string, network: string): string[] {
  return [
    "near",
    "contract",
    "call-function",
    "as-transaction",
    contract,
    "approve",
    "json-args",
    JSON.stringify({ proposal: args }),
    "prepaid-gas",
    "30 Tgas",
    "attached-deposit",
    "0 NEAR",
    "sign-as",
    account,
    "network-config",
    network,
    "sign-with-keychain",
    "send",
  ];
}

export function mpcSignCommand(contract: string, payloadHash: Uint8Array, path: string, account: string, network: string): string[] {
  return [
    "near",
    "contract",
    "call-function",
    "as-transaction",
    contract,
    "sign",
    "json-args",
    JSON.stringify(mpcSignRequest(payloadHash, path)),
    "prepaid-gas",
    "100 Tgas",
    "attached-deposit",
    `${SIGN_DEPOSIT_YOCTO} yoctoNEAR`,
    "sign-as",
    account,
    "network-config",
    network,
    "sign-with-keychain",
    "send",
  ];
}

export function depositTransaction(quote: QuoteResponse, nonce: bigint) {
  const address = quote.quote.depositAddress;
  if (!address) throw new Error("quote has no deposit address");
  return usdcDepositCall({
    depositAddress: address,
    amount: BigInt(quote.quote.amountIn),
    nonce,
  });
}

export async function broadcastBase(
  raw: string,
  rpcUrl: string,
  env: NodeJS.ProcessEnv = process.env,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  assertArmed(env);
  if (!raw.startsWith("0x02")) throw new Error("refusing to broadcast a transaction that is not an EIP-1559 payload");
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "sluice", method: "eth_sendRawTransaction", params: [raw] }),
  });
  const body: unknown = await response.json();
  if (typeof body !== "object" || body === null) throw new Error("Base RPC returned no body");
  if ("error" in body) throw new Error(`Base RPC ${JSON.stringify((body as { error: unknown }).error)}`);
  const hash = (body as { result?: unknown }).result;
  if (typeof hash !== "string") throw new Error("Base RPC did not return a transaction hash");
  return hash;
}

function runCommand(command: string[], env: NodeJS.ProcessEnv): Promise<string> {
  assertArmed(env);
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command[0] ?? "near", command.slice(1), { env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(stderr.trim() || `near exited ${code}`));
    });
  });
}

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

function readStatus(name: string): ExecutionStatus {
  return asExecutionStatus(JSON.parse(readFileSync(resolve(rootDir, "fixtures", name), "utf8")));
}

async function printPlan(): Promise<void> {
  const policy = loadPolicy();
  const book = loadYieldFixture(policy);
  const brain = await propose(book, policy, false);
  const decision = evaluateProposal(brain.proposal, book, policy, new Date(), null, false, brain.claimedRecipient);
  line("Sluice live path. This command did not sign, quote for a deposit, or broadcast.");
  line("");
  line(`1. Proposal. ${brain.proposal.amountUsd} ${brain.proposal.asset} ${brain.proposal.fromChain}/${brain.proposal.fromProject} -> ${brain.proposal.toChain}/${brain.proposal.toProject}.`);
  line(`2. Off-chain gate: ${decision.approved ? "APPROVE" : "VETO"}${decision.netSpreadBps !== null ? `, net ${decision.netSpreadBps} bps` : ""}.`);
  line("3. On-chain gate. Call sluice-gate.approve with a function-call key scoped to that contract and that method. Not called.");
  line("4. 1Click quote with dry:false. Only after step 3 approves, and only with --live, LIVE=1, and SLUICE_EXECUTE=yes. Not requested.");
  line("5. Quote gate. from-asset, to-asset, recipient, refund address, and amount must match the approval.");
  line(`6. Base USDC transfer to the deposit address. Chain Signatures path ${DEFAULT_DERIVATION_PATH} on ${mpcContractId(process.env.SLUICE_GATE_NETWORK)}, or SLUICE_BASE_ADDRESS when that is the configured signer. v1.signer.sign requires ${SIGN_DEPOSIT_YOCTO} yoctoNEAR, which a function-call key cannot attach, so the gate key cannot request it.`);
  line("7. Broadcast the signed transaction, POST /v0/deposit/submit, then poll /v0/status until SUCCESS, REFUNDED, or FAILED.");
  line("");
  line("Status poll, from fixtures. There is no deposit to poll.");
  for (const [name, label] of [
    ["status-success.json", "SUCCESS"],
    ["status-refunded.json", "REFUNDED"],
    ["status-failed.json", "FAILED"],
  ] as const) {
    const read = interpretStatus(readStatus(name));
    line(`  ${label} -> ${read.outcome}. ${read.summary}`);
  }
  const sample = loadQuoteFixture();
  const tx = depositTransaction(
    {
      ...sample,
      quote: { ...sample.quote, depositAddress: "0x2222222222222222222222222222222222222222" },
    },
    0n,
  );
  line("");
  line(`Unsigned Base transfer preview for a placeholder deposit address. chain ${tx.chainId}, to ${tx.to}, payload ${tx.payloadHash.length} bytes. Not signed. Explorer shape ${baseTxUrl("0x" + "ab".repeat(32))}.`);
  line("");
  line(`Switches missing right now: ${missingSwitches(process.argv.slice(2), process.env).join(", ") || "none"}.`);
  line("Nothing was signed or broadcast.");
}

function required(name: string): string | null {
  const value = process.env[name]?.trim();
  return value ? value : null;
}

async function runArmed(): Promise<void> {
  const contract = required("SLUICE_GATE_CONTRACT");
  const agent = required("SLUICE_NEAR_ACCOUNT_ID");
  const recipient = required("SLUICE_RECIPIENT");
  const refundTo = required("SLUICE_REFUND_TO");
  const rpc = required("SLUICE_BASE_RPC");
  const signer = required("SLUICE_SIGNER_ACCOUNT");
  const missing = [
    ["SLUICE_GATE_CONTRACT", contract],
    ["SLUICE_NEAR_ACCOUNT_ID", agent],
    ["SLUICE_RECIPIENT", recipient],
    ["SLUICE_REFUND_TO", refundTo],
    ["SLUICE_BASE_RPC", rpc],
    ["SLUICE_SIGNER_ACCOUNT", signer],
  ]
    .filter((entry) => !entry[1])
    .map((entry) => entry[0]);
  if (missing.length > 0 || !contract || !agent || !recipient || !refundTo || !rpc || !signer) {
    line("Live switches are set, and the move still did not start.");
    line(`Missing ${missing.join(", ")}.`);
    line("No quote was requested and nothing was signed.");
    process.exitCode = 2;
    return;
  }
  const { fetchYieldBook } = await import("./yields.js");
  const policy = loadPolicy();
  const book = await fetchYieldBook(policy);
  const brain = await propose(book, policy, true);
  const offchain = evaluateProposal(brain.proposal, book, policy, new Date(), null, false, brain.claimedRecipient);
  if (!offchain.approved) {
    line(`Off-chain gate vetoed. ${offchain.reasons.join("; ")}`);
    line("The on-chain gate was not called. Nothing was signed.");
    process.exitCode = 2;
    return;
  }
  const network = process.env.SLUICE_GATE_NETWORK?.trim() || "testnet";
  const tokens = await getTokens();
  const origin = findUsdc(tokens, brain.proposal.fromChain);
  const destination = findUsdc(tokens, brain.proposal.toChain);
  const amount = usdToBaseUnits(brain.proposal.amountUsd, origin.decimals);
  const expected: QuoteExpectation = {
    originAsset: origin.assetId,
    destinationAsset: destination.assetId,
    amount,
    recipient,
    refundTo,
  };
  const source = book.candidates.find(
    (venue) => venue.chain === brain.proposal.fromChain && venue.project === brain.proposal.fromProject,
  );
  const dest = book.candidates.find(
    (venue) => venue.chain === brain.proposal.toChain && venue.project === brain.proposal.toProject,
  );
  if (!source || !dest) {
    line("Yield rows for the proposal were not in the book. The on-chain gate was not called.");
    process.exitCode = 2;
    return;
  }
  line(`Off-chain gate approved. Base RPC ${rpc} is not called unless a signed transaction exists. Calling the on-chain gate before any funded quote.`);
  const approvalText = await runCommand(
    gateApproveCommand(
      contract,
      {
        from_chain: brain.proposal.fromChain,
        to_chain: brain.proposal.toChain,
        asset: brain.proposal.asset,
        amount_usd_cents: Math.round(brain.proposal.amountUsd * 100),
        from_project: brain.proposal.fromProject,
        to_project: brain.proposal.toProject,
        recipient: "",
        source_apy_ppm: apyToPpm(source.decisionApy),
        dest_apy_ppm: apyToPpm(dest.decisionApy),
      },
      agent,
      network,
    ),
    process.env,
  );
  const approved = approvalText.includes('"approved":true') || approvalText.includes('"approved": true');
  const result = await runLiveMove({
    armed: true,
    approval: approved ? { source: "onchain", approved: true, id: "cli" } : null,
    policy,
    expected,
    requestQuote: () =>
      requestQuote(
        buildQuoteRequest({
          originAsset: origin.assetId,
          destinationAsset: destination.assetId,
          amount,
          recipient,
          refundTo,
          slippageToleranceBps: policy.slippageToleranceBps,
          deadline: new Date(Date.now() + policy.quoteDeadlineSeconds * 1000).toISOString(),
          dry: false,
        }),
      ),
    signAndBroadcast: async (quote) => {
      const tx = depositTransaction(quote, 0n);
      const path = process.env.SLUICE_DERIVATION_PATH?.trim() || DEFAULT_DERIVATION_PATH;
      await runCommand(mpcSignCommand(mpcContractId(network), tx.payloadHash, path, signer, network), process.env);
      throw new Error(
        "The signer returned, and this entry does not decode SignatureResponse into r,s,v. broadcastBase was not called.",
      );
    },
    notifyDeposit: async () => {
      throw new Error("deposit submit was not reached");
    },
    poll: async (quote) => {
      const { pollStatus } = await import("./intents.js");
      const polled = await pollStatus(quote.quote.depositAddress ?? "", quote.quote.depositMemo, 5_000, 60_000);
      return { outcome: polled.outcome, summary: polled.summary, links: statusExplorerLinks(polled.raw) };
    },
  });
  line(result.detail);
  for (const link of result.links) line(`${link.label} ${link.url}`);
  if (!result.released) process.exitCode = 2;
}

async function main(): Promise<void> {
  loadEnvFile();
  const argv = process.argv.slice(2);
  if (!argv.includes("--live")) {
    await printPlan();
    return;
  }
  const missing = missingSwitches(argv, process.env);
  if (missing.length > 0) {
    line("Refusing the live move.");
    line(`Missing ${missing.join(", ")}.`);
    line("No quote was requested and nothing was signed. Matt has to set these and approve the move.");
    process.exitCode = 2;
    return;
  }
  if (!liveArmed()) throw new Error("arming check disagreed with itself");
  await runArmed();
}

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  });
}
