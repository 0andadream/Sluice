import { buildPublicState, parseDeployment } from "../dist/snapshot.js";
import deployed from "../contracts/sluice-gate/deployed.json" with { type: "json" };
import "../gate.policy.json" with { type: "json" };
import "../fixtures/yields.json" with { type: "json" };
import "../fixtures/quote.json" with { type: "json" };
import "../fixtures/tokens.json" with { type: "json" };
import "../fixtures/decisions.json" with { type: "json" };
import "../fixtures/status-pending.json" with { type: "json" };
import "../fixtures/status-success.json" with { type: "json" };
import "../fixtures/status-refunded.json" with { type: "json" };
import "../fixtures/status-failed.json" with { type: "json" };
import "../fixtures/status-incomplete.json" with { type: "json" };

export default async function handler(_req, res) {
  const body = JSON.stringify(
    await buildPublicState(new Date(), {
      deployment: parseDeployment(deployed),
      includePreview: true,
      previewTimeoutMs: 2_500,
    }),
  );
  res.statusCode = 200;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(body);
}
