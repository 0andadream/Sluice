# Sluice

[![ci](https://github.com/0andadream/Sluice/actions/workflows/ci.yml/badge.svg)](https://github.com/0andadream/Sluice/actions/workflows/ci.yml)

**The agent proposes. The policy gate decides. Capital flows.**

Live control page: [https://sluice-one.vercel.app](https://sluice-one.vercel.app)

Built during the [NEAR HACKATHON](https://nearhackathon.com) window (announced 2026-10-19, development through 2026-11-14). The baseline in this repo is the dry-run from 2026-11-10. This tree adds the quote check, the on-chain gate, the live path behind an explicit switch, and the attack demo.

Tracks: [AI Security & Defense](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/06-security.md) (lead), [DeFi](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/01-defi.md), [Agent Economy](https://github.com/nearai/near-hackathon-prompt-examples/blob/main/tracks/07-agents.md).

## Quickstart

Node.js 22. Rust 1.95 only if you want the contract tests.

```bash
npm install
npm test
npm run dry
```

You should see the recorded USDC book, a rules proposal for **$10 from Base Fluid to NEAR Rhea**, `Gate: APPROVE` with **net 428 bps**, a veto because a last-approval time is in the future, and a veto for a quote whose recipient, refund address, assets, or amount do not match. The dry quote has no deposit address.

```bash
npm run attack
npm run execute -- --plan
```

`npm run attack` shows a prompt-injected model proposing **$5,000 USDC to `attacker.near`**. The off-chain gate vetoes it, and `cargo test attack_blocks_injected_proposal` vetoes the same arguments inside the NEAR contract. `npm run execute -- --plan` prints the live path and does not sign or broadcast. A sample of the attack output is in `fixtures/attack-sample.txt`.

Nothing in the default commands spends funds. A funded 1Click swap is mainnet. It is not run here.

## What a judge runs

From a checkout, with Node.js 22:

1. `npm install`
2. `npm test`
3. `npm run dry`
4. Confirm the yield table names Rhea Lend on NEAR, Fluid Lending on Base, and Save and Jupiter Lend on Solana, using `apyBase`.
5. Confirm the proposal is `$10.00 USDC` from `base/fluid-lending` to `near/rhea-lend`, and the brain line says `rules`.
6. Confirm `Gate: APPROVE` with gross 498 bps, fee 20 bps, net 428 bps, payback 51.3 days.
7. Confirm the probes veto $50, `ETH`, a removed destination chain, a cooldown, a last-approval time in the future, and the reverse move.
8. Confirm the quote gate approves the recorded dry quote, and vetoes a swapped recipient, refund address, from-asset, to-asset, and amount.
9. Confirm `SUCCESS` is settled, `REFUNDED` is refunded, and `FAILED` is failed.
10. `npm run attack` and `npm run execute -- --plan`. The plan says the on-chain gate was not called and nothing was signed.

`npm run dry:live` reads DefiLlama again and can request a new dry quote. It still does not send funds. If the spread no longer clears 50 bps, the gate prints `VETO` and skips the quote.

Rust, for the contract: `cargo test --manifest-path contracts/sluice-gate/Cargo.toml`.

## The problem

A yield agent that can move stablecoins can also move them somewhere the operator did not allow. The higher APY is also the bait. The check has to be a function. Same yields, same policy, same answer. The model can explain why it wants the move. It cannot mark the move approved.

## What Sluice does

Sluice compares plain USDC supply on Base, NEAR, and Solana, then proposes leaving the chain where the capital sits. The policy file is the allowlist: assets, chains, venues, a dollar cap, a minimum net spread, a payback limit, a cooldown, and an empty recipient list so the model cannot name a destination.

> The model proposes a move. The gate decides. No field on the proposal can skip a check.

On 2026-11-10 the rules brain, reading DefiLlama `apyBase`, proposed the policy cap: $10 USDC from Base Fluid Lending at 5.23% to NEAR Rhea Lend at 10.21%. That row is a proposal plus a dry quote. It is not a settlement.

## Architecture

```mermaid
flowchart TB
    Policy["gate.policy.json"] --> Gate["src/gate.ts"]
    Policy --> Chain["contracts/sluice-gate"]
    Llama["yields.llama.fi/pools"] --> Yields["src/yields.ts"]
    Yields --> Brain["src/brain.ts"]
    Cloud["cloud-api.near.ai optional"] --> Brain
    Brain --> Gate
    Gate --> Chain
    Chain --> Intents["src/intents.ts"]
    Intents --> Click["1click.chaindefuser.com"]
```

The dry-run stops at the quote. A funded swap would continue only after the on-chain gate approves, and only when `--live`, `LIVE=1`, and `SLUICE_EXECUTE=yes` are all set. Those switches are not set by any script in this repo.

| Piece | What it does | Where |
| --- | --- | --- |
| DefiLlama yields | USDC rates. No key | `src/yields.ts` |
| Rules brain | The proposal when no model key is set, and when the model call fails | `src/brain.ts` |
| NEAR AI Cloud | Optional planner. OpenAI-compatible `POST /v1/chat/completions` | `src/brain.ts` |
| Off-chain gate | Deterministic veto, including the quote match | `src/gate.ts` |
| On-chain gate | The same economic checks, cooldown storage, a decision log, events | `contracts/sluice-gate` |
| 1Click | Tokens, dry or live quote, status, deposit submit | `src/intents.ts` |
| Base signer | Chain Signatures derivation and an unsigned USDC transfer. Does not broadcast unless armed | `src/signer.ts`, `src/execute.ts` |
| Control page | Snapshot age, decision history, a dry-quote button | `web/`, `api/` |

Asset ids come from `GET /v0/tokens`. The client keeps the row whose `symbol` is exactly `USDC`. `sUSDC` is in the fixture so a prefix match would be visible, and it is not selected.

| Chain | 1Click `blockchain` | `assetId` |
| --- | --- | --- |
| Base | `base` | `nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near` |
| NEAR | `near` | `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` |
| Solana | `sol` | `nep141:sol-5ce3bf3a31af18be40ba30f721101b4341690186.omft.near` |

Those ids were the unique `USDC` rows on 2026-11-10. The code does not hardcode them.

## The gate

`gate.policy.json` is the policy. `evaluateProposal` and the contract use the same integer rounding as JavaScript `Math.round` on parts-per-million APY, so both sides get gross **498** bps on the recorded book.

```
grossSpreadBps     = round((destApy - sourceApy) * 100)
oneTimeCostBps     = feeBps + slippageToleranceBps
annualizedCostBps  = round(oneTimeCostBps * 365 / assumedHoldDays)
netSpreadBps       = grossSpreadBps - annualizedCostBps
paybackDays        = oneTimeCostBps * 365 / grossSpreadBps
```

`feeBps` is `unauthenticatedFeeBps` (**20**) unless `ONECLICK_API_KEY` is set, in which case a USDC-to-USDC move uses `stablecoinRouteFeeBps` (**1**). `assumedHoldDays` is 365. On the recorded book that is gross 498 bps, cost 70 bps, net 428 bps, payback 51.3 days. The minimum net is 50 bps. The maximum payback is 180 days.

Hackathon rule Q-006 says a quote without a 1Click JWT costs 0.2% (20 bps). The fees page at [docs.near-intents.org](https://docs.near-intents.org/resources/fees.md), read on 2026-11-12, lists 25 bps without a key and 20 bps with a key (1 bp on stablecoin and same-asset routes). The policy uses 20, matching Q-006. Set `unauthenticatedFeeBps` to 25 to charge the higher figure on that page. The gate does not read the quote's `appFees` when it decides the spread. The recorded quote's `appFee` was 1 bp.

A last-approval time in the future is a veto. The old check treated a negative elapsed time as "no cooldown," which let a future timestamp through. `elapsed < 0` now blocks.

`evaluateQuote` checks that the quote is the approved move: from-asset, to-asset, recipient, refund address, and amount. A quote for a different route or recipient fails even when the price is inside the slippage budget. Dollar size and `minAmountOut` are still checked. A dry quote that contains a `depositAddress` fails.

`allowedRecipients` is empty. Any recipient the model names is a veto. The operator address is applied later, from `SLUICE_RECIPIENT`, when a quote is built. The model does not choose it.

## On-chain gate

`contracts/sluice-gate` is a Rust contract on `near-sdk` 5.5. It stores the policy, recomputes the spread from the APY parts-per-million the agent submits, enforces the cap, the allowlists, the recipient rule, and the cooldown, and keeps the last approval time. Decisions are stored in a fixed ring of 16 slots allocated at init, so later calls do not need an attached deposit. Each decision emits `EVENT_JSON` with standard `sluice`, version `1.0.0`, event `decision`.

`preview` is a view. It runs the same checks and writes nothing. `approve` is the change method. Only the configured agent account can call it. Only the owner can call `set_policy`.

```bash
cargo test --manifest-path contracts/sluice-gate/Cargo.toml
bash contracts/sluice-gate/deploy.sh <account.testnet>
```

The tests run in near-sdk's unit-testing VM (`near-vm-runner`). They cover an approval, the cooldown, a future timestamp, the $5,000 injection, and the split between owner and agent. `deploy.sh` builds the wasm and inits the contract with the policy file. It needs the `near` CLI and a testnet account you control. The key stays in the CLI keychain and is not written into this repo.

A copy is deployed on testnet at [`sluice-gate-df46.testnet`](https://testnet.nearblocks.io/address/sluice-gate-df46.testnet).

- Deploy: [explorer.testnet.near.org/transactions/StAS6gwiNXqQumrmGGHjFZfMbWe6rHepV46urFmFAya](https://explorer.testnet.near.org/transactions/StAS6gwiNXqQumrmGGHjFZfMbWe6rHepV46urFmFAya)
- The attack veto, `approve` returning `approved: false` and the `sluice` `decision` event: [explorer.testnet.near.org/transactions/1Qj7CZ4xrhcfpAJDc8unvPBT6AiRoAH3HsyqYKY29rS](https://explorer.testnet.near.org/transactions/1Qj7CZ4xrhcfpAJDc8unvPBT6AiRoAH3HsyqYKY29rS)

`preview` on that contract, with no key, returns the same two reasons: the amount is over the cap, and `attacker.near` is not an allowed recipient. The full-access key that created the account is not in this repo. Redeploy with `deploy.sh` onto an account you hold if you want to administer it.

Create the account, if you do not have one:

```bash
near account create-account sponsor-by-faucet-service <name>.testnet \
  autogenerate-new-keypair save-to-keychain network-config testnet create
```

### The function-call key

The agent does not get a full-access key. Add a second key on the agent account that can call only this contract:

```bash
near account add-key <agent-account> grant-function-call-access \
  --allowance '1 NEAR' \
  --receiver-account-id <gate-account> \
  --method-names 'approve' \
  use-manually-provided-public-key <ed25519:...> \
  network-config testnet sign-with-keychain send
```

Check the flags against `near account add-key --help`. The method list is the point: **`approve` only**. `set_policy` is not on it, so the agent cannot rewrite the cap or the allowlist. View methods do not need a key.

What that key cannot do, from the [access keys](https://docs.near.org/protocol/accounts-contracts/access-keys) page:

- It can call only `<gate-account>`. It cannot call `v1.signer`, a token contract, or any other account.
- It cannot attach NEAR. `approve` is not payable, so that is enough for the gate. `v1.signer.sign` requires 1 yoctoNEAR (`SIGN_DEPOSIT_YOCTONEAR` in the MPC contract), so this key cannot request a chain signature.
- It cannot transfer NEAR, add or delete keys, delete the account, or deploy code.
- The allowance is gas, charged at the buy price and refunded later. If it runs out, the key is dead. Adding NEAR to the account does not refill it. Leave a full-access key with the operator, offline from the agent, so a new function-call key can be added. An account whose only keys are exhausted function-call keys cannot sign anything.

The agent process should be given only that key in the near CLI keychain. This repository never reads a raw secret from the environment and never puts one in git.

## Live path

`npm run execute` and `npm run execute -- --plan` print the steps and stop. A funded move needs all of:

- the CLI flag `--live`
- `LIVE=1`
- `SLUICE_EXECUTE=yes`
- `SLUICE_GATE_CONTRACT`, `SLUICE_NEAR_ACCOUNT_ID`, `SLUICE_RECIPIENT`, `SLUICE_REFUND_TO`, `SLUICE_BASE_RPC`, and `SLUICE_SIGNER_ACCOUNT`

If any of those are missing, the process exits before a funded quote and before a signature. `runLiveMove` will not request a quote until it has an on-chain approval, and it will not sign if `evaluateQuote` rejects the route. Status polling classifies `SUCCESS`, `REFUNDED`, and `FAILED`, and prints explorer links when the body has them.

The Base transfer is an EIP-1559 transaction, chain id 8453, to USDC `0x833589fcd6edb6e08f4c7c32d4f71b54bda02913`, calling `transfer` on the 1Click deposit address for the quoted amount. The payload is `keccak256(0x02 || rlp(...))`, which is what `v1.signer.sign` would be asked to sign on path `base-1` (domain id 0, secp256k1). The derivation view is `derived_public_key` on `v1.signer` (mainnet) or `v1.signer-prod.testnet`. `SLUICE_BASE_ADDRESS` is the explicit signer when you are not deriving one.

This entry does not decode the MPC `SignatureResponse` into `r, s, v`, so `broadcastBase` is not called from the CLI even if every switch is on. `broadcastBase` itself refuses to run unless the process is armed. No mainnet move was executed.

## NEAR AI and attestation

With no `NEAR_AI_API_KEY`, the brain stays on the rules proposal and says so. A bad model response, an HTTP error, or a missing key falls back to the rules. The key is not printed.

When a key is set and the caller asked for the model (`npm run dry:live`), the client posts to `https://cloud-api.near.ai/v1/chat/completions`. If the response has an id, it also calls `GET /v1/signature/<id>?signing_algo=ecdsa` and records the HTTP status. It does **not** verify the signature. Verification, per [the NEAR AI docs](https://docs.near.ai/cloud/verification), is a separate step: preflight the gateway attestation (and every model-attestation candidate when you require a TEE), keep the exact request and response bytes, then check the signature's `signing_address` and `signing_algo` against that evidence. `provider_tee` is the kind that binds a response to a model-serving TEE. A `gateway` signature binds the gateway, not the model. A verified signature still would not approve a move. The gate does.

The model is told not to name a recipient. If it does, `claimedRecipient` is passed into the gate and vetoed while `allowedRecipients` is empty. `force`, `approved`, and `skipGate` are dropped by the parser.

## Control page

`web/` is the static page. `api/state.js` and `api/dry-quote.js` are the Vercel functions. `vercel.json` builds `src/` with `tsc` and publishes `web/`.

```bash
npm run control
```

That serves `http://127.0.0.1:4173`. The page shows how old the yield snapshot is, the decision, the vetoes, and the decision history. Explorer links appear when a decision has one. **Run live dry quote** posts to `/api/dry-quote`. The server uses `SLUICE_RECIPIENT` and `SLUICE_REFUND_TO` from its own environment. The browser cannot supply an address. The quote is `dry: true`. If those variables are unset, the button returns an error and no quote is requested.

Redeploy the existing Vercel project from this repo so the page and the API ship together. The previous live site was a static snapshot whose source was not in the repo.

## Security model

| Boundary | What holds |
| --- | --- |
| The model | Proposes seven fields. Cannot approve, cannot name a recipient, cannot raise the cap. |
| Off-chain gate | Allowlists, cap, spread, payback, cooldown, future timestamp, quote match. |
| On-chain gate | The same economic checks, stored cooldown, event log. APY numbers are the agent's, not the model's. |
| Function-call key | `approve` on the gate contract only. No deposit, no other contract, no `v1.signer`. |
| Quote | Must match from-asset, to-asset, recipient, refund address, and amount before any signature. |
| Live switches | `--live` and `LIVE=1` and `SLUICE_EXECUTE=yes`, plus the account config. Default is off. |

A modified agent binary could still submit false APY numbers. The contract checks the math on the numbers it is given and logs them. It does not fetch DefiLlama. Binding those numbers to a TEE-attested agent is the next step, and it is not implemented here. The NEAR AI path records the signature endpoint and does not verify it.

## Running it yourself

```bash
npm install
npm run dry
cp .env.example .env   # optional, for a fresh dry quote
npm run dry:live
```

| Variable | Required | What it does |
| --- | --- | --- |
| `NEAR_AI_API_KEY` | No | Lets `npm run dry:live` ask NEAR AI. Without it, the rules proposal runs |
| `NEAR_AI_MODEL` | No | Defaults to `z-ai/glm-5.2` |
| `NEAR_AI_BASE_URL` | No | Defaults to `https://cloud-api.near.ai/v1` |
| `ONECLICK_API_KEY` | No | Switches the gate's fee assumption from 20 bps to 1 bp on USDC routes |
| `SLUICE_RECIPIENT` | Fresh quote only | Destination address. Not chosen by the model |
| `SLUICE_REFUND_TO` | Fresh quote only | Refund address on the origin chain |
| `SLUICE_GATE_CONTRACT` | Live move only | The deployed gate |
| `LIVE`, `SLUICE_EXECUTE` | Live move only | Both required, with `--live`. Leave them unset |

Do not commit `.env`.

## Project layout

| Path | What it holds |
| --- | --- |
| `src/gate.ts` | Proposal veto and quote match |
| `src/brain.ts` | Rules proposal, optional NEAR AI, JSON parse |
| `src/execute.ts` | The live path. Refuses to run unless armed |
| `src/signer.ts` | Keccak, the unsigned Base transfer, the MPC sign request |
| `contracts/sluice-gate` | The NEAR contract, tests, and `deploy.sh` |
| `scripts/attack.ts` | The prompt-injection demo |
| `web/`, `api/` | The control page |
| `fixtures/` | Recorded book, quote, statuses, attack sample, decision history |
| `gate.policy.json` | The cap, the allowlists, the 20 bp fee, the empty recipient list |

## Libraries

Runtime npm dependencies: none. HTTP is Node's `fetch`.

| Package | Role |
| --- | --- |
| `typescript` 5.7 | `npm run typecheck` |
| `tsx` 4.19 | Runs the TypeScript entrypoints |
| `@types/node` 20 | Node types |
| `near-sdk` 5.5 | The gate contract. Not an npm dependency |

DefiLlama, NEAR Intents, and NEAR AI Cloud are HTTP services.

## Known limitations

- No mainnet move was executed. The CLI does not assemble an MPC signature into a signed Base transaction, so it cannot broadcast one. `broadcastBase` exists and is tested with a fake RPC. Matt has to approve any live move separately, fund the Base address, and review the signature assembly before it is used.
- The on-chain gate trusts the APY numbers the agent submits. A prompt cannot change that. A replaced agent binary could. TEE attestation of the agent is not implemented. The NEAR AI response signature is fetched as a status code and is not verified.
- There is no 1Click testnet. A funded swap would be mainnet. `Q-007` in the hackathon rules says the same.
- The $10 cap matches liquidity observed on 2026-11-10. A later quote for a larger size can succeed. The policy file is the place to raise the ceiling.
- The unauthenticated fee in this policy is 20 bps, from hackathon rule Q-006. The fees page currently also prints 25 bps without a key. See [The gate](#the-gate).
- The move is a USDC transfer into 1Click, not a deposit into Rhea. The destination is the recipient account. Supplying on Rhea is not in this tree.
- Reward APY is ignored on purpose. Kamino's USDC markets are not on the venue list.
- `https://yields.llama.fi/pools` answered on 2026-11-10. If that route is removed, the live read fails and `npm run dry` still uses `fixtures/yields.json`. The control page shows the age of that snapshot.
- The recorded quote uses a placeholder recipient and the refund address from the 1Click OpenAPI example. No deposit was made to either.
- Status fixtures follow the documented status enum. They are not swaps this project submitted.
- NEAR AI was not called for the recorded proposal. The published proposal is the rules proposal. The call path degrades to that proposal when the key is absent.
- 1Click quotes are mainnet. A dry quote does not reserve liquidity.
- The function-call key's allowance is not refreshed by topping up the account. If it hits zero, the operator's full-access key has to add a new one.
- Chain-signature signing needs a second account that can attach 1 yoctoNEAR. That account is not created here. Do not reuse the gate's function-call key for it. That key cannot attach a deposit, and it should not be able to call `v1.signer`.
