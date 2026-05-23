import type { GuardrailResult } from "./types.js";

export function checkForbiddenTopics(text: string, patterns: string[]): GuardrailResult {
  for (const p of patterns) {
    if (!p) continue;
    try {
      if (new RegExp(p, "i").test(text)) {
        return { ok: false, reason: `forbidden_topic:${p}` };
      }
    } catch {
      // invalid regex pattern — skip
    }
  }
  return { ok: true };
}
