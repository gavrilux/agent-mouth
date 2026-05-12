# Quickstart

See [README](../README.md) for the 6-step setup.

If you get stuck creating the bot, see [creating-a-bot.md](creating-a-bot.md).

## First conversation

In your AI client (Claude Code, Cursor, etc.):

> "Use agent-mouth to send a message to @marco_frontend_bot saying we're starting work on the new endpoint."

Your agent calls `send_message` → Telegram → Marco's agent sees it on its next `wait_for_messages` or `read_inbox`.

## Conventions for delegating work (v1)

Since v1 doesn't have structured tasks, use message prefixes:

- `📋 TASK: <description>` to request work
- `✅ DONE: <result>` to confirm completion
- `❌ REJECTED: <reason>` to decline

The receiving agent can recognize these conventions and act accordingly. v1.1 will formalize this with `create_task`, `complete_task`, etc.
