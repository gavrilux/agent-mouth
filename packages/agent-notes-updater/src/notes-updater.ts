import type {
  AuditLogStore, ContactStore, MessageStore, ThreadStore,
} from "@agent-mouth/core";
import type { AgentRuntime, AgentContext } from "@agent-mouth/agent-runtime";

export interface NotesUpdaterDeps {
  runtime: AgentRuntime;
  threads: ThreadStore;
  messages: MessageStore;
  contacts: ContactStore;
  audit: AuditLogStore;
  minMessagesSinceLast?: number;
  throttleMs?: number;
}

export interface MaybeUpdateInput {
  workspaceId: string;
  contactId: string;
  threadId: string;
}

const NOTES_PROMPT_SYSTEM = `Eres un sistema de memoria episódica.
Lee las notas actuales sobre un contacto y los mensajes recientes del hilo.
Devuelve:
- Notas actualizadas (texto libre, máx 2000 chars) SI hay algo nuevo importante que recordar.
- Literal "NO_CHANGE" si las notas siguen vigentes y no hay nada nuevo.

Reglas:
- No inventes. Solo añade lo que se deduzca de los mensajes.
- Preserva info previa que siga siendo cierta.
- Si hay contradicción con notas previas, prevalece lo más reciente.
- No guardes PII sensible (números de tarjeta, contraseñas, llaves de API).
- Máximo 2000 chars total.`;

export class NotesUpdater {
  private minMsgs: number;
  private throttleMs: number;

  constructor(private deps: NotesUpdaterDeps) {
    this.minMsgs = deps.minMessagesSinceLast ?? 5;
    this.throttleMs = deps.throttleMs ?? 3600_000;
  }

  async maybeUpdate(input: MaybeUpdateInput): Promise<void> {
    const thread = await this.deps.threads.get(input.threadId);
    if (!thread) return;

    const lastUpdated = thread.notes_last_updated_at;
    const since = lastUpdated ?? thread.created_at;

    // Throttle: if updated < throttleMs ago, skip
    if (lastUpdated) {
      const lastMs = new Date(lastUpdated).getTime();
      if (Date.now() - lastMs < this.throttleMs) {
        await this.deps.audit.write({
          workspace_id: input.workspaceId,
          action: "notes.throttled",
          actor: "system",
          related_contact_id: input.contactId,
          decision: "no_action",
        });
        return;
      }
    }

    const msgsSince = await this.deps.messages.countSinceTimestamp(input.threadId, since);
    const shouldRun = msgsSince >= this.minMsgs || thread.closed;
    if (!shouldRun) return;

    const contact = await this.deps.contacts.findById(input.workspaceId, input.contactId);
    if (!contact) return;
    const recent = await this.deps.messages.lastN(input.threadId, 20);

    const fakeContext: AgentContext = {
      workspaceId: input.workspaceId,
      contact: { ...contact, notes: "" } as never,
      channelType: "telegram",
      incomingMessage: {
        id: "notes-update",
        direction: "inbound",
        content: this.buildNotesPrompt(contact.notes, recent),
        sent_by: "human",
        created_at: new Date().toISOString(),
      },
      threadHistory: [],
      policy: {
        id: "notes", workspace_id: input.workspaceId, contact_id: input.contactId,
        channel_type: "telegram", policy: "auto",
        system_prompt: NOTES_PROMPT_SYSTEM, model_id: null,
        rate_limit_per_hour: 1000, max_tokens_out: 2000, max_tool_calls: 0,
        forbidden_topics_regex: [], escalate_triggers_regex: [],
        rules: {}, priority: 0,
        created_at: new Date().toISOString(),
      } as never,
      availableTools: [],
      budget: { remainingUsd: 0.05 },
    };

    const response = await this.deps.runtime.respond(fakeContext);
    const newNotes = response.body.trim();

    if (!newNotes || newNotes === "NO_CHANGE") {
      await this.deps.audit.write({
        workspace_id: input.workspaceId,
        action: "notes.skipped",
        actor: "agent",
        related_contact_id: input.contactId,
        decision: "no_action",
        cost_usd: response.costUsd,
        model_id: null,
      });
      return;
    }

    await this.deps.contacts.updateNotes(input.contactId, newNotes);
    await this.deps.threads.markNotesUpdated(input.threadId);
    await this.deps.audit.write({
      workspace_id: input.workspaceId,
      action: "notes.updated",
      actor: "agent",
      related_contact_id: input.contactId,
      details: { prev_len: contact.notes.length, new_len: newNotes.length },
      decision: "no_action",
      cost_usd: response.costUsd,
      tokens_in: response.tokens.in,
      tokens_out: response.tokens.out,
    });
  }

  private buildNotesPrompt(currentNotes: string, recent: unknown[]): string {
    const conv = recent
      .map((m) => {
        const x = m as { direction: string; content: string };
        return `[${x.direction}] ${x.content}`;
      })
      .join("\n");
    return `Notas actuales:\n${currentNotes || "(vacías)"}\n\nConversación reciente:\n${conv}\n\nDevuelve notas actualizadas o "NO_CHANGE".`;
  }
}
