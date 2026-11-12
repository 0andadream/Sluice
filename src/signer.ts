/**
 * Chain Signatures helpers for a Base USDC deposit.
 * Nothing here broadcasts. The execute path calls the guarded functions only
 * when --live, LIVE=1, and SLUICE_EXECUTE=yes are all set.
 */

export const BASE_CHAIN_ID = 8453;
export const BASE_USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913";
/** v1.signer.sign requires this deposit. A function-call key cannot attach it. */
export const SIGN_DEPOSIT_YOCTO = "1";
export const MPC_MAINNET = "v1.signer";
export const MPC_TESTNET = "v1.signer-prod.testnet";
export const DEFAULT_DERIVATION_PATH = "base-1";

const KECCAK_RATE = 136;
const MASK = (1n << 64n) - 1n;
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n,
  0x000000000000808bn, 0x0000000080000001n, 0x8000000080008081n, 0x8000000000008009n,
  0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n,
  0x8000000000008002n, 0x8000000000000080n, 0x000000000000800an, 0x800000008000000an,
  0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
/** Lane rotation amounts and the pi permutation, skipping lane 0. From the keccak crate. */
const RHO = [1, 3, 6, 10, 15, 21, 28, 36, 45, 55, 2, 14, 27, 41, 56, 8, 25, 43, 62, 18, 39, 61, 20, 44];
const PI = [10, 7, 11, 17, 18, 3, 5, 16, 8, 21, 24, 4, 15, 23, 19, 13, 12, 2, 20, 14, 22, 9, 6, 1];

function rotl(x: bigint, n: number): bigint {
  const shift = BigInt(n);
  return ((x << shift) | (x >> (64n - shift))) & MASK;
}

function keccakF(state: bigint[]): void {
  for (const rc of RC) {
    const column = [0n, 0n, 0n, 0n, 0n];
    for (let x = 0; x < 5; x++) {
      for (let y = 0; y < 5; y++) column[x] = (column[x]! ^ state[5 * y + x]!) & MASK;
    }
    for (let x = 0; x < 5; x++) {
      const mixed = column[(x + 4) % 5]! ^ rotl(column[(x + 1) % 5]!, 1);
      for (let y = 0; y < 5; y++) state[5 * y + x] = (state[5 * y + x]! ^ mixed) & MASK;
    }
    let last = state[1]!;
    for (let x = 0; x < 24; x++) {
      const next = state[PI[x]!]!;
      state[PI[x]!] = rotl(last, RHO[x]!);
      last = next;
    }
    for (let yStep = 0; yStep < 5; yStep++) {
      const y = 5 * yStep;
      const row = state.slice(y, y + 5);
      for (let x = 0; x < 5; x++) {
        state[y + x] = (row[x]! ^ (~row[(x + 1) % 5]! & row[(x + 2) % 5]!)) & MASK;
      }
    }
    state[0] = (state[0]! ^ rc) & MASK;
  }
}

export function keccak256(data: Uint8Array): Uint8Array {
  const state = new Array<bigint>(25).fill(0n);
  let offset = 0;
  const absorb = (block: Uint8Array): void => {
    for (let i = 0; i < block.length; i++) {
      const lane = i >> 3;
      const shift = BigInt((i & 7) * 8);
      state[lane] = (state[lane]! ^ (BigInt(block[i]!) << shift)) & MASK;
    }
    keccakF(state);
  };
  while (offset + KECCAK_RATE <= data.length) {
    absorb(data.subarray(offset, offset + KECCAK_RATE));
    offset += KECCAK_RATE;
  }
  const tail = new Uint8Array(KECCAK_RATE);
  tail.set(data.subarray(offset));
  const padAt = data.length - offset;
  const last = KECCAK_RATE - 1;
  tail[padAt] = (tail[padAt] ?? 0) ^ 0x01;
  tail[last] = (tail[last] ?? 0) ^ 0x80;
  absorb(tail);
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) {
    const lane = i >> 3;
    const shift = BigInt((i & 7) * 8);
    out[i] = Number((state[lane]! >> shift) & 0xffn);
  }
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function hexToBytes(hex: string): Uint8Array {
  const clean = hex.startsWith("0x") || hex.startsWith("0X") ? hex.slice(2) : hex;
  if (clean.length % 2 !== 0 || /[^0-9a-f]/i.test(clean)) throw new Error("invalid hex");
  const out = new Uint8Array(clean.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(clean.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

export function base58Decode(input: string): Uint8Array {
  let zeros = 0;
  while (input[zeros] === "1") zeros++;
  const bytes: number[] = [];
  for (let i = zeros; i < input.length; i++) {
    const value = BASE58.indexOf(input[i] ?? "");
    if (value < 0) throw new Error("invalid base58");
    let carry = value;
    for (let j = 0; j < bytes.length; j++) {
      carry += bytes[j]! * 58;
      bytes[j] = carry % 256;
      carry = Math.floor(carry / 256);
    }
    while (carry > 0) {
      bytes.push(carry % 256);
      carry = Math.floor(carry / 256);
    }
  }
  const out = new Uint8Array(zeros + bytes.length);
  for (let i = 0; i < bytes.length; i++) out[zeros + i] = bytes[bytes.length - 1 - i]!;
  return out;
}

export function evmAddressFromUncompressed(publicKey: Uint8Array): string {
  if (publicKey.length !== 64) throw new Error("secp256k1 public key must be 64 bytes, x || y");
  return `0x${bytesToHex(keccak256(publicKey).subarray(12))}`;
}

export function parseSecp256k1Key(value: string): Uint8Array {
  const text = value.trim().replaceAll('"', "");
  if (!text.startsWith("secp256k1:")) throw new Error("derived public key is not secp256k1");
  const raw = base58Decode(text.slice("secp256k1:".length));
  if (raw.length !== 64) throw new Error(`derived public key decoded to ${raw.length} bytes, expected 64`);
  return raw;
}

export function mpcContractId(network: string | undefined): string {
  if (network === "mainnet") return MPC_MAINNET;
  return MPC_TESTNET;
}

export type DerivedKeyQuery = {
  rpcUrl: string;
  contractId: string;
  accountId: string;
  path: string;
};

export function derivedKeyRpc(query: DerivedKeyQuery): { method: string; params: Record<string, unknown> } {
  const args = {
    path: query.path,
    predecessor: query.accountId,
    domain_id: 0,
  };
  return {
    method: "query",
    params: {
      request_type: "call_function",
      finality: "final",
      account_id: query.contractId,
      method_name: "derived_public_key",
      args_base64: Buffer.from(JSON.stringify(args), "utf8").toString("base64"),
    },
  };
}

export function readDerivedKeyResult(result: unknown): string {
  if (typeof result !== "object" || result === null || !("result" in result)) {
    throw new Error("NEAR RPC result is missing result bytes");
  }
  const bytes = (result as { result: unknown }).result;
  if (!Array.isArray(bytes) || !bytes.every((item) => typeof item === "number")) {
    throw new Error("NEAR RPC result bytes are missing");
  }
  const text = Buffer.from(bytes).toString("utf8");
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "string") throw new Error("derived_public_key did not return a string");
  return parsed;
}

export async function deriveBaseAddress(
  query: DerivedKeyQuery,
  fetchImpl: typeof fetch = fetch,
): Promise<{ publicKey: string; address: string }> {
  const body = derivedKeyRpc(query);
  const response = await fetchImpl(query.rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: "sluice", ...body }),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`NEAR RPC ${response.status}`);
  const payload: unknown = await response.json();
  if (typeof payload !== "object" || payload === null || !("result" in payload)) {
    throw new Error("NEAR RPC response has no result");
  }
  const publicKey = readDerivedKeyResult((payload as { result: unknown }).result);
  return { publicKey, address: evmAddressFromUncompressed(parseSecp256k1Key(publicKey)) };
}

function concat(parts: Uint8Array[]): Uint8Array {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function rlpLength(offset: number, length: number): Uint8Array {
  if (length < 56) return Uint8Array.of(offset + length);
  let hex = length.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  const lenBytes = hexToBytes(hex);
  return concat([Uint8Array.of(offset + 55 + lenBytes.length), lenBytes]);
}

function rlpBytes(data: Uint8Array): Uint8Array {
  if (data.length === 1 && data[0]! < 0x80) return data;
  return concat([rlpLength(0x80, data.length), data]);
}

function rlpList(items: Uint8Array[]): Uint8Array {
  const payload = concat(items);
  return concat([rlpLength(0xc0, payload.length), payload]);
}

function rlpUint(value: bigint): Uint8Array {
  if (value < 0n) throw new Error("rlp uint is negative");
  if (value === 0n) return rlpBytes(new Uint8Array());
  let hex = value.toString(16);
  if (hex.length % 2) hex = `0${hex}`;
  return rlpBytes(hexToBytes(hex));
}

export function transferSelector(): Uint8Array {
  return keccak256(new TextEncoder().encode("transfer(address,uint256)")).subarray(0, 4);
}

export function encodeErc20Transfer(to: string, amount: bigint): Uint8Array {
  if (!/^0x[0-9a-fA-F]{40}$/.test(to)) throw new Error("transfer recipient is not an 0x address");
  if (amount < 0n) throw new Error("transfer amount is negative");
  const word = new Uint8Array(32);
  const amountHex = amount.toString(16).padStart(64, "0");
  word.set(hexToBytes(amountHex));
  const address = new Uint8Array(32);
  address.set(hexToBytes(to.slice(2)), 12);
  return concat([transferSelector(), address, word]);
}

export type UnsignedBaseTransfer = {
  chainId: number;
  nonce: bigint;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  gasLimit: bigint;
  to: string;
  data: Uint8Array;
  /** keccak256(0x02 || rlp(eip-1559 fields)). This is the MPC payload. */
  payloadHash: Uint8Array;
  /** Hex of the unsigned typed transaction, without a signature. */
  unsigned: string;
};

export function unsignedEip1559(input: Omit<UnsignedBaseTransfer, "payloadHash" | "unsigned">): UnsignedBaseTransfer {
  if (!/^0x[0-9a-fA-F]{40}$/.test(input.to)) throw new Error("transaction to is not an 0x address");
  const encoded = rlpList([
    rlpUint(BigInt(input.chainId)),
    rlpUint(input.nonce),
    rlpUint(input.maxPriorityFeePerGas),
    rlpUint(input.maxFeePerGas),
    rlpUint(input.gasLimit),
    rlpBytes(hexToBytes(input.to)),
    rlpUint(0n),
    rlpBytes(input.data),
    rlpList([]),
  ]);
  const signing = concat([Uint8Array.of(0x02), encoded]);
  return {
    ...input,
    payloadHash: keccak256(signing),
    unsigned: `0x02${bytesToHex(encoded)}`,
  };
}

export function usdcDepositCall(input: {
  depositAddress: string;
  amount: bigint;
  nonce: bigint;
  maxPriorityFeePerGas?: bigint;
  maxFeePerGas?: bigint;
  gasLimit?: bigint;
}): UnsignedBaseTransfer {
  return unsignedEip1559({
    chainId: BASE_CHAIN_ID,
    nonce: input.nonce,
    maxPriorityFeePerGas: input.maxPriorityFeePerGas ?? 1_000_000n,
    maxFeePerGas: input.maxFeePerGas ?? 20_000_000n,
    gasLimit: input.gasLimit ?? 80_000n,
    to: BASE_USDC,
    data: encodeErc20Transfer(input.depositAddress, input.amount),
  });
}

/** Args for v1.signer `sign`. domain_id 0 is the legacy secp256k1 domain. */
export function mpcSignRequest(payloadHash: Uint8Array, path = DEFAULT_DERIVATION_PATH): {
  request: { path: string; domain_id: number; payload_v2: { Ecdsa: string } };
} {
  if (payloadHash.length !== 32) throw new Error("ECDSA payload must be 32 bytes");
  return {
    request: {
      path,
      domain_id: 0,
      payload_v2: { Ecdsa: bytesToHex(payloadHash) },
    },
  };
}

export function liveArmed(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LIVE === "1" && env.SLUICE_EXECUTE === "yes";
}

export function assertArmed(env: NodeJS.ProcessEnv = process.env): void {
  if (!liveArmed(env)) {
    throw new Error("Refusing to sign or broadcast. LIVE=1 and SLUICE_EXECUTE=yes are required, and this process did not set them.");
  }
}
