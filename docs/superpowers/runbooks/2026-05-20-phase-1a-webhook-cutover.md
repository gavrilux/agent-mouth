# Phase 1a Webhook Cutover — Runbook

**When to use:** First deploy of Phase 1a code that swaps Telegram from `lab.agentiko.es` webhook → `agent-mouth.fly.dev/telegram-webhook`.

## Preconditions

- [ ] Supabase migration 0002 applied (plan Task 5 verified — 11 tables in `public` schema).
- [ ] Seed data inserted (plan Task 6 verified — workspace `11111111-…-111`, telegram channel `22222222-…-222`, default silent policy `33333333-…-333`).
- [ ] Fly secrets set (plan Task 23):
  - `SUPABASE_URL`, `SUPABASE_ANON_KEY` (already from Phase 0)
  - `AGENT_MOUTH_BOT_TOKEN`, `AGENT_MOUTH_CHAT_ID`, `AGENT_MOUTH_HANDLE` (already)
  - `BRIDGE_FORWARD_URL=https://lab.agentiko.es/webhook` (new)
  - `BRIDGE_FORWARD_CHATS=<comma-separated Cuina LAB chat IDs>` (new)

## Cutover steps

1. Capture rollback info (CURRENT webhook URL — keep it for rollback):

```
flyctl ssh console -a agent-mouth -C 'node -e "fetch(\`https://api.telegram.org/bot${process.env.AGENT_MOUTH_BOT_TOKEN}/getWebhookInfo\`).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"'
```

   Save `result.url` as `OLD_WEBHOOK_URL` in your scratch notes.

2. Deploy:

```
flyctl deploy -a agent-mouth
```

   Wait for `[i] Machines have been updated` and verify `/health`:

```
curl -sf https://agent-mouth.fly.dev/health
```

3. Switch the Telegram webhook to agent-mouth:

```
flyctl ssh console -a agent-mouth -C 'node -e "fetch(\`https://api.telegram.org/bot${process.env.AGENT_MOUTH_BOT_TOKEN}/setWebhook?url=https://agent-mouth.fly.dev/telegram-webhook&allowed_updates=[\\\"message\\\"]\`).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"'
```

   Expected: `{ "ok": true, "result": true, "description": "Webhook was set" }`.

4. Validate private → MCP:

   - From your phone: send "hola test phase 1a" to `@Gavrilux_bot` in **private** chat.
   - Check Fly logs: `flyctl logs -a agent-mouth | tail -20` — expect `webhook processed` line with `kind: "persisted"`.
   - From Claude Code: call `mcp__agent-mouth__read_inbox` — expect the message in the response.

5. Validate group → bridge:

   - In The Cuina LAB Telegram group, send a message.
   - Check Fly logs: expect `webhook processed` with `kind: "forwarded", ok: true`.
   - Verify the bridge at `lab.agentiko.es` still reacts as before.

## Rollback

If anything misbehaves, revert the webhook:

```
flyctl ssh console -a agent-mouth -C 'node -e "fetch(\`https://api.telegram.org/bot${process.env.AGENT_MOUTH_BOT_TOKEN}/setWebhook?url=<OLD_WEBHOOK_URL>&allowed_updates=[\\\"message\\\"]\`).then(r=>r.json()).then(j=>console.log(JSON.stringify(j,null,2)))"'
```

Then triage logs / metrics. The new code path is purely additive (the old bridge logic at `lab.agentiko.es` is unchanged), so rolling back the webhook URL is a complete rollback.

## Known limitations (Phase 1a)

- `mark_read` still uses the offset store (long-polling lineage). It's effectively a no-op when webhook owns inbound — to be retired in Phase 1b.
- `get_thread` still uses `transport.receive` (long-polling). Will fail-soft because polling now conflicts with the webhook. Retire/refactor in Phase 1b.
- Messages persist only for chats NOT in `BRIDGE_FORWARD_CHATS`. The Cuina LAB group remains owned by the bridge.
- `waitForNew` polls Supabase every 2 s. Acceptable for Phase 1a; switch to Postgres LISTEN/NOTIFY in Phase 1b if latency matters.
