import { describe, expect, it, vi } from "vitest";
import { sendMessageTool } from "../src/tools/messaging.js";

function makeFakeTransport() {
  return { send: vi.fn(async () => ({ message_id: "x", timestamp: new Date() })) };
}

describe("send_message tool with channel='whatsapp'", () => {
  it("routes to the whatsapp transport when channel='whatsapp'", async () => {
    const tgTransport = makeFakeTransport();
    const waTransport = makeFakeTransport();
    const registry = {
      get: (type: "telegram" | "email" | "whatsapp") => (type === "whatsapp" ? waTransport : tgTransport),
    };

    await sendMessageTool.handler(
      { body: "hola", channel: "whatsapp", to: "34611111111" },
      { transport: tgTransport as never, transportRegistry: registry as never } as never,
    );
    expect(waTransport.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "34611111111", body: "hola" }),
    );
    expect(tgTransport.send).not.toHaveBeenCalled();
  });

  it("infers whatsapp from the reply_to thread's channel", async () => {
    const tgTransport = makeFakeTransport();
    const waTransport = makeFakeTransport();
    const registry = {
      get: (type: "telegram" | "email" | "whatsapp") => (type === "whatsapp" ? waTransport : tgTransport),
    };
    const threadStore = { findById: vi.fn(async () => ({ id: "th1", channel_id: "ch1" })) };
    const channelStore = { findById: vi.fn(async () => ({ id: "ch1", type: "whatsapp" as const })) };

    await sendMessageTool.handler(
      { body: "hola", to: "34611111111", reply_to_message_id: "th1" },
      {
        transport: tgTransport as never,
        transportRegistry: registry as never,
        threadStore: threadStore as never,
        channelStore: channelStore as never,
      } as never,
    );
    expect(waTransport.send).toHaveBeenCalled();
    expect(tgTransport.send).not.toHaveBeenCalled();
  });

  it("ignores `subject` for whatsapp (passes it through harmlessly)", async () => {
    const tgTransport = makeFakeTransport();
    const waTransport = makeFakeTransport();
    const registry = {
      get: (type: "telegram" | "email" | "whatsapp") => (type === "whatsapp" ? waTransport : tgTransport),
    };

    await sendMessageTool.handler(
      { body: "hola", channel: "whatsapp", to: "34611111111", subject: "ignored" },
      { transport: tgTransport as never, transportRegistry: registry as never } as never,
    );
    // The transport receives subject but WhatsAppTransport.send ignores it; the tool must still route correctly.
    expect(waTransport.send).toHaveBeenCalled();
  });
});
