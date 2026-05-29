import { describe, expect, it } from "vitest";
import * as wa from "../src/index.js";

describe("transport-whatsapp public exports", () => {
  it("exports the transport, normalize, signature and schema", () => {
    expect(typeof wa.WhatsAppTransport).toBe("function");
    expect(typeof wa.whatsappMessageToInbound).toBe("function");
    expect(typeof wa.verifyMetaSignature).toBe("function");
    expect(wa.WhatsAppWebhookSchema).toBeDefined();
    expect(wa.WhatsAppTextMessageSchema).toBeDefined();
  });
});
