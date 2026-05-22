import type { GuardrailResult } from "./types.js";

export function checkEscalateTriggers(text: string, patterns: string[]): GuardrailResult {
  for (const p of patterns) {
    if (!p) continue;
    try {
      if (new RegExp(p, "i").test(text)) {
        return { ok: false, escalate: true, reason: `escalate_trigger:${p}` };
      }
    } catch {
      // invalid regex pattern — skip
    }
  }
  return { ok: true };
}
