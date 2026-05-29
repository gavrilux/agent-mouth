import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaSignature } from "../src/signature.js";

const APP_SECRET = "test_app_secret";
const rawBody = '{"object":"whatsapp_business_account","entry":[]}';

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifyMetaSignature", () => {
  it("accepts a valid signature", () => {
    const header = sign(rawBody, APP_SECRET);
    expect(verifyMetaSignature(rawBody, header, APP_SECRET)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    const header = sign(rawBody, "wrong_secret");
    expect(verifyMetaSignature(rawBody, header, APP_SECRET)).toBe(false);
  });

  it("rejects when the body was tampered with", () => {
    const header = sign(rawBody, APP_SECRET);
    expect(verifyMetaSignature(`${rawBody}x`, header, APP_SECRET)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyMetaSignature(rawBody, undefined, APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(rawBody, "garbage", APP_SECRET)).toBe(false);
  });
});
