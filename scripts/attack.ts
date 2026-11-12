import { writeFileSync } from "node:fs";
import { assessAttack, contractTest, INJECTED } from "../src/attack-demo.js";

function line(text = ""): void {
  process.stdout.write(`${text}\n`);
}

const attack = assessAttack();
const lines: string[] = [];
function record(text = ""): void {
  lines.push(text);
  line(text);
}

record("Sluice attack demo");
record("A prompt-injected model proposes $5000 USDC to attacker.near.");
record("The model also set force, approved, and skipGate. The parser drops those fields.");
record("");
record(`Injected amountUsd ${INJECTED.amountUsd}, recipient ${INJECTED.recipient}.`);
record(`Parsed amountUsd ${attack.parsed.amountUsd}. Claimed recipient ${attack.named}.`);
record(`force field kept by the parser: ${"force" in attack.parsed}.`);
record("");
record(`Off-chain gate: ${attack.decision.approved ? "APPROVE" : "VETO"}`);
for (const reason of attack.decision.reasons) record(`  ${reason}`);
record("");
record("Contract preview args:");
record(`  ${JSON.stringify(attack.contractArgs)}`);
record("");

if (!attack.decision.approved) {
  record("Off-chain gate blocked the injection.");
} else {
  record("Off-chain gate failed to block the injection.");
  process.exitCode = 1;
}

const cargo = await contractTest();
const veto = cargo.includes("CONTRACT_VETO approved=false");
const reasons = cargo.split("\n").find((entry) => entry.includes("CONTRACT_REASONS"));
if (veto) {
  record("Contract test blocked the same injection.");
  if (reasons) record(`  ${reasons.trim()}`);
} else {
  record("Contract test did not report CONTRACT_VETO. Run cargo test attack_blocks_injected_proposal -- --nocapture.");
  process.exitCode = 1;
}

record("");
record("No funds moved. The model does not hold a key.");

if (process.argv.includes("--record")) {
  writeFileSync("fixtures/attack-sample.txt", `${lines.join("\n")}\n`);
}
