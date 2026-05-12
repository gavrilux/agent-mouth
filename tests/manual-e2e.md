# Manual E2E test

Once per release, verify Agent Mouth actually works end-to-end with real Telegram.

## Setup (one-time)

1. Create a dedicated test bot via @BotFather (e.g. `agent_mouth_e2e_bot`).
2. Create a private Telegram group "Agent Mouth E2E", add the bot as admin.
3. Disable bot privacy mode.

## Test script

```bash
# 1. Configure
node packages/mcp/dist/cli/index.js init
# Enter bot token, send a message in the group to auto-detect chat_id, accept defaults

# 2. Spawn the MCP server
node packages/mcp/dist/cli/index.js serve &
SERVER_PID=$!

# 3. From another terminal or via Claude Code: list tools, call whoami, send a message
# Verify: the message appears in the Telegram group

# 4. From your phone, send a message in the group mentioning the bot
# Verify: wait_for_messages returns it within ~5s

# 5. Cleanup
kill $SERVER_PID
```

## Expected behavior

- `whoami` returns the bot's username and group chat_id
- `send_message` posts to the group, visible on your phone
- `wait_for_messages` wakes up within 1-2s of you sending a message
- `read_inbox` returns recent messages
