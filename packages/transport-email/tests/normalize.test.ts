import { describe, expect, it } from "vitest";
import { gmailMessageToInbound, gmailMessageToNormalized } from "../src/normalize.js";

// Real-shaped Gmail API payload (users.messages.get format=full)
const gmailMsg = {
  id: "abc123",
  threadId: "thr456",
  labelIds: ["INBOX"],
  internalDate: "1716638400000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Marco <marco@thecuina.com>" },
      { name: "To", value: "gavrilux.agent@gmail.com" },
      { name: "Subject", value: "Hello" },
      { name: "Date", value: "Mon, 25 May 2026 10:00:00 +0200" },
      { name: "Message-ID", value: "<msg123@mail.thecuina.com>" },
      { name: "In-Reply-To", value: "<prev@gmail.com>" },
      { name: "References", value: "<a@gmail.com> <b@gmail.com>" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: { data: Buffer.from("Hi Gavrilux", "utf8").toString("base64url") },
      },
      {
        mimeType: "text/html",
        body: { data: Buffer.from("<p>Hi Gavrilux</p>", "utf8").toString("base64url") },
      },
    ],
  },
};

describe("gmailMessageToNormalized", () => {
  it("extracts headers + plaintext body", () => {
    const n = gmailMessageToNormalized(gmailMsg as never);
    expect(n.external_id).toBe("abc123");
    expect(n.external_thread_id).toBe("thr456");
    expect(n.from_address).toBe("marco@thecuina.com");
    expect(n.from_name).toBe("Marco");
    expect(n.to_addresses).toEqual(["gavrilux.agent@gmail.com"]);
    expect(n.subject).toBe("Hello");
    expect(n.body_text).toBe("Hi Gavrilux");
    expect(n.body_html).toBe("<p>Hi Gavrilux</p>");
    expect(n.message_id_header).toBe("<msg123@mail.thecuina.com>");
    expect(n.in_reply_to_header).toBe("<prev@gmail.com>");
    expect(n.references_header).toEqual(["<a@gmail.com>", "<b@gmail.com>"]);
  });

  it("handles text/plain only body", () => {
    const msg = {
      id: "x",
      threadId: "y",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "x@x.com" },
          { name: "To", value: "y@y.com" },
          { name: "Subject", value: "" },
          { name: "Date", value: "Mon, 25 May 2026 10:00:00 +0200" },
          { name: "Message-ID", value: "<a@b>" },
        ],
        body: { data: Buffer.from("just text", "utf8").toString("base64url") },
      },
    };
    const n = gmailMessageToNormalized(msg as never);
    expect(n.body_text).toBe("just text");
    expect(n.body_html).toBeNull();
  });

  it("falls back to HTML stripped of tags when no plaintext", () => {
    const msg = {
      id: "x",
      threadId: "y",
      payload: {
        mimeType: "text/html",
        headers: [
          { name: "From", value: "x@x.com" },
          { name: "To", value: "y@y.com" },
          { name: "Subject", value: "" },
          { name: "Date", value: "Mon, 25 May 2026 10:00:00 +0200" },
          { name: "Message-ID", value: "<a@b>" },
        ],
        body: { data: Buffer.from("<b>Hello</b> world", "utf8").toString("base64url") },
      },
    };
    const n = gmailMessageToNormalized(msg as never);
    expect(n.body_text).toBe("Hello world");
    expect(n.body_html).toBe("<b>Hello</b> world");
  });

  it("parses From with bare address (no name)", () => {
    const msg = {
      ...gmailMsg,
      payload: {
        ...gmailMsg.payload,
        headers: [
          { name: "From", value: "marco@thecuina.com" },
          ...gmailMsg.payload.headers.filter((h) => h.name !== "From"),
        ],
      },
    };
    const n = gmailMessageToNormalized(msg as never);
    expect(n.from_address).toBe("marco@thecuina.com");
    expect(n.from_name).toBeNull();
  });

  it("splits multi-recipient To header", () => {
    const msg = {
      ...gmailMsg,
      payload: {
        ...gmailMsg.payload,
        headers: [
          ...gmailMsg.payload.headers.filter((h) => h.name !== "To"),
          { name: "To", value: "a@a.com, b@b.com" },
        ],
      },
    };
    const n = gmailMessageToNormalized(msg as never);
    expect(n.to_addresses).toEqual(["a@a.com", "b@b.com"]);
  });
});

describe("gmailMessageToInbound", () => {
  it("wraps NormalizedEmail into InboundMessage", () => {
    const inbound = gmailMessageToInbound(gmailMsg as never, "channel-uuid-123");
    expect(inbound.channel_type).toBe("email");
    expect(inbound.external_message_id).toBe("abc123");
    expect(inbound.external_thread_id).toBe("thr456");
    expect(inbound.sender_identifier).toBe("marco@thecuina.com");
    expect(inbound.sender_display_name).toBe("Marco");
    expect(inbound.sender_handle).toBeNull();
    expect(inbound.chat_type).toBe("private");
    expect(inbound.content).toBe("Hi Gavrilux");
    expect(inbound.attachments).toEqual([]);
  });

  it("lower-cases sender_identifier", () => {
    const msg = {
      ...gmailMsg,
      payload: {
        ...gmailMsg.payload,
        headers: [
          ...gmailMsg.payload.headers.filter((h) => h.name !== "From"),
          { name: "From", value: "Marco <Marco@TheCuina.com>" },
        ],
      },
    };
    const inbound = gmailMessageToInbound(msg as never, "ch");
    expect(inbound.sender_identifier).toBe("marco@thecuina.com");
  });
});
