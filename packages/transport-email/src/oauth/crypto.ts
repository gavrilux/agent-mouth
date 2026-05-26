import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;       // 96 bits — recommended for GCM
const TAG_LEN = 16;      // 128 bits

function keyToBuffer(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("AGENT_MOUTH_TOKEN_ENCRYPTION_KEY must be 32 bytes hex (64 chars)");
  }
  return Buffer.from(hex, "hex");
}

/**
 * AES-256-GCM encrypt. Output format: base64(iv || ciphertext || authTag).
 * Different IV per call → ciphertext is non-deterministic.
 */
export function encryptToken(plaintext: string, keyHex: string): string {
  const key = keyToBuffer(keyHex);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/**
 * Reverse of encryptToken. Throws on wrong key, truncated input, or tampered ciphertext.
 */
export function decryptToken(b64: string, keyHex: string): string {
  const key = keyToBuffer(keyHex);
  const buf = Buffer.from(b64, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
