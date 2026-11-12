import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import { pathToFileURL } from "node:url";
import { rootDir } from "./env.js";
import { runServerDryQuote } from "./dry-quote.js";
import { buildPublicState } from "./snapshot.js";

const port = Number(process.env.PORT ?? 4173);
const web = join(rootDir, "web");
const types: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
};

function sendJson(res: import("node:http").ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(text);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/api/state") {
    sendJson(res, 200, buildPublicState());
    return;
  }
  if (url.pathname === "/api/dry-quote") {
    if (req.method !== "POST") {
      sendJson(res, 405, { ok: false, error: "POST" });
      return;
    }
    const result = await runServerDryQuote();
    sendJson(res, result.ok ? 200 : 400, result);
    return;
  }
  const path = normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  if (path.includes("..")) {
    res.writeHead(400);
    res.end();
    return;
  }
  const file = join(web, path);
  if (!file.startsWith(web) || !existsSync(file)) {
    res.writeHead(404);
    res.end("not found");
    return;
  }
  res.writeHead(200, { "content-type": types[extname(file)] ?? "application/octet-stream" });
  res.end(readFileSync(file));
});

const invoked = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`Sluice control http://127.0.0.1:${port}\n`);
  });
}
