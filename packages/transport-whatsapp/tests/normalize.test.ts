import { describe, expect, it } from "vitest";
import { whatsappMessageToInbound } from "../src/normalize.js";

function value(overrides: Record<string, unknown> = {}) {
  return {
    messaging_product: "whatsapp",
    metadata: { phone_number_id: "PNID", display_phone_number: "34999999999" },
    contacts: [{ profile: { name: "Marco" }, wa_id: "34611111111" }],
    messages: [
      { from: "34611111111", id: "wamid.ABC", timestamp: "1716638400", type: "text", text: { body: "hola" } },
    ],
    ...overrides,
  };
}

describe("whatsappMessageToInbound", () => {
  it("normalizes a single text message into one InboundMessage", () => {
    const v = value();
    const out = whatsappMessageToInbound(v, "ch-whatsapp-uuid");
    expect(out).toHaveLength(1);
    const m = out[0]!;
    expect(m.channel_type).toBe("whatsapp");
    expect(m.external_message_id).toBe("wamid.ABC");
    expect(m.external_thread_id).toBe("34611111111");
    expect(m.sender_identifier).toBe("34611111111");
    expect(m.sender_display_name).toBe("Marco");
    expect(m.sender_handle).toBeNull();
    expect(m.chat_type).toBe("private");
    expect(m.content).toBe("hola");
    expect(m.attachments).toEqual([]);
    expect(m.received_at).toBe(new Date(1716638400 * 1000).toISOString());
  });

  it("normalizes multiple text messages in one payload", () => {
    const v = value({
      messages: [
        { from: "34611111111", id: "wamid.A", timestamp: "1716638400", type: "text", text: { body: "uno" } },
        { from: "34611111111", id: "wamid.B", timestamp: "1716638401", type: "text", text: { body: "dos" } },
      ],
    });
    const out = whatsappMessageToInbound(v, "ch");
    expect(out.map((m) => m.external_message_id)).toEqual(["wamid.A", "wamid.B"]);
    expect(out.map((m) => m.content)).toEqual(["uno", "dos"]);
  });

  it("returns [] for a status-only event (no messages)", () => {
    const v = value({ messages: undefined, statuses: [{ id: "wamid.S", status: "read" }] });
    expect(whatsappMessageToInbound(v, "ch")).toEqual([]);
  });

  it("skips non-text messages (image)", () => {
    const v = value({
      messages: [
        { from: "34611111111", id: "wamid.IMG", timestamp: "1716638400", type: "image", image: { id: "media1" } },
        { from: "34611111111", id: "wamid.TXT", timestamp: "1716638401", type: "text", text: { body: "ok" } },
      ],
    });
    const out = whatsappMessageToInbound(v, "ch");
    expect(out).toHaveLength(1);
    expect(out[0]!.external_message_id).toBe("wamid.TXT");
  });

  it("tolerates a missing contact name (falls back to wa_id)", () => {
    const v = value({ contacts: [{ wa_id: "34611111111" }] });
    const out = whatsappMessageToInbound(v, "ch");
    expect(out[0]!.sender_display_name).toBe("34611111111");
  });
});
