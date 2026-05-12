## Problem

Some unused code lingers in the codebase:

1. **`TelegramTransport.handle` field** (`packages/mcp/src/transports/telegram.ts`) — set during `init()` but never read. The bot's username comes from the API instead.

2. **`msw` in devDependencies** (`packages/mcp/package.json`) — installed but never imported. The spec mentioned mocked HTTP integration tests via MSW, but they were never written.

## Suggested approach

### For the unused `handle` field

Remove the field declaration and the assignment in `init()`:

```ts
// REMOVE this:
private handle: string = "";

// REMOVE from init:
this.handle = c.handle;
```

### For `msw`

Choose one:

**Option A — remove it** (simpler):

```bash
pnpm --filter agent-mouth remove msw
```

**Option B — actually use it** (more valuable): write an integration test at `packages/mcp/tests/integration/telegram-mocked.test.ts` that uses MSW to mock the Telegram HTTPS API and exercise a full flow:
- Boot up MSW with handlers for `api.telegram.org/bot.../getMe`, `sendMessage`, `getUpdates`
- Run `TelegramTransport.init` + `send` + `waitForMessages`
- Assert the actual HTTP requests MSW captured match expected payloads

This catches bugs unit tests can't (URL formatting, request body shapes).

## Files

- `packages/mcp/src/transports/telegram.ts`
- `packages/mcp/package.json`
- (option B) `packages/mcp/tests/integration/` (new directory + test file)

## Acceptance criteria

- Unused `handle` field is gone
- `msw` is either used or removed
- Build + tests still green
