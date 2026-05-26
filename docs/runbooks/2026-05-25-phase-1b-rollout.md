# Phase 1b Rollout — EmailTransport (Gmail OAuth + Pub/Sub webhook)

**Date:** 2026-05-25
**Owner:** Gavrilo
**Spec:** `docs/superpowers/specs/2026-05-25-agent-mouth-phase-1b-design.md`
**Plan:** `docs/superpowers/plans/2026-05-25-agent-mouth-phase-1b-email-transport.md`

---

## 1. Pre-flight (one-time setup on Google Cloud)

### 1.1 Create or pick GCP project

```bash
gcloud projects create agent-mouth-email-2026 --name="Agent Mouth Email"   # or reuse an existing one
gcloud config set project agent-mouth-email-2026
```

### 1.2 Enable APIs

```bash
gcloud services enable gmail.googleapis.com
gcloud services enable pubsub.googleapis.com
gcloud services enable iam.googleapis.com
```

### 1.3 Create Pub/Sub topic + grant Gmail's service agent publisher rights

```bash
TOPIC=projects/agent-mouth-email-2026/topics/gmail-notifications

gcloud pubsub topics create gmail-notifications

# Gmail's service agent must be able to publish to the topic:
gcloud pubsub topics add-iam-policy-binding gmail-notifications \
  --member=serviceAccount:gmail-api-push@system.gserviceaccount.com \
  --role=roles/pubsub.publisher
```

### 1.4 Create push subscription targeted at agent-mouth.fly.dev

```bash
gcloud iam service-accounts create gmail-push-sa \
  --display-name="Gmail Push Webhook SA"

SA=gmail-push-sa@agent-mouth-email-2026.iam.gserviceaccount.com

gcloud pubsub subscriptions create gmail-push-agent-mouth \
  --topic=gmail-notifications \
  --push-endpoint=https://agent-mouth.fly.dev/email-webhook \
  --push-auth-service-account=$SA \
  --push-auth-token-audience=https://agent-mouth.fly.dev/email-webhook
```

### 1.5 OAuth client for `gavrilux.agent@gmail.com`

In Google Cloud Console → APIs & Services → Credentials → "Create OAuth client ID":
- Type: Web application
- Authorized redirect URIs: `http://localhost:53682/callback`

Save the `client_id` and `client_secret`.

---

## 2. Generate encryption key

```bash
openssl rand -hex 32
# Save this — you'll set it as AGENT_MOUTH_TOKEN_ENCRYPTION_KEY on Fly
# Anyone with this key can decrypt all refresh tokens. Treat like a database password.
```

---

## 3. Apply Supabase migration 0005

In Supabase SQL editor (project `deicbuvcynqontfbnboe`):

```sql
-- Paste contents of packages/storage-supabase/sql/0005_email_transport.sql
```

Verify:
```sql
SELECT * FROM email_oauth_tokens LIMIT 0;
SELECT * FROM email_webhook_events LIMIT 0;
SELECT metadata FROM contacts LIMIT 1;
```

---

## 4. Set Fly secrets (start in SAFE MODE: auto=false)

```bash
flyctl secrets set \
  GOOGLE_OAUTH_CLIENT_ID="<from step 1.5>" \
  GOOGLE_OAUTH_CLIENT_SECRET="<from step 1.5>" \
  GOOGLE_PUBSUB_TOPIC="projects/agent-mouth-email-2026/topics/gmail-notifications" \
  GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL="gmail-push-sa@agent-mouth-email-2026.iam.gserviceaccount.com" \
  EMAIL_WEBHOOK_AUDIENCE="https://agent-mouth.fly.dev/email-webhook" \
  AGENT_MOUTH_TOKEN_ENCRYPTION_KEY="<from step 2>" \
  ENABLE_EMAIL_TRANSPORT=true \
  ENABLE_EMAIL_AUTO=false \
  --app agent-mouth
```

---

## 5. Deploy

```bash
flyctl deploy --app agent-mouth
```

Wait for rolling deploy. Check logs:

```bash
flyctl logs --app agent-mouth | grep -E "email transport bootstrapped|error"
```

Expected: `email transport bootstrapped` should NOT appear yet — no token row exists.

---

## 6. Run `email:setup` against production DB

Locally, with `.env` pointing to production Supabase:

```bash
export DATABASE_URL="<prod direct connection>"
export SUPABASE_URL="https://deicbuvcynqontfbnboe.supabase.co"
export SUPABASE_ANON_KEY="<prod anon key>"
export GOOGLE_OAUTH_CLIENT_ID="<same as Fly secret>"
export GOOGLE_OAUTH_CLIENT_SECRET="<same as Fly secret>"
export AGENT_MOUTH_TOKEN_ENCRYPTION_KEY="<same as Fly secret>"
export GOOGLE_PUBSUB_TOPIC="<same as Fly secret>"

pnpm --filter @agent-mouth/api exec node dist/cli/index.js email:setup
```

Follow the URL, sign in as `gavrilux.agent@gmail.com`, grant scopes. CLI ends with `✅ Setup complete`.

Verify in Supabase:
```sql
SELECT id, email_address, status, watch_expiration, last_history_id
FROM email_oauth_tokens WHERE status='active';
```

---

## 7. Redeploy so server picks up the new token

```bash
flyctl deploy --app agent-mouth
```

Logs should now show: `email transport bootstrapped {email: gavrilux.agent@gmail.com}`.

---

## 8. Smoke test (still ENABLE_EMAIL_AUTO=false)

From any of your personal accounts, send an email to `gavrilux.agent@gmail.com`:

> Subject: Phase 1b smoke
> Body: Hello world

Within 5 seconds, you should see in logs:
```
POST /email-webhook 200
email.fetch job enqueued
processInbound persisted (policy=silent)
```

Verify in Supabase:
```sql
SELECT id, channel_type, content, created_at FROM messages
WHERE channel_type='email' ORDER BY created_at DESC LIMIT 5;
```

You should see your test email row. Agent did NOT auto-reply (ENABLE_EMAIL_AUTO=false).

---

## 9. Flip to auto

```bash
flyctl secrets set ENABLE_EMAIL_AUTO=true --app agent-mouth
flyctl deploy --app agent-mouth
```

---

## 10. Gate 1b (T25 — proceed to that task in the plan)

See plan §Sprint 6 / Task 25.

---

## Rollback

| Symptom | Command | Effect |
|---|---|---|
| Agent replying badly | `flyctl secrets set ENABLE_EMAIL_AUTO=false && flyctl deploy` | Email persists, no auto-reply |
| Budget runaway / wild loop | `flyctl secrets set ENABLE_EMAIL_TRANSPORT=false && flyctl deploy` | Email transport entirely off (webhook returns 503, cron skipped) |
| OAuth token compromised | Revoke at https://myaccount.google.com/permissions, then `email:setup` again | New refresh token |
| Migration 0005 broke prod | `DROP TABLE email_oauth_tokens; DROP TABLE email_webhook_events; ALTER TABLE contacts DROP COLUMN metadata;` then re-apply with fix | Manual recovery |

---

## Monitoring queries

```sql
-- Inbound rate (per day)
SELECT date_trunc('day', created_at) day, count(*) FROM messages
WHERE channel_type='email' AND created_at > now() - interval '7 days'
GROUP BY 1 ORDER BY 1;

-- Token health
SELECT email_address, status, watch_expiration, consecutive_renewal_failures, last_error
FROM email_oauth_tokens;

-- Last 24h audit events for email
SELECT event_name, count(*) FROM audit_log
WHERE created_at > now() - interval '24 hours' AND event_name LIKE 'email.%'
GROUP BY 1;
```
