import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  base58Decode,
  bytesToHex,
  encodeErc20Transfer,
  evmAddressFromUncompressed,
  hexToBytes,
  keccak256,
  liveArmed,
  mpcSignRequest,
  parseSecp256k1Key,
  transferSelector,
  usdcDepositCall,
} from "./signer.js";

describe("keccak and addresses", () => {
  it("hashes the empty string", () => {
    assert.equal(
      bytesToHex(keccak256(new Uint8Array())),
      "c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    );
  });

  it("uses the ERC-20 transfer selector", () => {
    assert.equal(bytesToHex(transferSelector()), "a9059cbb");
  });

  it("derives the address of secp256k1 private key 1", () => {
    const x = "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798";
    const y = "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8";
    const address = evmAddressFromUncompressed(hexToBytes(x + y));
    assert.equal(address, "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });

  it("decodes base58", () => {
    assert.equal(Buffer.from(base58Decode("Cn8eVZg")).toString("utf8"), "hello");
  });

  it("parses a secp256k1 near public key back to 64 bytes", () => {
    const raw = hexToBytes(
      "79be667ef9dcbbac55a06295ce870b07029bfcdb2dce28d959f2815b16f81798" +
        "483ada7726a3c4655da4fbfc0e1108a8fd17b448a68554199c47d08ffb10d4b8",
    );
    const alphabet = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
    let digits = [0];
    for (const byte of raw) {
      let carry = byte;
      for (let i = 0; i < digits.length; i++) {
        carry += digits[i]! * 256;
        digits[i] = carry % 58;
        carry = Math.floor(carry / 58);
      }
      while (carry > 0) {
        digits.push(carry % 58);
        carry = Math.floor(carry / 58);
      }
    }
    const encoded = digits.reverse().map((digit) => alphabet[digit]!).join("");
    const parsed = parseSecp256k1Key(`secp256k1:${encoded}`);
    assert.deepEqual(parsed, raw);
    assert.equal(evmAddressFromUncompressed(parsed), "0x7e5f4552091a69125d5dfcb7b8c2659029395bdf");
  });
});

describe("base usdc deposit", () => {
  it("encodes transfer calldata and an eip-1559 payload", () => {
    const data = encodeErc20Transfer("0x1111111111111111111111111111111111111111", 10_000_000n);
    assert.equal(data.length, 68);
    assert.equal(bytesToHex(data.subarray(0, 4)), "a9059cbb");
    assert.equal(bytesToHex(data.subarray(16, 36)), "1111111111111111111111111111111111111111");
    const tx = usdcDepositCall({
      depositAddress: "0x2222222222222222222222222222222222222222",
      amount: 10_000_000n,
      nonce: 0n,
    });
    assert.equal(tx.chainId, 8453);
    assert.equal(tx.to, "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    assert.equal(tx.payloadHash.length, 32);
    assert.equal(tx.unsigned.startsWith("0x02"), true);
    const request = mpcSignRequest(tx.payloadHash, "base-1");
    assert.equal(request.request.domain_id, 0);
    assert.equal(request.request.path, "base-1");
    assert.equal(request.request.payload_v2.Ecdsa.length, 64);
  });

  it("refuses to treat an unarmed process as live", () => {
    assert.equal(liveArmed({}), false);
    assert.equal(liveArmed({ LIVE: "1" }), false);
    assert.equal(liveArmed({ LIVE: "1", SLUICE_EXECUTE: "yes" }), true);
  });
});
