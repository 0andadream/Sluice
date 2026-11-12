import { loadPolicy } from "../src/gate.js";

const account = process.argv[2]?.trim();
if (!account) {
  process.stderr.write("account required\n");
  process.exit(1);
}
const policy = loadPolicy();
const body = {
  owner: account,
  agent: account,
  policy: {
    max_move_usd_cents: Math.round(policy.maxMoveUsd * 100),
    allowed_assets: policy.allowedAssets,
    allowed_chains: policy.allowedChains,
    venues: policy.venues.map((venue) => ({ chain: venue.chain, project: venue.project })),
    min_net_spread_bps: policy.minNetSpreadBps,
    slippage_tolerance_bps: policy.slippageToleranceBps,
    unauthenticated_fee_bps: policy.unauthenticatedFeeBps,
    stablecoin_route_fee_bps: policy.stablecoinRouteFeeBps,
    assumed_hold_days: policy.assumedHoldDays,
    max_payback_days: policy.maxPaybackDays,
    cooldown_seconds: policy.cooldownSeconds,
    has_one_click_key: false,
    allowed_recipients: policy.allowedRecipients,
  },
};
process.stdout.write(JSON.stringify(body));
