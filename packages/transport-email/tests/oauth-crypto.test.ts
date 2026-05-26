import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "../src/oauth/crypto.js";

const KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 32 bytes

describe("encryptToken / decryptToken", () => {
  it("round-trips a token", () => {
    const plain = "1//abc123refresh_token_value";
    const ct = encryptToken(plain, KEY_HEX);
    expect(ct).not.toBe(plain);
    expect(decryptToken(ct, KEY_HEX)).toBe(plain);
  });

  it("produces different ciphertext per call (random IV)", () => {
    const plain = "secret";
    const ct1 = encryptToken(plain, KEY_HEX);
    const ct2 = encryptToken(plain, KEY_HEX);
    expect(ct1).not.toBe(ct2);
    expect(decryptToken(ct1, KEY_HEX)).toBe(plain);
    expect(decryptToken(ct2, KEY_HEX)).toBe(plain);
  });

  it("throws on wrong key", () => {
    const plain = "secret";
    const ct = encryptToken(plain, KEY_HEX);
    const wrongKey = "ff".repeat(32);
    expect(() => decryptToken(ct, wrongKey)).toThrow();
  });

  it("throws on truncated ciphertext", () => {
    expect(() => decryptToken("aGVsbG8=", KEY_HEX)).toThrow();
  });
});
