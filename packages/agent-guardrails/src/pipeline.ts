import type { AuditLogStore, MessageStore, Policy, WorkspaceStore } from "@agent-mouth/core";
import { checkBudget } from "./budget.js";
import { checkRateLimit } from "./rate-limit.js";
import { checkLoopProtection } from "./loop.js";
import { sanitize } from "./sanitizer.js";
import { checkForbiddenTopics } from "./forbidden-topics.js";
import { checkEscalateTriggers } from "./escalate-triggers.js";
import type { GuardrailResult } from "./types.js";

export interface PipelineCtx {
  workspaceId: string;
  contactId: string;
  threadId: string;
  incomingContent: string;
  policy: Policy;
}

export interface PipelineDeps {
  audit: AuditLogStore;
  workspaces: WorkspaceStore;
  messages: MessageStore;
}

export interface PipelineOutcome {
  result: GuardrailResult;
  sanitizedContent: string;
}

export async function runPreLLMGuardrails(
  ctx: PipelineCtx,
  deps: PipelineDeps,
): Promise<PipelineOutcome> {
  // 1. Budget
  const budget = await checkBudget({ workspaceId: ctx.workspaceId }, deps.audit, deps.workspaces);
  if (!budget.ok) return { result: budget, sanitizedContent: ctx.incomingContent };

  // 2. Rate limit
  const rate = await checkRateLimit(
    { contactId: ctx.contactId, limit: ctx.policy.rate_limit_per_hour },
    deps.audit,
  );
  if (!rate.ok) return { result: rate, sanitizedContent: ctx.incomingContent };

  // 3. Loop protection
  const loop = await checkLoopProtection({ threadId: ctx.threadId }, deps.messages);
  if (!loop.ok) return { result: loop, sanitizedContent: ctx.incomingContent };

  // 4. Sanitize (does not block)
  const sanitized = sanitize(ctx.incomingContent);

  // 5. Forbidden topics
  const forbidden = checkForbiddenTopics(sanitized, ctx.policy.forbidden_topics_regex);
  if (!forbidden.ok) return { result: forbidden, sanitizedContent: sanitized };

  // 6. Escalate triggers
  const escalate = checkEscalateTriggers(sanitized, ctx.policy.escalate_triggers_regex);
  if (!escalate.ok) return { result: escalate, sanitizedContent: sanitized };

  return { result: { ok: true }, sanitizedContent: sanitized };
}
