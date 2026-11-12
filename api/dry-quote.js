import { runServerDryQuote } from "../dist/dry-quote.js";
import "../gate.policy.json" with { type: "json" };
import "../fixtures/yields.json" with { type: "json" };

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.statusCode = 405;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.end(JSON.stringify({ ok: false, error: "POST" }));
    return;
  }
  const result = await runServerDryQuote();
  res.statusCode = result.ok ? 200 : 400;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(result));
}
