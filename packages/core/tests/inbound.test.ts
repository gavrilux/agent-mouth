// packages/core/tests/inbound.test.ts
import { describe, it, expect } from "vitest";
import { InboundMessageSchema } from "../src/inbound.js";

describe("InboundMessageSchema", () => {
  it("parses a minimal telegram inbound", () => {
    const msg = {
      channel_type: "telegram",
      external_message_id: "42",
      external_thread_id: "-5286864201",
      sender_identifier: "987654321",
      sender_display_name: "Gavrilo",
      sender_handle: null,
      chat_type: "private",
      content: "hola",
      attachments: [],
      raw_payload: { update_id: 1, message: { message_id: 42 } },
      received_at: "2026-05-20T14:46:49Z",
    };
    expect(InboundMessageSchema.parse(msg)).toEqual(msg);
  });

  it("requires content non-empty", () => {
    expect(() =>
      InboundMessageSchema.parse({
        channel_type: "telegram", external_message_id: "1", external_thread_id: "1",
        sender_identifier: "1", sender_display_name: "x", sender_handle: null,
        chat_type: "private", content: "", attachments: [], raw_payload: {},
        received_at: "2026-05-20T00:00:00Z",
      }),
    ).toThrow();
  });
});
