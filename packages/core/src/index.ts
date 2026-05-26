// Legacy transport interfaces (Phase 0). Contact is aliased to avoid
// collision with the new identity-domain Contact (DB row) below.
export type {
  Identity,
  Contact as TransportContact,
  ReceivedMessage,
  SentMessage,
  SendOptions,
  ReceiveOptions,
  WaitOptions,
  TransportConfig,
  Transport,
} from "./transport.js";
export * from "./offset-store.js";
// Legacy domain schemas (Phase 0). ChannelType is aliased to avoid
// collision with the new identity-domain ChannelType below.
export {
  ChannelTypeSchema,
  ChannelType as LegacyChannelType,
  MessageDirectionSchema,
  MessageDirection,
  MessageSchema,
  Message,
} from "./domain.js";
export * from "./identity.js";
export * from "./inbound.js";
export * from "./stores.js";
export * from "./knowledge.js";
export * from "./vector.js";
export * from "./web-search.js";
export * from "./embeddings.js";
export * from "./tools.js";
export * from "./email.js";
