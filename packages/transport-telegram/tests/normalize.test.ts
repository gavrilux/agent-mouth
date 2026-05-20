// packages/transport-telegram/tests/normalize.test.ts
import { describe, it, expect } from "vitest";
import { telegramUpdateToInbound } from "../src/normalize.js";

describe("telegramUpdateToInbound", () => {
  it("normalizes a private text message", () => {
    const update = {
      update_id: 1,
      message: {
        message_id: 42,
        from: { id: 987654321, is_bot: false, first_name: "Gavrilo", username: "gavri" },
        chat: { id: 987654321, type: "private", first_name: "Gavrilo" },
        date: 1779290809,
        text: "hola",
      },
    };
    const out = telegramUpdateToInbound(update);
    expect(out).toMatchObject({
      channel_type: "telegram",
      external_message_id: "42",
      external_thread_id: "987654321",
      sender_identifier: "987654321",
      sender_display_name: "Gavrilo",
      sender_handle: "gavri",
      chat_type: "private",
      content: "hola",
    });
    expect(out!.received_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("normalizes a group message; thread_id is chat.id", () => {
    const update = {
      update_id: 2,
      message: {
        message_id: 99,
        from: { id: 111, is_bot: false, first_name: "Marco" },
        chat: { id: -5286864201, type: "group", title: "The Cuina LAB" },
        date: 1779290900,
        text: "@Gavrilux_bot test",
      },
    };
    const out = telegramUpdateToInbound(update);
    expect(out!.external_thread_id).toBe("-5286864201");
    expect(out!.chat_type).toBe("group");
  });

  it("returns null for non-message updates (e.g. edited_message we skip for Phase 1a)", () => {
    expect(telegramUpdateToInbound({ update_id: 3, edited_message: {} as unknown })).toBeNull();
  });

  it("returns null for messages without text (sticker, etc.)", () => {
    const update = {
      update_id: 4,
      message: { message_id: 50, from: { id: 1, is_bot: false, first_name: "x" }, chat: { id: 1, type: "private" }, date: 0 },
    };
    expect(telegramUpdateToInbound(update)).toBeNull();
  });
});
