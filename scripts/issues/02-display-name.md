## Problem

When users run `agent-mouth init` or `agent-mouth join`, they're prompted for a `display_name` which is saved to config. But `TelegramTransport.whoami` (`packages/mcp/src/transports/telegram.ts`) returns `me.first_name` from Telegram's `getMe`, ignoring the locally configured value.

This means the agent's display name shown to MCP clients is always whatever was set in @BotFather, not what the user configured.

## Suggested approach

Store the configured `display_name` on the transport during `init()` and use it in `whoami()`:

```ts
private displayName: string | undefined;

async init(config: TransportConfig): Promise<void> {
  const c = config as TelegramConfig;
  // ... existing code
  this.displayName = c.display_name;
}

async whoami(): Promise<Identity> {
  // ... existing code
  return {
    handle: me.username!,
    display_name: this.displayName ?? me.first_name,
    bot_id: me.id,
    chat_id: this.chatId
  };
}
```

Add `display_name?: string` to the `TelegramConfig` interface.

## Files

- `packages/mcp/src/transports/telegram.ts`
- `packages/mcp/tests/unit/telegram-transport.test.ts` — add a test passing a custom `display_name` in `init`

## Acceptance criteria

- `whoami` respects configured `display_name` if set, falls back to Telegram's `first_name` otherwise
- New test verifies the override behavior
