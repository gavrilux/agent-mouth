import { describe, expect, it } from "vitest";
import { WhatsAppWebhookSchema, WhatsAppTextMessageSchema } from "../src/schema.js";

const textWebhook = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: "PNID", display_phone_number: "34999999999" },
            contacts: [{ profile: { name: "Marco" }, wa_id: "34611111111" }],
            messages: [
              { from: "34611111111", id: "wamid.ABC", timestamp: "1716638400", type: "text", text: { body: "hola" } },
            ],
          },
        },
      ],
    },
  ],
};

const statusWebhook = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: "PNID" },
            statuses: [{ id: "wamid.XYZ", status: "delivered" }],
          },
        },
      ],
    },
  ],
};

describe("WhatsAppWebhookSchema", () => {
  it("parses a valid text-message webhook", () => {
    const parsed = WhatsAppWebhookSchema.safeParse(textWebhook);
    expect(parsed.success).toBe(true);
  });

  it("parses a status-only event (no messages)", () => {
    const parsed = WhatsAppWebhookSchema.safeParse(statusWebhook);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const value = parsed.data.entry[0]!.changes[0]!.value;
      expect(value.messages).toBeUndefined();
      expect(value.statuses).toBeDefined();
    }
  });

  it("rejects a malformed payload (wrong object)", () => {
    const parsed = WhatsAppWebhookSchema.safeParse({ object: "page", entry: [] });
    expect(parsed.success).toBe(false);
  });
});

describe("WhatsAppTextMessageSchema", () => {
  it("recognizes a text message", () => {
    const msg = { from: "34611111111", id: "wamid.ABC", timestamp: "1716638400", type: "text", text: { body: "hi" } };
    expect(WhatsAppTextMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects a non-text message (image)", () => {
    const msg = { from: "34611111111", id: "wamid.IMG", timestamp: "1716638400", type: "image", image: { id: "media1" } };
    expect(WhatsAppTextMessageSchema.safeParse(msg).success).toBe(false);
  });
});
