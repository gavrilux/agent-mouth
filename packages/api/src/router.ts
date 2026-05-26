// packages/api/src/router.ts
import type {
  ChannelType,
  IdentityResolver,
  InboundMessage,
  MessageStore,
  PolicyAction,
  PolicyEngine,
  ThreadStore,
} from "@agent-mouth/core";

export interface RouterDeps {
  workspaceId: string;
  bridgeForwardChats: Set<string>;
  bridgeForwardUrl: string | null;
  identityResolver: IdentityResolver;
  threadStore: ThreadStore;
  policyEngine: PolicyEngine;
  messageStore: MessageStore;
  forwarder: (url: string, payload: unknown) => Promise<boolean>;
}

export type RouterResult =
  | { kind: "forwarded"; url: string; ok: boolean }
  | {
      kind: "persisted";
      policy: PolicyAction;
      messageId: string;
      contactId: string;
      threadId: string;
      channelType: ChannelType;
      channelId: string;
      channelIdentityId: string;
      externalChatId: string;
      messageContent: string;
    }
  | { kind: "skipped"; reason: string };

export async function processInbound(msg: InboundMessage, deps: RouterDeps): Promise<RouterResult> {
  if (deps.bridgeForwardChats.has(msg.external_thread_id) && deps.bridgeForwardUrl) {
    const ok = await deps.forwarder(deps.bridgeForwardUrl, msg.raw_payload);
    return { kind: "forwarded", url: deps.bridgeForwardUrl, ok };
  }

  const ident = await deps.identityResolver.resolveOrCreate({
    workspaceId: deps.workspaceId,
    channelType: msg.channel_type,
    identifier: msg.sender_identifier,
    displayName: msg.sender_display_name,
  });

  const thread = await deps.threadStore.resolveOrCreate({
    workspaceId: deps.workspaceId,
    contactId: ident.contact.id,
    channelId: ident.channel.id,
    externalThreadId: msg.external_thread_id,
  });

  const policy = await deps.policyEngine.evaluate({
    workspaceId: deps.workspaceId,
    contactId: ident.contact.id,
    channelType: msg.channel_type,
  });

  // Phase 1b kill switch: ENABLE_EMAIL_AUTO=false forces email policy to silent.
  // Read env on every call (no caching) so flipping the var is effective once
  // the env update lands in the process.
  let effectivePolicyAction = policy.policy;
  if (msg.channel_type === "email" && process.env.ENABLE_EMAIL_AUTO === "false") {
    effectivePolicyAction = "silent";
  }

  const persisted = await deps.messageStore.insert({
    threadId: thread.id,
    channelId: ident.channel.id,
    channelIdentityId: ident.channel_identity.id,
    direction: "inbound",
    content: msg.content,
    attachments: msg.attachments,
    rawPayload: msg.raw_payload,
    externalMessageId: msg.external_message_id,
    sentBy: null,
  });

  return {
    kind: "persisted",
    policy: effectivePolicyAction,
    messageId: persisted.id,
    contactId: ident.contact.id,
    threadId: thread.id,
    channelType: msg.channel_type,
    channelId: ident.channel.id,
    channelIdentityId: ident.channel_identity.id,
    externalChatId: msg.external_thread_id,
    messageContent: msg.content,
  };
}
