import type { AgentContext } from "./types.js";

export function buildSystemPrompt(ctx: AgentContext): string {
  const userSystem = ctx.policy.system_prompt || "Eres un asistente útil y conciso.";
  return `${userSystem}

<contact_notes>
${ctx.contact.notes || "(sin notas previas sobre este contacto)"}
</contact_notes>

Reglas de output:
- Responde en el mismo idioma que el mensaje entrante.
- Sé conciso. Sin disculpas innecesarias ni preámbulos.
- Si no estás seguro de la respuesta o el tema te supera, marca should_escalate=true.`;
}

export function buildUserMessages(
  ctx: AgentContext,
): Array<{ role: "user" | "assistant"; content: string }> {
  const msgs = ctx.threadHistory.map((m) => ({
    role: (m.direction === "inbound" ? "user" : "assistant") as "user" | "assistant",
    content: m.content,
  }));
  msgs.push({ role: "user", content: ctx.incomingMessage.content });
  return msgs;
}
