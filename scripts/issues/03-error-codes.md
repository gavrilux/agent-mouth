## Problem

The spec (`docs/superpowers/specs/2026-05-11-agent-mouth-telegram-design.md` §10) defines structured error codes: `AUTH_ERROR`, `NOT_IN_GROUP`, `PRIVACY_MODE_ON`, `RATE_LIMITED`, `NETWORK_ERROR`, `NOT_FOUND`. But the current server code (`packages/mcp/src/server.ts`) uses `e.name` which is just `"Error"` for any thrown error.

LLMs calling these tools currently get `{ ok: false, error: { code: "Error", message: "..." } }` for every failure mode, making it impossible to react differently to auth failures vs network failures vs rate limiting.

## Suggested approach

### 1. Create a custom error class

`packages/mcp/src/errors.ts`:

```ts
export class AgentMouthError extends Error {
  constructor(public code: string, message: string, public hint?: string) {
    super(message);
    this.name = code;
  }
}

export const authError = (msg: string, hint?: string) =>
  new AgentMouthError("AUTH_ERROR", msg, hint);
export const notInGroupError = (msg: string, hint?: string) =>
  new AgentMouthError("NOT_IN_GROUP", msg, hint);
export const rateLimitedError = (retryAfter: number) =>
  new AgentMouthError("RATE_LIMITED", `Telegram rate limit; retry in ${retryAfter}s`);
export const networkError = (msg: string) =>
  new AgentMouthError("NETWORK_ERROR", msg);
```

### 2. Catch and translate grammy errors in TelegramTransport

```ts
import { HttpError, GrammyError } from "grammy";

// wrap api calls:
try {
  return await this.bot.api.sendMessage(...);
} catch (err) {
  if (err instanceof GrammyError) {
    if (err.error_code === 401) throw authError("Bot token rejected. Regenerate via @BotFather.");
    if (err.error_code === 403 && err.description.includes("kicked")) throw notInGroupError("Bot was removed from the group.");
    if (err.error_code === 429) throw rateLimitedError(err.parameters?.retry_after ?? 1);
  }
  if (err instanceof HttpError) throw networkError(err.message);
  throw err;
}
```

### 3. server.ts already preserves error code

The existing handler does `code: e.name` — once errors are `AgentMouthError` instances, `e.name === code` so this works automatically.

## Files

- `packages/mcp/src/errors.ts` (new)
- `packages/mcp/src/transports/telegram.ts` — wrap api calls
- `packages/mcp/tests/unit/telegram-transport.test.ts` — add tests for each error mapping (use `vi.fn().mockRejectedValue(...)` to throw fake grammy errors)

## Acceptance criteria

- All error responses use the codes from spec §10
- Each error code has at least one test
- The `hint` field is populated where useful
