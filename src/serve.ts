import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { rootDir } from "./env.js";
import { runServerDryQuote } from "./dry-quote.js";
import { buildPublicState } from "./snapshot.js";
import { BODY_MAX, handleTrick } from "./trick.js";

const port = Number(process.env.PORT ?? 4173);
const web = join(rootDir, "web");
const pages: Record<string, string> = {
  "/": "/index.html",
  "/control": "/control.html",
  "/play": "/play.html",
};
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

function clientIp(req: IncomingMessage): string {
  const forwarded = req.headers["x-forwarded-for"];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = raw?.split(",")[0]?.trim() ?? "";
  return first.slice(0, 80) || req.socket.remoteAddress || "local";
}

function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  const length = Number(req.headers["content-length"] ?? 0);
  if (Number.isFinite(length) && length > limit) {
    req.resume();
    return Promise.resolve(null);
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        resolve(null);
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const pathname = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
  if (pathname === "/api/state") {
    sendJson(res, 200, buildPublicState());
    return;
  }
  if (pathname === "/api/dry-quote") {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "POST" });
      return;
    }
    const result = await runServerDryQuote();
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }
  if (pathname === "/api/trick") {
    const method = req.method ?? "GET";
    let rawBody = "";
    if (method === "POST") {
      const read = await readBody(req, BODY_MAX);
      if (read === null) {
        sendJson(res, 413, { ok: false, error: "Request is too large." });
        return;
      }
      rawBody = read;
    }
    const result = await handleTrick({ method, rawBody, ip: clientIp(req) });
    sendJson(res, result.status, result.body);
    return;
  }
  const page = pages[pathname];
  const path = normalize(page ?? pathname);
  if (path.includes("..")) {
    res.writeHead(400);
    res.end();
    return;
  }
  const file = join(web, path);
  if (!file.startsWith(web) || !existsSync(file) || !extname(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, {
    "content-type": types[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  res.end(readFileSync(file));
});

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Sluice http://127.0.0.1:${port}\n`);
  });
}
