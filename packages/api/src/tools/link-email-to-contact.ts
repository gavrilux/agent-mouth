// packages/api/src/tools/link-email-to-contact.ts
import { z } from "zod";
import type { ToolDef } from "../server.js";

export const linkEmailToContactTool: ToolDef = {
  name: "link_email_to_contact",
  description:
    "Register an email address to an existing Contact. Future inbound emails from this address will auto-merge into that Contact instead of creating a duplicate. Useful when you confirm someone's identity mid-conversation.",
  inputSchema: {
    type: "object",
    required: ["contact_id", "email"],
    properties: {
      contact_id: { type: "string", format: "uuid" },
      email: { type: "string", format: "email" },
    },
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const parsed = z
      .object({
        contact_id: z.string().uuid(),
        email: z.string().email(),
      })
      .parse(input);

    if (!ctx.contactStore) throw new Error("contactStore not configured");
    if (!ctx.workspaceId) throw new Error("workspaceId not configured");

    const contact = await ctx.contactStore.addEmailToMetadata(
      ctx.workspaceId,
      parsed.contact_id,
      parsed.email,
    );
    const metadata = (contact.metadata ?? {}) as { email_addresses?: string[] };
    return {
      ok: true,
      contact_id: contact.id,
      email_addresses: metadata.email_addresses ?? [],
    };
  },
};
