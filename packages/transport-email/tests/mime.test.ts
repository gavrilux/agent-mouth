import { describe, expect, it } from "vitest";
import { buildMime } from "../src/mime.js";

describe("buildMime", () => {
  it("produces valid RFC822 MIME with required headers", () => {
    const mime = buildMime({
      from_address: "gavrilux.agent@gmail.com",
      to_addresses: ["marco@thecuina.com"],
      subject: "Hello",
      body_text: "Hi Marco",
    });
    expect(mime).toContain("From: gavrilux.agent@gmail.com");
    expect(mime).toContain("To: marco@thecuina.com");
    expect(mime).toContain("Subject: Hello");
    expect(mime).toContain('Content-Type: text/plain; charset="UTF-8"');
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain("\r\n\r\nHi Marco");
  });

  it("includes In-Reply-To + References when given (threading)", () => {
    const mime = buildMime({
      from_address: "a@a.com",
      to_addresses: ["b@b.com"],
      subject: "Re: hi",
      body_text: "yes",
      in_reply_to: "<prev@gmail.com>",
      references: ["<a@gmail.com>", "<prev@gmail.com>"],
    });
    expect(mime).toContain("In-Reply-To: <prev@gmail.com>");
    expect(mime).toContain("References: <a@gmail.com> <prev@gmail.com>");
  });

  it("joins multiple to_addresses with comma", () => {
    const mime = buildMime({
      from_address: "a@a.com",
      to_addresses: ["b@b.com", "c@c.com"],
      subject: "x",
      body_text: "y",
    });
    expect(mime).toContain("To: b@b.com, c@c.com");
  });

  it("includes Cc when provided", () => {
    const mime = buildMime({
      from_address: "a@a.com",
      to_addresses: ["b@b.com"],
      cc_addresses: ["c@c.com"],
      subject: "x",
      body_text: "y",
    });
    expect(mime).toContain("Cc: c@c.com");
  });

  it("encodes non-ASCII subject (RFC 2047)", () => {
    const mime = buildMime({
      from_address: "a@a.com",
      to_addresses: ["b@b.com"],
      subject: "Hola — café",
      body_text: "y",
    });
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?.*\?=/);
  });

  it("uses CRLF line endings", () => {
    const mime = buildMime({
      from_address: "a@a.com",
      to_addresses: ["b@b.com"],
      subject: "x",
      body_text: "y",
    });
    expect(mime.split("\r\n").length).toBeGreaterThan(5);
    expect(mime.includes("\n\n")).toBe(false); // no bare LF blank line
  });
});
