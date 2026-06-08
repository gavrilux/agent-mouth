import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ChannelTypeSchema, type Message, MessageSchema } from "../src/domain";

describe("Domain types", () => {
  it("validates channel types via Zod", () => {
    expect(ChannelTypeSchema.parse("telegram")).toBe("telegram");
    expect(ChannelTypeSchema.parse("email")).toBe("email");
    expect(ChannelTypeSchema.parse("whatsapp")).toBe("whatsapp");
    expect(() => ChannelTypeSchema.parse("carrier-pigeon")).toThrow(z.ZodError);
  });

  it("validates a normalized Message", () => {
    const msg: Message = {
      id: "msg-123",
      thread_id: "thread-1",
      channel_type: "telegram",
      direction: "inbound",
      external_id: "12345",
      sender_identifier: "@marco_bot",
      content: "hola",
      created_at: new Date().toISOString(),
    };
    expect(MessageSchema.parse(msg)).toEqual(msg);
  });
});
