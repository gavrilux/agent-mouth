import { describe, expect, it, vi } from "vitest";
import { sendMessageTool } from "../src/tools/messaging.js";

function makeFakeTransport() {
  return { send: vi.fn(async () => ({ message_id: "x", timestamp: new Date() })) };
}

describe("send_message tool with channel + subject params", () => {
  it("routes to email transport when channel='email'", async () => {
    const tgTransport = makeFakeTransport();
    const emailTransport = makeFakeTransport();
    const registry = { get: (type: "telegram" | "email") => (type === "telegram" ? tgTransport : emailTransport) };

    await sendMessageTool.handler(
      { body: "hi", channel: "email", to: "marco@thecuina.com", subject: "Re: hello" },
      { transport: tgTransport as never, transportRegistry: registry as never } as never,
    );
    expect(emailTransport.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "marco@thecuina.com", body: "hi", subject: "Re: hello",
    }));
    expect(tgTransport.send).not.toHaveBeenCalled();
  });

  it("routes to telegram transport when channel='telegram'", async () => {
    const tgTransport = makeFakeTransport();
    const emailTransport = makeFakeTransport();
    const registry = { get: (type: "telegram" | "email") => (type === "telegram" ? tgTransport : emailTransport) };

    await sendMessageTool.handler(
      { body: "hello", channel: "telegram", to: "618021852" },
      { transport: tgTransport as never, transportRegistry: registry as never } as never,
    );
    expect(tgTransport.send).toHaveBeenCalled();
    expect(emailTransport.send).not.toHaveBeenCalled();
  });

  it("infers channel from reply_to_message_id thread when channel absent", async () => {
    const tgTransport = makeFakeTransport();
    const emailTransport = makeFakeTransport();
    const registry = { get: (type: "telegram" | "email") => (type === "telegram" ? tgTransport : emailTransport) };
    const threadStore = { findById: vi.fn(async () => ({ id: "th1", channel_id: "ch1" })) };
    const channelStore = { findById: vi.fn(async () => ({ id: "ch1", type: "email" as const })) };

    await sendMessageTool.handler(
      { body: "hi", to: "marco@thecuina.com", reply_to_message_id: "th1", subject: "Re: x" },
      { transport: tgTransport as never, transportRegistry: registry as never, threadStore: threadStore as never, channelStore: channelStore as never } as never,
    );
    expect(emailTransport.send).toHaveBeenCalled();
    expect(tgTransport.send).not.toHaveBeenCalled();
  });

  it("falls back to default transport when no channel context", async () => {
    const tgTransport = makeFakeTransport();
    const emailTransport = makeFakeTransport();
    const registry = { get: (type: "telegram" | "email") => (type === "telegram" ? tgTransport : emailTransport) };

    await sendMessageTool.handler(
      { body: "broadcast", to: "broadcast" },
      { transport: tgTransport as never, transportRegistry: registry as never } as never,
    );
    expect(tgTransport.send).toHaveBeenCalled();
    expect(emailTransport.send).not.toHaveBeenCalled();
  });
});
