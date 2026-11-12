import { loadDeployment } from "./snapshot.js";

/** Public testnet JSON-RPC only. preview is a view: no key, no signature, no state change. */
export const TESTNET_RPCS = ["https://rpc.testnet.near.org", "https://test.rpc.fastnear.com"] as const;

const UNAVAILABLE = "The contract check was unavailable.";

export type PreviewArgs = {
  from_chain: string;
  to_chain: string;
  asset: string;
  amount_usd_cents: number;
  from_project: string;
  to_project: string;
  recipient: string;
  source_apy_ppm: number;
  dest_apy_ppm: number;
};

export type PreviewCall = {
  available: true;
  approved: boolean;
  reasons: string[];
  grossSpreadBps: number | null;
  netSpreadBps: number | null;
  contractId: string;
  network: "testnet";
  method: "preview";
};

export type PreviewMiss = {
  available: false;
  approved: null;
  reasons: string[];
  grossSpreadBps: null;
  netSpreadBps: null;
  contractId: string | null;
  network: "testnet";
  method: "preview";
  error: string;
};

export type PreviewOutcome = PreviewCall | PreviewMiss;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isTestnetAccount(id: string): boolean {
  return /^[a-z0-9][a-z0-9._-]{0,62}\.testnet$/.test(id);
}

export function testnetContractId(): string | null {
  const deployment = loadDeployment();
  if (!deployment || deployment.network !== "testnet") return null;
  if (!isTestnetAccount(deployment.contractId)) return null;
  return deployment.contractId;
}

function miss(contractId: string | null): PreviewMiss {
  return {
    available: false,
    approved: null,
    reasons: [],
    grossSpreadBps: null,
    netSpreadBps: null,
    contractId,
    network: "testnet",
    method: "preview",
    error: UNAVAILABLE,
  };
}

function decodeBytes(value: unknown): unknown {
  try {
    if (Array.isArray(value)) {
      if (value.length > 20_000) return null;
      const bytes = new Uint8Array(value.length);
      for (let i = 0; i < value.length; i++) {
        const byte = value[i];
        if (typeof byte !== "number" || !Number.isInteger(byte) || byte < 0 || byte > 255) return null;
        bytes[i] = byte;
      }
      return JSON.parse(Buffer.from(bytes).toString("utf8"));
    }
    if (typeof value === "string" && value.length > 0 && value.length < 40_000) {
      return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
    }
  } catch {
    return null;
  }
  return null;
}

function readDecision(body: unknown): Omit<PreviewCall, "contractId" | "network" | "method"> | null {
  if (!isRecord(body) || body.error != null || !isRecord(body.result)) return null;
  if (typeof body.result.error === "string") return null;
  const decoded = decodeBytes(body.result.result);
  if (!isRecord(decoded) || typeof decoded.approved !== "boolean" || !Array.isArray(decoded.reasons)) return null;
  const reasons: string[] = [];
  for (const reason of decoded.reasons) {
    if (typeof reason !== "string") return null;
    reasons.push(reason.slice(0, 300));
    if (reasons.length === 12) break;
  }
  const gross = decoded.gross_spread_bps;
  const net = decoded.net_spread_bps;
  return {
    available: true,
    approved: decoded.approved,
    reasons,
    grossSpreadBps: typeof gross === "number" && Number.isFinite(gross) ? gross : null,
    netSpreadBps: typeof net === "number" && Number.isFinite(net) ? net : null,
  };
}

function rpcBody(contractId: string, args: PreviewArgs): string {
  return JSON.stringify({
    jsonrpc: "2.0",
    id: "sluice-preview",
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: contractId,
      method_name: "preview",
      args_base64: Buffer.from(JSON.stringify({ proposal: args }), "utf8").toString("base64"),
    },
  });
}

/**
 * Calls `preview` through a testnet query. The URL, method, and account are fixed here.
 * Callers cannot choose a host, a contract, or a method.
 */
export async function previewOnTestnet(args: PreviewArgs, fetchImpl: typeof fetch = fetch): Promise<PreviewOutcome> {
  const contractId = testnetContractId();
  if (!contractId) return miss(null);
  const body = rpcBody(contractId, args);
  for (const endpoint of TESTNET_RPCS) {
    const host = new URL(endpoint).hostname;
    if (host !== "rpc.testnet.near.org" && host !== "test.rpc.fastnear.com") continue;
    try {
      const response = await fetchImpl(endpoint, {
        method: "POST",
        redirect: "error",
        headers: { "content-type": "application/json", accept: "application/json" },
        body,
        signal: AbortSignal.timeout(6_000),
      });
      if (!response.ok) continue;
      const decision = readDecision(await response.json());
      if (!decision) continue;
      return { ...decision, contractId, network: "testnet", method: "preview" };
    } catch {
      continue;
    }
  }
  return miss(contractId);
}
