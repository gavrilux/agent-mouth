import type { AuditLogStore } from "@agent-mouth/core";
import type { GuardrailResult } from "./types.js";

export async function checkRateLimit(
  ctx: { contactId: string; limit: number },
  audit: AuditLogStore,
): Promise<GuardrailResult> {
  const sinceIso = new Date(Date.now() - 3600_000).toISOString();
  const count = await audit.countSentOrDraftSince(ctx.contactId, sinceIso);
  if (count >= ctx.limit) {
    return { ok: false, reason: `rate_limit:${count}/${ctx.limit}` };
  }
  return { ok: true };
}
