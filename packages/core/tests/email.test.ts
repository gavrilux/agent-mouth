import { describe, expect, it } from "vitest";
import {
  EmailTokenSchema,
  NormalizedEmailSchema,
} from "../src/email.js";
import { ContactSchema } from "../src/identity.js";

describe("EmailTokenSchema", () => {
  const base = {
    id: "00000000-0000-0000-0000-000000000001",
    workspace_id: "00000000-0000-0000-0000-000000000002",
    channel_id: "00000000-0000-0000-0000-000000000003",
    email_address: "gavrilux.agent@gmail.com",
    refresh_token_encrypted: "base64ciphertext",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    last_history_id: "12345",
    watch_expiration: "2026-06-01T00:00:00.000Z",
    status: "active" as const,
    last_error: null,
    consecutive_renewal_failures: 0,
    created_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
  };

  it("accepts a valid row", () => {
    expect(EmailTokenSchema.parse(base)).toEqual(base);
  });

  it("defaults status to active", () => {
    const { status: _s, ...rest } = base;
    const parsed = EmailTokenSchema.parse(rest);
    expect(parsed.status).toBe("active");
  });

  it("rejects invalid email", () => {
    expect(() => EmailTokenSchema.parse({ ...base, email_address: "not-email" })).toThrow();
  });
});

describe("NormalizedEmailSchema", () => {
  const base = {
    external_id: "abc123",
    external_thread_id: "thr456",
    from_address: "marco@thecuina.com",
    from_name: "Marco",
    to_addresses: ["gavrilux.agent@gmail.com"],
    cc_addresses: [],
    subject: "Hello",
    body_text: "Hi Gavrilux",
    body_html: null,
    message_id_header: "<msg123@gmail.com>",
    in_reply_to_header: null,
    references_header: [],
    received_at: "2026-05-25T10:00:00.000Z",
  };

  it("accepts valid", () => {
    expect(NormalizedEmailSchema.parse(base)).toEqual(base);
  });

  it("defaults cc_addresses to empty array", () => {
    const { cc_addresses: _, ...rest } = base;
    expect(NormalizedEmailSchema.parse(rest).cc_addresses).toEqual([]);
  });

  it("rejects invalid from_address", () => {
    expect(() => NormalizedEmailSchema.parse({ ...base, from_address: "x" })).toThrow();
  });
});

describe("ContactSchema.metadata", () => {
  const baseContact = {
    id: "00000000-0000-0000-0000-000000000001",
    workspace_id: "00000000-0000-0000-0000-000000000002",
    display_name: "Marco",
    notes: "",
    created_at: "2026-05-25T00:00:00.000Z",
  };

  it("defaults metadata with email_addresses to empty array when absent", () => {
    const parsed = ContactSchema.parse(baseContact);
    expect(parsed.metadata).toEqual({ email_addresses: [] });
  });

  it("accepts email_addresses array", () => {
    const parsed = ContactSchema.parse({
      ...baseContact,
      metadata: { email_addresses: ["marco@thecuina.com"] },
    });
    expect(parsed.metadata.email_addresses).toEqual(["marco@thecuina.com"]);
  });

  it("passthrough unknown metadata keys", () => {
    const parsed = ContactSchema.parse({
      ...baseContact,
      metadata: { email_addresses: [], custom_field: "x" },
    });
    expect((parsed.metadata as Record<string, unknown>).custom_field).toBe("x");
  });
});
