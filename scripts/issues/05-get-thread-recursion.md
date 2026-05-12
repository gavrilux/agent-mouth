## Problem

The `get_thread` tool (`packages/mcp/src/tools/messaging.ts`) takes a `reply_to_message_id` parameter and returns messages that are direct replies to it, plus the message itself. But "thread" naturally implies the *full* reply chain — replies to replies, recursively.

Currently if you have `A → reply-to-A → reply-to-that-reply`, calling `get_thread(reply_to_message_id: A.id)` only returns `A` and its immediate replies, NOT the grandchildren.

## Suggested approach

Pick one:

### Option 1: Rename and clarify (simpler, ship now)

Rename `reply_to_message_id` → `root_message_id` in the schema and description:

```ts
description: "Returns a root message plus its direct replies (one level)."
```

### Option 2: Implement recursive walking (more useful)

After fetching recent updates, build a graph `{message_id → reply_to_message_id}` and BFS/DFS from the root to collect all descendants. May require fetching more history than a single `getUpdates` call returns (Telegram only buffers ~24h).

Option 1 is honest and fast. Option 2 is more powerful but limited by Telegram's getUpdates buffer.

## Files

- `packages/mcp/src/tools/messaging.ts` — tool definition
- `packages/mcp/tests/unit/tools-messaging.test.ts` — add a test for whichever approach

## Acceptance criteria

- Either the tool name/description matches its behavior, OR it walks recursively
- New test validates the chosen behavior
