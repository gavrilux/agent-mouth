import type {
  AuditLogStore, ContactStore, MessageStore, Policy, WorkspaceStore,
} from "@agent-mouth/core";
import type {
  AgentRuntime, AgentResponse, AgentContext, ChannelType,
} from "@agent-mouth/agent-runtime";
import { WorkingMemoryBuilder } from "@agent-mouth/agent-memory";
import { runPreLLMGuardrails } from "@agent-mouth/agent-guardrails";

export interface AgentDeps {
  runtime: AgentRuntime;
  contactStore: ContactStore;
  messageStore: MessageStore;
  auditLogStore: AuditLogStore;
  workspaceStore: WorkspaceStore;
  workingMemorySize?: number;
}

export interface RespondInput {
  workspaceId: string;
  contactId: string;
  threadId: string;
  channelType: ChannelType;
  incomingMessageId: string;
  incomingContent: string;
  policy: Policy;
}

export type AgentDecision =
  | { decision: "ready_to_send"; response: AgentResponse }
  | { decision: "ready_to_draft"; response: AgentResponse }
  | { decision: "blocked"; blockReason: string; response?: undefined }
  | { decision: "escalated"; blockReason: string; response?: undefined }
  | { decision: "no_action"; blockReason: string; response?: undefined };

export class Agent {
  private workingMem: WorkingMemoryBuilder;

  constructor(private deps: AgentDeps) {
    this.workingMem = new WorkingMemoryBuilder(deps.messageStore, deps.workingMemorySize ?? 10);
  }

  async respond(input: RespondInput): Promise<AgentDecision> {
    // 0. Idempotency: skip if already responded
    const prior = await this.deps.auditLogStore.findRespondedFor(input.incomingMessageId);
    if (prior) {
      return { decision: "no_action", blockReason: "idempotent_skip:already_responded" };
    }

    // 1. Guardrails pre-LLM
    const pre = await runPreLLMGuardrails(
      {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        threadId: input.threadId,
        incomingContent: input.incomingContent,
        policy: input.policy,
      },
      {
        audit: this.deps.auditLogStore,
        workspaces: this.deps.workspaceStore,
        messages: this.deps.messageStore,
      },
    );

    if (!pre.result.ok) {
      const isEscalate = pre.result.escalate === true;
      return {
        decision: isEscalate ? "escalated" : "blocked",
        blockReason: pre.result.reason,
      };
    }

    // 2. Build context
    const contact = await this.deps.contactStore.findById(input.workspaceId, input.contactId);
    if (!contact) {
      return { decision: "no_action", blockReason: "contact_not_found" };
    }
    const notes = contact.notes ?? "";
    const workingHistory = await this.workingMem.build(input.threadId);

    const ctx: AgentContext = {
      workspaceId: input.workspaceId,
      contact: { ...contact, notes },
      channelType: input.channelType,
      incomingMessage: {
        id: input.incomingMessageId,
        direction: "inbound",
        content: pre.sanitizedContent,
        sent_by: "human",
        created_at: new Date().toISOString(),
      },
      threadHistory: workingHistory.map((m) => ({
        id: (m as any).id,
        direction: (m as any).direction,
        content: (m as any).content,
        sent_by: (m as any).sent_by,
        created_at: (m as any).created_at,
      })),
      policy: input.policy,
      availableTools: [],
      budget: { remainingUsd: 0 },
    };

    // 3. LLM call
    const response = await this.deps.runtime.respond(ctx);

    // 4. Post-LLM: self-escalate
    if (response.metadata.shouldEscalate) {
      return { decision: "escalated", blockReason: "self_escalate" };
    }

    // 5. Route by policy
    if (input.policy.policy === "suggest") {
      return { decision: "ready_to_draft", response };
    }
    if (input.policy.policy === "auto") {
      return { decision: "ready_to_send", response };
    }
    return { decision: "no_action", blockReason: `unsupported_policy:${input.policy.policy}` };
  }
}
