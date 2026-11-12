import { handleTrick } from "../dist/trick.js";
import "../gate.policy.json" with { type: "json" };
import "../fixtures/yields.json" with { type: "json" };
import "../contracts/sluice-gate/deployed.json" with { type: "json" };

const BODY_MAX = 12_000;

function clientIp(req) {
  const forwarded = req.headers?.["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = typeof raw === "string" ? raw.split(",")[0].trim() : "";
  return first.slice(0, 80) || req.socket?.remoteAddress || "unknown";
}

async function rawBody(req) {
  if (req.body != null && req.body !== "") {
    if (typeof req.body === "string") return req.body;
    if (Buffer.isBuffer(req.body)) return req.body.toString("utf8");
    if (typeof req.body === "object") return JSON.stringify(req.body);
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_MAX) {
      if (typeof req.destroy === "function") req.destroy();
      return null;
    }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export default async function handler(req, res) {
  const method = req.method ?? "GET";
  const length = Number(req.headers?.["content-length"] ?? 0);
  if (method === "POST" && Number.isFinite(length) && length > BODY_MAX) {
    res.statusCode = 413;
    res.setHeader("content-type", "application/json; charset=utf-8");
    res.setHeader("cache-control", "no-store");
    res.end(JSON.stringify({ ok: false, error: "Request is too large." }));
    return;
  }
  let body = "";
  if (method === "POST") {
    const read = await rawBody(req);
    if (read === null) {
      res.statusCode = 413;
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.setHeader("cache-control", "no-store");
      res.end(JSON.stringify({ ok: false, error: "Request is too large." }));
      return;
    }
    body = read;
  }
  const result = await handleTrick({ method, rawBody: body, ip: clientIp(req) });
  res.statusCode = result.status;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.end(JSON.stringify(result.body));
}
