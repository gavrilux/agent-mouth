import type {
  AuditLogStore, ContactStore, MessageStore, Policy, WorkspaceStore,
} from "@agent-mouth/core";
import type {
  AgentRuntime, AgentResponse, AgentContext, ChannelType, RespondTurnMessage,
} from "@agent-mouth/agent-runtime";
import type { Tool, ToolContext } from "@agent-mouth/core";
import { WorkingMemoryBuilder } from "@agent-mouth/agent-memory";
import { runPreLLMGuardrails } from "@agent-mouth/agent-guardrails";
import { buildSystemPrompt, buildUserMessages } from "@agent-mouth/agent-runtime";

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
  tools?: Tool[];   // NEW — when present and non-empty, runs tool-use loop via runtime.respondTurn
}

export type AgentDecision =
  | { decision: "ready_to_send"; response: AgentResponse }
  | { decision: "ready_to_draft"; response: AgentResponse }
  | { decision: "blocked"; blockReason: string; response?: undefined }
  | { decision: "escalated"; blockReason: string; response?: undefined }
  | { decision: "no_action"; blockReason: string; response?: undefined };

export interface ToolInvocationLog {
  id: string;
  name: string;
  input: Record<string, unknown>;
  ok: boolean;
  error?: string;
  costUsd: number;
  latencyMs: number;
}

const TOOL_TIMEOUT_MS = 30000;

const RESPOND_TO_USER_SCHEMA = {
  type: "object" as const,
  properties: {
    body: { type: "string", description: "Texto de respuesta al usuario." },
    reasoning: { type: "string", description: "Resumen breve de por qué esta respuesta." },
    confidence: { type: "number", description: "Confianza 0-1." },
    should_escalate: { type: "boolean", description: "true si el tema te supera." },
  },
  required: ["body", "reasoning", "confidence", "should_escalate"],
};

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("tool_timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); },
    );
  });
}

export class Agent {
  private workingMem: WorkingMemoryBuilder;

  constructor(private deps: AgentDeps) {
    this.workingMem = new WorkingMemoryBuilder(deps.messageStore, deps.workingMemorySize ?? 10);
  }

  private async runToolLoop(args: {
    ctx: AgentContext;
    tools: Tool[];
    toolCtx: ToolContext;
  }): Promise<{ response: AgentResponse; toolLog: ToolInvocationLog[]; blocked: boolean; blockReason?: string }> {
    const { ctx, tools, toolCtx } = args;

    const systemPrompt = buildSystemPrompt(ctx);
    const initialMessages: RespondTurnMessage[] = buildUserMessages(ctx).map((m): RespondTurnMessage => {
      if (m.role === "user") {
        return { role: "user", content: m.content };
      }
      return { role: "assistant", content: m.content };
    });

    const toolDefs = tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Record<string, unknown>,
    }));

    const allowedNames = new Set(tools.map((t) => t.name));
    const maxToolCalls = ctx.policy.max_tool_calls;
    const messages: RespondTurnMessage[] = [...initialMessages];
    const toolLog: ToolInvocationLog[] = [];
    let totalCost = 0;
    let totalTokensIn = 0;
    let totalTokensOut = 0;
    let totalCached = 0;
    let invocationsRun = 0;

    const model = ctx.policy.model_id ?? "claude-sonnet-4-6";
    const maxTokens = ctx.policy.max_tokens_out;

    for (let turn = 0; turn < maxToolCalls + 1; turn++) {
      // On the final turn (or if already exhausted), force respond_to_user by passing tools=[]
      const turnTools = invocationsRun >= maxToolCalls ? [] : toolDefs;

      const resp = await this.deps.runtime.respondTurn!({
        systemPrompt,
        messages,
        tools: turnTools,
        respondToUserSchema: RESPOND_TO_USER_SCHEMA,
        model,
        maxTokens,
      });

      totalCost += resp.costUsd;
      totalTokensIn += resp.tokens.in;
      totalTokensOut += resp.tokens.out;
      totalCached += resp.tokens.cached;

      if (resp.finalOutput) {
        return {
          response: {
            body: resp.finalOutput.body,
            reasoning: resp.finalOutput.reasoning,
            toolsCalled: toolLog.map((l) => ({
              name: l.name,
              arguments: l.input,
              result: l.ok ? "ok" : `error:${l.error ?? "unknown"}`,
            })),
            tokens: { in: totalTokensIn, out: totalTokensOut, cached: totalCached },
            costUsd: totalCost,
            metadata: { confidence: resp.finalOutput.confidence, shouldEscalate: resp.finalOutput.should_escalate },
          },
          toolLog,
          blocked: false,
        };
      }

      if (!resp.toolCalls || resp.toolCalls.length === 0) {
        return {
          response: {
            body: "",
            reasoning: "no_output",
            toolsCalled: [],
            tokens: { in: totalTokensIn, out: totalTokensOut, cached: totalCached },
            costUsd: totalCost,
            metadata: { confidence: 0, shouldEscalate: true },
          },
          toolLog,
          blocked: true,
          blockReason: "runtime_returned_no_output",
        };
      }

      // Append assistant tool_use message
      messages.push({
        role: "assistant",
        content: resp.toolCalls.map((c) => ({
          type: "tool_use" as const,
          id: c.id,
          name: c.name,
          input: c.input,
        })),
      });

      const resultsForNext: Array<{ type: "tool_result"; tool_use_id: string; content: string; is_error?: boolean }> = [];

      for (const call of resp.toolCalls) {
        invocationsRun++;
        const log: ToolInvocationLog = {
          id: call.id,
          name: call.name,
          input: call.input,
          ok: false,
          costUsd: 0,
          latencyMs: 0,
        };

        if (!allowedNames.has(call.name)) {
          log.error = "tool_not_allowed";
          resultsForNext.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: JSON.stringify({ error: "tool_not_allowed" }),
            is_error: true,
          });
          toolLog.push(log);
          continue;
        }

        const tool = tools.find((t) => t.name === call.name)!;
        try {
          const r = await withTimeout(tool.execute(call.input, toolCtx), TOOL_TIMEOUT_MS);
          log.ok = r.ok;
          log.error = r.error;
          log.costUsd = r.costUsd;
          log.latencyMs = r.latencyMs;
          totalCost += r.costUsd;
          resultsForNext.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: JSON.stringify(r.ok ? r.output : { error: r.error }),
            is_error: !r.ok,
          });
        } catch (err) {
          log.error = err instanceof Error ? err.message : String(err);
          resultsForNext.push({
            type: "tool_result",
            tool_use_id: call.id,
            content: JSON.stringify({ error: log.error }),
            is_error: true,
          });
        }

        toolLog.push(log);
      }

      messages.push({ role: "user", content: resultsForNext });

      if (invocationsRun >= maxToolCalls) {
        // Next iteration will force respond_to_user via tools=[]
        continue;
      }
    }

    // Should not reach here normally
    return {
      response: {
        body: "",
        reasoning: "loop_exit_unexpected",
        toolsCalled: [],
        tokens: { in: totalTokensIn, out: totalTokensOut, cached: totalCached },
        costUsd: totalCost,
        metadata: { confidence: 0, shouldEscalate: true },
      },
      toolLog,
      blocked: true,
      blockReason: "max_tool_calls_exhausted",
    };
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

    const availableTools = input.tools?.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Record<string, unknown>,
    })) ?? [];

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
      availableTools,
      budget: { remainingUsd: 0 },
    };

    // 3. LLM call — tool-use loop or Phase 2 path
    let response: AgentResponse;

    if (input.tools && input.tools.length > 0 && this.deps.runtime.respondTurn) {
      const toolCtx: ToolContext = {
        workspaceId: input.workspaceId,
        contactId: input.contactId,
        threadId: input.threadId,
        policy: input.policy,
        logger: { info: () => {}, warn: () => {}, error: () => {} },
      };
      const loopResult = await this.runToolLoop({ ctx, tools: input.tools, toolCtx });
      if (loopResult.blocked) {
        return { decision: "blocked", blockReason: loopResult.blockReason ?? "tool_loop_blocked" };
      }
      response = loopResult.response;
    } else {
      // Phase 2 path — unchanged
      response = await this.deps.runtime.respond(ctx);
    }

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
