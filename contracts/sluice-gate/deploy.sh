#!/usr/bin/env bash
# Deploy sluice-gate to NEAR testnet. Does not touch mainnet and does not move USDC.
# Requires: rustup target wasm32-unknown-unknown, the `near` CLI, and a testnet account.
# The account key stays in the near CLI keychain. This script does not print it.
set -euo pipefail
cd "$(dirname "$0")"
ACCOUNT="${1:-}"
if [[ -z "$ACCOUNT" ]]; then
  echo "Usage: ./deploy.sh <account.testnet>"
  echo "Create a free account first, for example:"
  echo "  near account create-account sponsor-by-faucet-service <name>.testnet autogenerate-new-keypair save-to-keychain network-config testnet create"
  exit 1
fi
if ! command -v near >/dev/null 2>&1; then
  echo "near CLI is not installed. Install near-cli-rs, then re-run this script."
  exit 1
fi
cargo build --target wasm32-unknown-unknown --release
WASM="target/wasm32-unknown-unknown/release/sluice_gate.wasm"
ARGS="$(cd ../.. && npx tsx scripts/print-gate-init.ts "$ACCOUNT")"
# sign-with-keychain is the normal path. A headless machine with no OS keyring
# should create the account with save-to-legacy-keychain and set SLUICE_NEAR_KEYCHAIN=legacy.
SIGN=sign-with-keychain
if [[ "${SLUICE_NEAR_KEYCHAIN:-}" == "legacy" ]]; then
  SIGN=sign-with-legacy-keychain
fi
near contract deploy "$ACCOUNT" use-file "$WASM" \
  with-init-call new json-args "$ARGS" prepaid-gas '100 Tgas' attached-deposit '1 NEAR' \
  network-config testnet "$SIGN" send
cat > deployed.json <<EOF
{
  "network": "testnet",
  "contractId": "$ACCOUNT",
  "explorerAccount": "https://testnet.nearblocks.io/address/$ACCOUNT"
}
EOF
echo "Deployed $ACCOUNT"
echo "https://testnet.nearblocks.io/address/$ACCOUNT"
echo "https://explorer.testnet.near.org/accounts/$ACCOUNT"
echo "Add the agent function-call key separately. Do not put set_policy in its method list."
