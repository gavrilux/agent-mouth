// packages/transport-whatsapp/src/signature.ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Meta's `X-Hub-Signature-256` header against the raw request body.
 * Meta sends `sha256=<hex>` where the hex is HMAC-SHA256(rawBody, appSecret).
 * Comparison is constant-time. Returns false (never throws) on any mismatch
 * or malformed/missing header so the caller can respond 403.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | undefined | null,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  // timingSafeEqual throws if lengths differ; guard first.
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
