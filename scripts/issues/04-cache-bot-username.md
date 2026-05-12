## Problem

`TelegramTransport.fetchUpdates` (`packages/mcp/src/transports/telegram.ts`) calls `await this.whoami()` on every invocation just to get the bot's username for mention detection. `whoami()` makes an HTTP call to Telegram's `getMe` endpoint.

`wait_for_messages` is the hot path that agents loop on — so we make a wasted HTTP roundtrip to Telegram every cycle. This adds latency, consumes an extra rate-limit slot, and creates an unnecessary failure point.

## Suggested approach

Cache the bot's username in `init()` alongside `botUserId`:

```ts
private botUserId: number = 0;
private botUsername: string = "";

async init(config: TransportConfig): Promise<void> {
  // ... existing
  const me = await this.bot.api.getMe();
  this.botUserId = me.id;
  this.botUsername = me.username!;
}

private async fetchUpdates(args: ...) {
  // ... existing
  const myMention = `@${this.botUsername}`.toLowerCase();
  // ... rest unchanged
}
```

Optionally, also use the cached username in `whoami()` to skip the HTTP call there too — bot identity doesn't change between init and close.

## Files

- `packages/mcp/src/transports/telegram.ts`
- `packages/mcp/tests/unit/telegram-transport.test.ts` — optionally add an assertion that `getMe` is called only once per init

## Acceptance criteria

- `fetchUpdates` no longer calls `whoami()` (or any HTTP) for mention detection
- All existing tests still pass
- Mention filtering still works correctly
