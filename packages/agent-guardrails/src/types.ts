export type GuardrailResult = { ok: true } | { ok: false; reason: string; escalate?: boolean };
