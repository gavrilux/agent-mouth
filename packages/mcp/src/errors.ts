export type AgentMouthErrorCode =
  | "AUTH_ERROR"
  | "NOT_IN_GROUP"
  | "PRIVACY_MODE_ON"
  | "RATE_LIMITED"
  | "NETWORK_ERROR"
  | "NOT_FOUND";

export class AgentMouthError extends Error {
  constructor(
    public code: AgentMouthErrorCode,
    message: string,
    public hint?: string,
  ) {
    super(message);
    this.name = code;
  }
}

export const authError = (message: string, hint?: string) =>
  new AgentMouthError("AUTH_ERROR", message, hint);

export const notInGroupError = (message: string, hint?: string) =>
  new AgentMouthError("NOT_IN_GROUP", message, hint);

export const privacyModeError = (message: string, hint?: string) =>
  new AgentMouthError("PRIVACY_MODE_ON", message, hint);

export const rateLimitedError = (retryAfter: number) =>
  new AgentMouthError(
    "RATE_LIMITED",
    `Telegram rate limit; retry in ${retryAfter}s`,
    `Wait ${retryAfter}s before retrying this request.`,
  );

export const networkError = (message: string, hint?: string) =>
  new AgentMouthError("NETWORK_ERROR", message, hint);

export const notFoundError = (message: string, hint?: string) =>
  new AgentMouthError("NOT_FOUND", message, hint);
