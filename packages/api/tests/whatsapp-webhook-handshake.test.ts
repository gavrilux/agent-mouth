import { describe, expect, it } from "vitest";
import { verifyWhatsAppHandshake } from "../src/cli/serve-http.js";

describe("verifyWhatsAppHandshake", () => {
  it("echoes the challenge when mode=subscribe and token matches", () => {
    const url = new URL(
      "http://x/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=12345",
    );
    expect(verifyWhatsAppHandshake(url, "secret")).toBe("12345");
  });

  it("returns null when the verify token does not match", () => {
    const url = new URL(
      "http://x/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345",
    );
    expect(verifyWhatsAppHandshake(url, "secret")).toBeNull();
  });

  it("returns null when mode is not subscribe", () => {
    const url = new URL(
      "http://x/whatsapp-webhook?hub.mode=unsubscribe&hub.verify_token=secret&hub.challenge=12345",
    );
    expect(verifyWhatsAppHandshake(url, "secret")).toBeNull();
  });
});
