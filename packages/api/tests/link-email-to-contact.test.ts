import { describe, expect, it, vi } from "vitest";
import { linkEmailToContactTool } from "../src/tools/link-email-to-contact.js";

describe("link_email_to_contact", () => {
  it("calls contactStore.addEmailToMetadata with lowercase email", async () => {
    const addEmailToMetadata = vi.fn(async () => ({
      id: "00000000-0000-0000-0000-000000000001",
      workspace_id: "00000000-0000-0000-0000-000000000002",
      display_name: "Marco",
      notes: "",
      metadata: { email_addresses: ["marco@thecuina.com"] },
      created_at: "2026-05-25T00:00:00.000Z",
    }));

    const r = await linkEmailToContactTool.handler(
      { contact_id: "00000000-0000-0000-0000-000000000001", email: "Marco@TheCuina.com" },
      {
        contactStore: { addEmailToMetadata } as never,
        workspaceId: "00000000-0000-0000-0000-000000000002",
      } as never,
    );
    expect(addEmailToMetadata).toHaveBeenCalledWith(
      "00000000-0000-0000-0000-000000000002",
      "00000000-0000-0000-0000-000000000001",
      "Marco@TheCuina.com",
    );
    expect((r as { ok: boolean }).ok).toBe(true);
  });

  it("rejects malformed email", async () => {
    await expect(
      linkEmailToContactTool.handler(
        { contact_id: "00000000-0000-0000-0000-000000000001", email: "not-an-email" },
        {
          contactStore: { addEmailToMetadata: vi.fn() } as never,
          workspaceId: "00000000-0000-0000-0000-000000000002",
        } as never,
      ),
    ).rejects.toThrow();
  });

  it("rejects malformed contact_id", async () => {
    await expect(
      linkEmailToContactTool.handler({ contact_id: "not-uuid", email: "x@y.com" }, {
        contactStore: { addEmailToMetadata: vi.fn() } as never,
        workspaceId: "00000000-0000-0000-0000-000000000002",
      } as never),
    ).rejects.toThrow();
  });
});
