# Phase 3 rollout runbook — tools + knowledge

**Branch:** `feat/phase-3-tools-knowledge`
**Plan:** `docs/superpowers/plans/2026-05-23-agent-mouth-phase-3-tools-knowledge.md`
**Spec:** `docs/superpowers/specs/2026-05-23-agent-mouth-phase-3-design.md`

Operator-runnable rollout in 4 steps:

1. Infra setup (volume + secrets + migration)
2. Deploy with tools OFF, verify knowledge sync
3. Flip tools ON, validate 3 E2E gates
4. 48h monitoring, then merge to main

If anything in steps 2-3 looks wrong, **rollback** is in the last section.

---

## Pre-requisites

- [ ] `flyctl` installed and authenticated (`flyctl auth whoami` → gavrilo)
- [ ] Access to Supabase SQL editor (account `gavrimarkovic4@gmail.com`, project `deicbuvcynqontfbnboe`)
- [ ] Telegram client on phone, logged into Gavrilo's account
- [ ] Phase 2 currently LIVE in prod and responding to messages

---

## Step 0 — Deploy key for CerebroDigital

The worker clones a private Git repo, so it needs a deploy key.

```bash
# Generate the key (no passphrase — Fly secrets are already encrypted)
ssh-keygen -t ed25519 -f ~/.ssh/cerebro_digital_deploy_key -N "" -C "agent-mouth deploy key"

# Show the public half to add as a Deploy Key on GitHub
cat ~/.ssh/cerebro_digital_deploy_key.pub
```

Add the `.pub` line at `https://github.com/gavrilux/CerebroDigital/settings/keys` → "Add deploy key" → title `agent-mouth (Fly)`, paste, **read-only** (do NOT check "Allow write access").

---

## Step 1 — Apply migration

In Supabase SQL Editor (account `gavrimarkovic4@gmail.com`, project `deicbuvcynqontfbnboe`), paste the contents of `packages/storage-supabase/sql/0004_apply_phase3_schema.sql` and run.

Verify:

```sql
SELECT count(*) FROM information_schema.tables
WHERE table_name IN ('knowledge_sources','knowledge_files','knowledge_chunks');
-- expect: 3

SELECT column_name FROM information_schema.columns
WHERE table_name='policies' AND column_name='allowed_tools';
-- expect: one row
```

---

## Step 2 — Create the Fly volume

```bash
flyctl volumes create agent_mouth_knowledge \
  --region cdg --size 10 \
  --app agent-mouth
```

Verify:

```bash
flyctl volumes list --app agent-mouth
# expect: agent_mouth_knowledge | 10GB | cdg | created (no machines yet)
```

The `[mounts]` block in `fly.toml` will attach this on next deploy.

---

## Step 3 — Set Phase 3 secrets

```bash
flyctl secrets set --app agent-mouth \
  TAVILY_API_KEY="<your_tavily_key>" \
  OPENAI_API_KEY="<your_openai_key>" \
  KNOWLEDGE_GIT_DEPLOY_KEY="$(cat ~/.ssh/cerebro_digital_deploy_key)"
```

Notes:
- `OPENAI_API_KEY` is the same key already used by ClaudeRuntime fallback, fine to share. If it's not set yet, add it.
- `TAVILY_API_KEY`: get from https://tavily.com (free tier = 1k calls/mo).
- `KNOWLEDGE_GIT_DEPLOY_KEY` must be the **private** key contents (entire file, including `-----BEGIN/END-----` lines and trailing newline).

This redeploys the app automatically — that's fine because `ENABLE_AGENT_TOOLS` is still `"false"` in `fly.toml`, so the agent stays Phase 2 until step 6.

Verify secrets:

```bash
flyctl secrets list --app agent-mouth
# look for TAVILY_API_KEY, OPENAI_API_KEY, KNOWLEDGE_GIT_DEPLOY_KEY
```

---

## Step 4 — Deploy with `ENABLE_KNOWLEDGE_SYNC=true`, tools still OFF

```bash
cd /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth
git checkout feat/phase-3-tools-knowledge
flyctl deploy --app agent-mouth
```

This deploys the branch with the new `fly.toml` (mount + Phase 3 env vars). Watch boot:

```bash
flyctl logs --app agent-mouth
```

Expected lines within ~30s:

```
[phase-3] knowledge.sync registered  (intervalMin=15)
```

`agent tools registered` should NOT appear yet because `ENABLE_AGENT_TOOLS=false`.

If you see `tools bootstrap failed`, that's fine for this step (it tried because `defaultWorkspaceId` was set but no `knowledge_sources` row exists yet — falls back to Phase 2). Once we seed in step 5 and flip `ENABLE_AGENT_TOOLS=true` in step 6, it will resolve.

---

## Step 5 — Seed the knowledge source row

The sync handler runs every 15 min, but until there's a `knowledge_sources` row it has nothing to sync. Insert one:

```bash
flyctl ssh console --app agent-mouth \
  -C "node /app/apps/cli/dist/index.js seed-knowledge"
```

Expected output (one log line):

```
seeded knowledge source  id=<uuid>  workspaceId=<uuid>  repoUrl=git@github.com:gavrilux/CerebroDigital.git
```

If you see `knowledge_sources row already exists — skipping`, that means a previous run already inserted one. Use `--force` to insert a duplicate intentionally; otherwise skip.

The first cron tick is kicked immediately at boot, but since you may have deployed before seeding, manually trigger one:

```bash
# Optional: enqueue an immediate sync (otherwise wait up to 15 min)
flyctl ssh console --app agent-mouth -C "psql \$DATABASE_URL -c \"SELECT pgboss.send('knowledge.sync', '{}', '{\\\"singletonKey\\\":\\\"knowledge.sync.singleton\\\"}');\""
```

Or just wait — the next 15-min tick will pick it up.

---

## Step 6 — Verify knowledge sync populated the DB

Wait 2-5 min for the first sync. Then in Supabase SQL Editor:

```sql
-- Should be 1
SELECT count(*) AS sources FROM knowledge_sources;

-- Should be > 100 (CerebroDigital has ~150 markdown files)
SELECT count(*) AS files FROM knowledge_files;

-- Should be > 1000 (each file produces ~5-15 chunks)
SELECT count(*) AS chunks FROM knowledge_chunks;

-- Should be 0 (every file should be indexed)
SELECT count(*) AS unindexed FROM knowledge_files WHERE indexed_at IS NULL;

-- Should be 'ok' and recent
SELECT last_synced_at, last_sync_status FROM knowledge_sources;
```

Sanity check from Telegram: send the bot a private message *"hola"*. Expect Phase 2 behavior (replies without tools). Audit log should NOT contain `tool.call` rows:

```sql
SELECT count(*) FROM audit_log
WHERE action='tool.call'
  AND created_at > now() - interval '5 minutes';
-- expect: 0
```

If everything above checks out, knowledge sync is healthy. Move on.

If `last_sync_status` starts with `error:`, read the message — most likely cause is the deploy key not being added to GitHub correctly.

---

## Step 7 — Flip `ENABLE_AGENT_TOOLS=true`

```bash
flyctl secrets set --app agent-mouth ENABLE_AGENT_TOOLS=true
```

This redeploys. Watch boot logs:

```bash
flyctl logs --app agent-mouth
```

Expected line:

```
[phase-3] agent tools registered: search_web, search_knowledge, read_knowledge_file
```

If you see `[phase-3] tools bootstrap failed: ...` — read the error. Most likely: `TAVILY_API_KEY required` or `DATABASE_URL required` (a secret didn't make it). Fix and redeploy.

---

## Step 8 — Temporarily set policy to `suggest` for validation

We want to inspect the bot's draft before letting it send, so flip the policy to `suggest`:

```sql
-- Find Gavrilo's contact id
SELECT id, display_name FROM contacts ORDER BY created_at DESC LIMIT 5;

-- Set policy to suggest (replace <id> with Gavrilo's contact id)
UPDATE policies SET policy = 'suggest' WHERE contact_id = '<id>';
```

Note the previous value to restore in step 10.

---

## Step 9 — Validate the 3 E2E gates from spec §7.4

Send each from Telegram. After each, inspect:

```sql
-- Latest draft
SELECT proposed_body, agent_reasoning FROM drafts ORDER BY created_at DESC LIMIT 1;

-- Latest tool calls (should match expected tools for the gate)
SELECT created_at, details->>'tool_name' AS tool, details->>'success' AS ok, cost_usd
FROM audit_log
WHERE action='tool.call'
ORDER BY created_at DESC LIMIT 5;
```

### Gate A — knowledge tool

Send: *"¿qué próximo paso tiene fiscalflow?"*

Expected:
- One `tool.call` with `tool_name='search_knowledge'` (cost ~$0.00002)
- Optionally a `tool.call` with `tool_name='read_knowledge_file'` (cost $0)
- Draft body references actual content from `02-Proyectos/fiscalflow.md` and cites the file path
- ✅ Pass if draft mentions current status + cites file path

### Gate B — web search

Send: *"¿cuál es la versión estable más reciente de Node.js?"*

Expected:
- One `tool.call` with `tool_name='search_web'` (cost ~$0.001)
- Draft body returns current Node LTS version + cites a URL
- ✅ Pass if version is accurate and URL is real

### Gate C — both tools in one turn

Send: *"resume mis 3 proyectos más activos y busca si hay novedades de Vercel hoy"*

Expected:
- Multiple `tool.call` rows: `search_knowledge` (probably 1-2x) + `search_web` (1x)
- Draft synthesizes both: lists 3 projects from the Dashboard + a Vercel news item with URL
- Total `cost_usd` < $0.01
- ✅ Pass if both sources are cited and the answer combines them

Record results inline below (edit this file):

```
Gate A (knowledge):  [ ] PASS / [ ] FAIL  — notes:
Gate B (web):        [ ] PASS / [ ] FAIL  — notes:
Gate C (both):       [ ] PASS / [ ] FAIL  — notes:
```

---

## Step 10 — Restore policy to `auto`

```sql
UPDATE policies SET policy = 'auto' WHERE contact_id = '<gavrilo_contact_id>';
```

The bot will now send autonomously again.

---

## Step 11 — 48h monitoring

Daily check at +24h and +48h:

```sql
SELECT
  date(created_at) AS day,
  count(*) FILTER (WHERE action='tool.call') AS tool_calls,
  count(*) FILTER (WHERE action='tool.call' AND (details->>'success')::bool = true) AS tool_ok,
  count(*) FILTER (WHERE action='tool.call' AND (details->>'success')::bool = false) AS tool_err,
  round(sum(cost_usd)::numeric, 4) AS total_cost_usd,
  round(avg(latency_ms)::numeric) AS avg_latency_ms,
  max(latency_ms) AS max_latency_ms
FROM audit_log
WHERE created_at > now() - interval '48 hours'
GROUP BY 1
ORDER BY 1 DESC;
```

Thresholds (red flags):

| Metric | Healthy | Investigate |
|---|---|---|
| `total_cost_usd` per day | < $0.10 | > $0.50 |
| `tool_err / tool_calls` | < 5% | > 20% |
| `max_latency_ms` | < 10 000 | > 30 000 (tool timeout) |
| `knowledge_sources.last_sync_status` | 'ok' | anything starting with 'error:' |

Also spot-check `knowledge.sync` runs:

```sql
SELECT last_synced_at, last_sync_status
FROM knowledge_sources
ORDER BY last_synced_at DESC;
-- expect: last_synced_at within the last 15 minutes
```

---

## Step 12 — Merge to main

If gates passed and 48h monitoring is healthy:

```bash
cd /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth
git checkout main
git pull
git merge --no-ff feat/phase-3-tools-knowledge \
  -m "Merge branch 'feat/phase-3-tools-knowledge' — Phase 3 LIVE in production"
git push origin main
```

Update Cerebro Digital:
- `~/CerebroDigital/02-Proyectos/agent-mouth.md` → status `**Phase 3 LIVE**` + list the 3 tools
- `~/CerebroDigital/00-Dashboard.md` → update the agent-mouth row

---

## Rollback

If anything goes wrong at any step, the kill-switch is:

```bash
# 1. Disable tools immediately (1 redeploy, ~30s)
flyctl secrets set --app agent-mouth ENABLE_AGENT_TOOLS=false ENABLE_KNOWLEDGE_SYNC=false
```

This drops back to Phase 2 (no tools, no cron sync). The DB tables stay populated but unused. Audit log keeps the history.

If the worker is crashlooping (it shouldn't — bootstrap is wrapped in try/catch), pin to a previous release:

```bash
flyctl releases --app agent-mouth          # find a known-good release id
flyctl deploy --image registry.fly.io/agent-mouth:<release-id> --app agent-mouth
```

If schema is the problem (very unlikely — only ADD COLUMN + new tables), the migration is non-destructive; no rollback needed for the DB.

---

## Acceptance criteria (close this runbook)

- [ ] Step 1: migration applied, 3 tables present, `allowed_tools` column added
- [ ] Step 2: volume `agent_mouth_knowledge` exists
- [ ] Step 3: 3 secrets set (TAVILY, OPENAI, KNOWLEDGE_GIT_DEPLOY_KEY)
- [ ] Step 4: first deploy succeeded, `knowledge.sync registered` in logs
- [ ] Step 5: `seed-knowledge` ran, row inserted
- [ ] Step 6: `knowledge_chunks` count > 1000, `last_sync_status='ok'`
- [ ] Step 7: tools registered in logs after flip
- [ ] Step 9 Gate A: PASS
- [ ] Step 9 Gate B: PASS
- [ ] Step 9 Gate C: PASS
- [ ] Step 10: policy restored to `auto`
- [ ] Step 11: 24h monitoring healthy
- [ ] Step 11: 48h monitoring healthy
- [ ] Step 12: merged to main, Cerebro Digital updated
