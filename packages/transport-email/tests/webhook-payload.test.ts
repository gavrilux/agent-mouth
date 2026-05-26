import { describe, expect, it } from "vitest";
import { parsePubSubEnvelope } from "../src/webhook/pubsub-payload.js";

const gmailNotif = { emailAddress: "gavrilux.agent@gmail.com", historyId: "12345" };

describe("parsePubSubEnvelope", () => {
  it("decodes base64 data field into Gmail notification", () => {
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(gmailNotif), "utf8").toString("base64"),
        messageId: "1234567890",
        publishTime: "2026-05-25T10:00:00Z",
      },
      subscription: "projects/p/subscriptions/gmail-push-agent-mouth",
    };
    const r = parsePubSubEnvelope(envelope);
    expect(r.email_address).toBe("gavrilux.agent@gmail.com");
    expect(r.history_id).toBe("12345");
    expect(r.pubsub_message_id).toBe("1234567890");
  });

  it("throws on missing message", () => {
    expect(() => parsePubSubEnvelope({})).toThrow();
  });

  it("throws on missing data field", () => {
    expect(() =>
      parsePubSubEnvelope({ message: { messageId: "1" }, subscription: "x" }),
    ).toThrow();
  });

  it("throws on invalid base64", () => {
    expect(() =>
      parsePubSubEnvelope({ message: { data: "!!!not-base64!!!", messageId: "1" }, subscription: "x" }),
    ).toThrow();
  });

  it("throws on payload missing historyId", () => {
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify({ emailAddress: "x@y.com" }), "utf8").toString("base64"),
        messageId: "1",
      },
      subscription: "x",
    };
    expect(() => parsePubSubEnvelope(envelope)).toThrow();
  });
});
