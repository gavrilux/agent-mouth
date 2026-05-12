## Problem

The `read_inbox` tool accepts a `since_message_id` parameter in its input schema (`packages/mcp/src/tools/messaging.ts`), but `TelegramTransport.receive` ignores it entirely — no filtering by message ID happens.

A user calling `read_inbox({ since_message_id: "100:42" })` would expect only messages newer than that ID, but currently receives all messages from the polling buffer.

## Suggested approach

Two options:

1. **Implement it properly**: filter the returned messages in `TelegramTransport.fetchUpdates` so only messages with `update_id > parsedSinceId` are returned (parse the `"<update_id>:<msg_id>"` format).
2. **Remove it from the schema**: since the transport auto-advances `lastSeenUpdateId` internally, this parameter may not add value. Drop it from `inputSchema` and the Zod schema.

Option 2 is simpler and aligns with actual behavior. Either is acceptable — pick what makes more sense.

## Files

- `packages/mcp/src/tools/messaging.ts` — tool definition and Zod schema
- `packages/mcp/src/transports/telegram.ts` — actual receive impl
- `packages/mcp/src/transports/types.ts` — `ReceiveOptions` interface
- `packages/mcp/tests/unit/tools-messaging.test.ts` — add a test for the chosen behavior

## Acceptance criteria

- `since_message_id` either works as documented OR is removed cleanly
- New test in `tools-messaging.test.ts` validates the chosen behavior
- No regressions in existing tests
