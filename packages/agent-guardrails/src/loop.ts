import type { MessageStore } from "@agent-mouth/core";
import type { GuardrailResult } from "./types.js";

export async function checkLoopProtection(
  ctx: { threadId: string },
  messages: MessageStore,
): Promise<GuardrailResult> {
  const last3 = await messages.lastN(ctx.threadId, 3);
  if (last3.length < 3) return { ok: true };
  const allAgent = last3.every(
    (m) => (m as unknown as { direction: string; sent_by: string | null }).direction === "outbound"
      && (m as unknown as { direction: string; sent_by: string | null }).sent_by === "agent",
  );
  if (allAgent) {
    return { ok: false, reason: "loop_protection:3_agent_outbound" };
  }
  return { ok: true };
}
