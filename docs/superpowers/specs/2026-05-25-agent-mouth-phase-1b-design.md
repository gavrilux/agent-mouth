# Agent Mouth — Phase 1b Design (EmailTransport + cross-channel inbox)

**Status:** Draft (brainstorming output)
**Date:** 2026-05-25
**Author:** Gavrilo + Claude (subagent-driven brainstorming)
**Closes:** Phase 1 of the vision roadmap (`docs/superpowers/specs/2026-05-20-agent-mouth-vision-design.md` §6)

---

## 0. Context

Phase 0 + 1a + 2 + 3 are LIVE in `agent-mouth.fly.dev`. The only piece of Phase 1 still missing is the EmailTransport. Phase 1b closes Phase 1 by adding email as a second channel alongside Telegram, with cross-channel read_inbox and auto-merge of identities.

Conceptual model: **the agent has its own email identity**, just like it has its own Telegram identity (`@Gavrilux_bot`). The user's personal inbox is never touched. Email address: `gavrilux.agent@gmail.com` (free Gmail account, no Workspace seat).

## 1. Goals & non-goals

### Goals
- The agent can send and receive email via Gmail API on its own account.
- **Sub-second inbound latency via Gmail Pub/Sub push** (webhook), with polling every 10 minutes as safety net for watch expiry or Pub/Sub outage.
- Inbound emails flow through the same `processInbound` router as Telegram messages.
- `read_inbox` MCP tool returns Telegram + Email messages mixed by timestamp.
- `send_message` MCP tool can target either channel.
- Identity auto-merge: an inbound email whose sender matches `contacts.metadata.email_addresses[]` reuses the existing Contact instead of creating a duplicate.
- The architecture allows future drivers (IMAP, Outlook) without changing `EmailTransport`.
- Kill switch via env var lets us disable email auto-reply with a single `flyctl secrets set + flyctl deploy` (~1-2 minutes including rolling restart). For sub-second flip, the router reads the env var on every request (no caching) so the secret is honored as soon as the new process boots.

### Non-goals (Phase 1b)
- IMAP / Outlook / other providers (only Gmail; drivers are pluggable but only `GmailDriver` ships).
- Multi-account per workspace (architecture supports N email channels per workspace, but Phase 1b ships with 1 account).
- Heuristic identity merge (e.g. by display_name). Only exact email-address match merges.
- Email-specific UI (no dashboard for managing email; CLI + SQL only).
- Sending attachments (text body only; attachments come later if needed).

## 2. Decisions log (from brainstorming session 2026-05-25)

| # | Decision | Rationale |
|---|---|---|
| 1 | Driver-based architecture (`EmailDriver` interface, `GmailDriver` impl) | Future-proofs for IMAP/Outlook without rewrite |
| 2 | Gmail API only in Phase 1b | Vision doc says Gmail; user has Google Workspace; simplest path |
| 3 | **Webhook (Gmail Pub/Sub push) primary + polling fallback every 10min** | Sub-second latency, ~0 idle API calls. Polling kept as safety net for watch expiry (max 7 days) and Pub/Sub outage. Cost: $0 (Pub/Sub free tier covers personal-volume mailboxes) |
| 4 | Agent has its own email account (`gavrilux.agent@gmail.com`), not user's | Mirrors `@Gavrilux_bot` model; zero risk of accidentally replying to HR/legal/clients |
| 5 | Free Gmail account (not Workspace seat) | $0/mo; promote to Workspace if revenue justifies |
| 6 | Policy default `auto` | Volume is tiny (only direct contacts), risk low because user's inbox isn't touched |
| 7 | Approach B — Identity auto-merge by exact match in `metadata.email_addresses[]` | Manual is too tedious; heuristic too risky; exact match is safe |
| 8 | Open to all destinations (no outbound whitelist) | User trusts budget cap + max_tool_calls; whitelist would just slow dogfooding |
| 9 | Refresh tokens encrypted at rest (AES-256-GCM) | Defense in depth if Supabase row leaks |
| 10 | Kill switch via `ENABLE_EMAIL_AUTO` env var | Allows instant degrade to drafts-only without redeploy |
| 11 | Pub/Sub webhook validates Google-signed JWT before processing | Prevents anyone from POST-spoofing notifications to `/email-webhook` |
| 12 | Watch renewal cron every 6 days (1 day safety margin before 7-day expiry) | Pub/Sub `watch` expires; missing renewal = no notifications = polling fallback covers gap |

## 3. Architecture overview

```
   GMAIL CLOUD                            agent-mouth.fly.dev
  ──────────────                        ───────────────────────

  ┌─────────────┐   message arrives    ┌────────────────────────────┐
  │   Gmail     │ ───────────────────► │  HTTP server               │
  │  mailbox    │   pubsub topic       │                            │
  └─────────────┘                      │  /telegram-webhook         │
        │                              │  /email-webhook       NEW  │
        │                              │  /mcp · /health            │
        ▼                              └──────────┬─────────────────┘
  ┌─────────────┐                                 │ enqueue job
  │ Pub/Sub     │ ──── HTTPS POST + JWT ────────► │
  │ topic +     │      with {emailAddress,        ▼
  │ subscription│       historyId}        ┌────────────────────────┐
  └─────────────┘                          │  pg-boss worker         │
                                           │                         │
                                           │  ┌──────────────────┐   │
                                           │  │ email.fetch job  │   │
                                           │  │  (per webhook)   │   │
                                           │  └────────┬─────────┘   │
                                           │           │             │
                                           │           ▼             │
                                           │  ┌──────────────────┐   │
                                           │  │ EmailTransport   │   │
                                           │  │ + GmailDriver    │   │
                                           │  └────────┬─────────┘   │
                                           │           │             │
                                           │           ▼             │
                                           │  ┌──────────────────┐   │
                                           │  │ gmail→inbound    │   │
                                           │  │ → processInbound │   │
                                           │  └──────────────────┘   │
                                           │                         │
                                           │  Cron jobs:             │
                                           │  · knowledge.sync (15m) │
                                           │  · phase3.health (daily)│
                                           │  · email.watch.renew    │
                                           │    (every 6 days)  NEW  │
                                           │  · email.poll.fallback  │
                                           │    (every 10 min)  NEW  │
                                           └─────────────────────────┘
```

**Primary path (webhook):** Gmail publishes to Pub/Sub topic → push subscription POSTs to `/email-webhook` → endpoint validates Google-signed JWT → enqueues `email.fetch` job with `{email_address, historyId}` → worker fetches new messages → `processInbound` (same router as Telegram). Latency < 1s.

**Safety net (polling):** `email.poll.fallback` runs every 10 minutes. Same logic as primary path but iterates all active tokens. Catches messages missed during Pub/Sub outages or while watch was expired.

**Watch renewal:** `email.watch.renew` cron runs every 6 days (1-day margin before the 7-day expiry of `gmail.users.watch`) and re-issues the watch for each active token.

### Components (new)
1. `@agent-mouth/transport-email` — package with `EmailTransport` + `EmailDriver` interface + `GmailDriver` + `gmailMessageToInbound`
2. HTTP endpoint `POST /email-webhook` in `serve-http.ts` with Google JWT validation
3. Worker job `email.fetch` — fires per webhook payload, idempotent on `(email_address, historyId)`
4. Recurring job `email.poll.fallback` (every 10min, `singletonKey="email.poll.singleton"`)
5. Recurring job `email.watch.renew` (every 6 days, `singletonKey="email.watch.renew.singleton"`)
6. Supabase table `email_oauth_tokens` + migration 0005 + `SupabaseEmailTokenStore`
7. Supabase column `contacts.metadata jsonb DEFAULT '{}'`
8. CLI command `email:setup` — OAuth flow + initial `gmail.users.watch` call

### Components (modified)
1. `IdentityResolver.resolve()` — for email, check `metadata.email_addresses[]` before creating new Contact
2. `send_message` MCP tool — accepts optional `channel` and `subject` params
3. `serve-http.ts` — bootstraps `EmailTransport` + webhook endpoint + cron jobs
4. `TransportRegistry` (new) — registry that maps `ChannelType` → `Transport` instance

### External infrastructure (one-time setup)
1. Google Cloud Project (`agent-mouth-email` or reuse existing GCP project)
2. Pub/Sub API enabled
3. Pub/Sub topic: `projects/<proj>/topics/gmail-notifications`
4. Pub/Sub push subscription: `projects/<proj>/subscriptions/gmail-push-agent-mouth`
   - Push endpoint: `https://agent-mouth.fly.dev/email-webhook`
   - Authentication: OIDC token with service account
5. Service account with `roles/pubsub.publisher` for Gmail's service agent
6. IAM: grant `gmail-api-push@system.gserviceaccount.com` publisher rights on the topic

## 4. Data flows

### 4.1 Setup OAuth + watch (once per email account)

```
1. User: pnpm cli email:setup
2. CLI prints OAuth URL (scopes: gmail.readonly + gmail.send + gmail.modify)
   redirect_uri: http://localhost:53682/callback
3. User opens URL, grants consent
4. Google redirects → CLI captures code in ephemeral local HTTP server
5. CLI exchanges code → {access_token, refresh_token, expires_in}
6. CLI calls gmail.users.getProfile → email_address + initial historyId
7. CLI calls gmail.users.watch({
     topicName: "projects/<proj>/topics/gmail-notifications",
     labelIds: ["INBOX"],
     labelFilterAction: "include"
   }) → returns {historyId, expiration (epoch ms)}
8. CLI inserts in Supabase email_oauth_tokens:
     {workspace_id, channel_id, email_address, refresh_token_encrypted (AES-GCM),
      scopes, last_history_id, watch_expiration, created_at, updated_at}
9. CLI prints success + expiration ETA
```

### 4.2 Inbound email — primary path (webhook, sub-second)

```
1. Email arrives in gavrilux.agent@gmail.com INBOX
2. Gmail publishes message to Pub/Sub topic with:
   data: base64({"emailAddress":"gavrilux.agent@gmail.com","historyId":"12345"})
3. Pub/Sub push subscription POSTs to https://agent-mouth.fly.dev/email-webhook
   with header Authorization: Bearer <Google-signed JWT>
4. Endpoint handler:
   a. Validate JWT (iss=accounts.google.com, aud=https://agent-mouth.fly.dev/email-webhook,
      signature against Google public keys cached for 1h)
      → if invalid: return 401, log warn
   b. Parse base64 data → {emailAddress, historyId}
   c. Idempotency check: SELECT 1 FROM email_webhook_events
      WHERE email_address=$1 AND history_id=$2 → if exists: return 200 (no-op)
      Otherwise INSERT (email_address, history_id, received_at)
   d. Enqueue worker job `email.fetch` with payload {emailAddress, historyId}
      using singletonKey=`email.fetch.${emailAddress}.${historyId}` for dedup
   e. Return 200 immediately (Pub/Sub retries on non-2xx)
5. Worker.handleEmailFetch({emailAddress, historyId}):
   - SELECT * FROM email_oauth_tokens WHERE email_address=$1 AND status='active'
   - refresh access_token if expired
   - driver.fetchNewMessages({last_cursor: max(token.last_history_id, payload.historyId - safe_window)})
   - persist + processInbound (same as polling flow below)
   - save new historyId to token
```

### 4.3 Inbound email — safety net (polling every 10min)

```
1. pg-boss cron fires `email.poll.fallback` (singletonKey="email.poll.singleton")
2. Worker.handleEmailPollFallback:
   a. SELECT * FROM email_oauth_tokens WHERE status='active'
   b. For each token:
      - refresh access_token if expired
      - driver.fetchNewMessages({last_cursor: token.last_history_id})
        → gmail.users.history.list(startHistoryId=last)
        → for each "messageAdded" item:
            gmail.users.messages.get(id, format="full") → parse headers + body
      - returns NormalizedEmail[] + next_cursor
      - save next_cursor to email_oauth_tokens.last_history_id
3. For each NormalizedEmail:
   - gmailMessageToInbound() → InboundMessage{channel_type:"email", ...}
   - InboundMessageSchema.safeParse()
   - processInbound(parsed, routerDeps)  ← SAME router as Telegram
```

Polling catches messages missed when:
- Pub/Sub had outage
- `gmail.users.watch` expired and renewal failed
- The webhook handler errored before saving historyId

Idempotency on `UNIQUE (channel_id, external_id)` ensures no duplicate persistence even if both paths see the same message.

### 4.4 Watch renewal (every 6 days)

```
1. pg-boss cron fires `email.watch.renew` (singletonKey="email.watch.renew.singleton")
2. Worker.handleWatchRenew:
   a. SELECT * FROM email_oauth_tokens WHERE status='active'
   b. For each token:
      - refresh access_token if expired
      - gmail.users.watch({topicName, labelIds:["INBOX"]})
      - save new watch_expiration to email_oauth_tokens
      - if call fails: log error, mark status='error' if 3 consecutive failures, Telegram alert
```

### 4.3 Identity auto-merge

```
IdentityResolver.resolve({workspace_id, channel_type:"email", external_id:<sender email>}):
  Note: all email comparisons are case-insensitive. Sender email is lower-cased
  before lookup; ChannelIdentity.identifier and metadata.email_addresses[] are
  stored lower-cased on write.

  1. Match exact ChannelIdentity (lower(identifier) = lower(<sender email>)):
     SELECT * FROM channel_identities ci JOIN channels c ON ci.channel_id=c.id
     WHERE c.workspace_id=$1 AND c.type='email' AND ci.identifier=lower(<sender email>)
     → if hit: return contact_id

  2. If miss → check metadata.email_addresses[] (case-insensitive contains):
     SELECT * FROM contacts
     WHERE workspace_id=$1 AND metadata->'email_addresses' ? lower(<sender email>)
     → if hit: INSERT new ChannelIdentity (identifier lower-cased), return contact_id  (MERGE)

  3. If miss → INSERT new Contact (display_name = From header name)
              INSERT new ChannelIdentity (identifier lower-cased)
              return new contact_id

Note: `link_email_to_contact` MCP tool also lower-cases input before storing.
```

### 4.4 Agent sends email

```
1. Worker.handleRespondJob({threadId, contactId, channelType:"email", ...})
2. Agent runs runToolLoop → calls send_message tool
3. send_message MCP tool:
   - input: {body, channel?, to?, reply_to_message_id?, subject?}
   - if channel not given: lookup Thread.channel_id → channels.type → use that transport
   - resolve via TransportRegistry
   - transport.send({to, body, reply_to_message_id, subject})
4. EmailTransport.send → GmailDriver.send():
   - resolve from-address by traversing: Thread.channel_id → channels row
     → channels.config.email_address (or join email_oauth_tokens WHERE channel_id=$1)
     → email_oauth_tokens row → decrypt refresh_token
   - build MIME (From + To + Subject + In-Reply-To + References + body)
   - gmail.users.messages.send({raw: base64url(mime)})
   - return SentMessage
5. MessageStore.add({channel_type:"email", direction:"out", ...})
6. audit_log row
```

### 4.5 Idempotency & recovery

- `last_history_id` persisted after every successful poll → natural recovery after crash
- Dedup: `UNIQUE (channel_id, external_id)` on `messages` table
- `historyId` expired (>7 days idle) → fallback to `gmail.users.messages.list(q="after:<last_seen_unix>")`
- OAuth refresh fail → `status='error'`, alert Telegram (reuses `alertChatId` from Phase 3)

## 5. Components & schemas

### 5.1 Package layout

```
packages/transport-email/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # public exports
│   ├── email-transport.ts        # implements Transport interface
│   ├── drivers/
│   │   ├── driver.ts             # EmailDriver interface (registrable)
│   │   └── gmail-driver.ts       # GmailDriver concrete impl
│   ├── normalize.ts              # gmailMessageToInbound
│   ├── mime.ts                   # build/parse MIME messages
│   └── oauth/
│       ├── google.ts             # token refresh + URL helpers
│       └── crypto.ts             # AES-256-GCM encrypt/decrypt
└── test/                         # vitest specs
```

### 5.2 EmailDriver interface (registrable)

```ts
export interface EmailDriver {
  readonly kind: "gmail" | "imap" | string;
  init(config: EmailDriverConfig): Promise<void>;
  whoami(): Promise<{ email_address: string }>;
  fetchNewMessages(args: {
    last_cursor: string;
  }): Promise<{ messages: NormalizedEmail[]; next_cursor: string }>;
  send(args: SendEmailArgs): Promise<{ message_id: string; thread_id: string }>;
  close(): Promise<void>;
}
```

### 5.3 New Zod schemas (in `@agent-mouth/core/src/email.ts`)

```ts
export const EmailTokenSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  email_address: z.string().email(),
  refresh_token_encrypted: z.string(),
  scopes: z.array(z.string()),
  last_history_id: z.string().nullable(),
  status: z.enum(["active", "error", "revoked"]).default("active"),
  last_error: z.string().nullable().default(null),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type EmailToken = z.infer<typeof EmailTokenSchema>;

export const NormalizedEmailSchema = z.object({
  external_id: z.string(),
  external_thread_id: z.string(),
  from_address: z.string().email(),
  from_name: z.string().nullable(),
  to_addresses: z.array(z.string().email()),
  cc_addresses: z.array(z.string().email()).default([]),
  subject: z.string(),
  body_text: z.string(),
  body_html: z.string().nullable().default(null),
  message_id_header: z.string(),
  in_reply_to_header: z.string().nullable().default(null),
  references_header: z.array(z.string()).default([]),
  received_at: z.string().datetime({ offset: true }),
});
export type NormalizedEmail = z.infer<typeof NormalizedEmailSchema>;
```

### 5.4 Extension to ContactSchema

```ts
export const ContactSchema = z.object({
  // ...existing fields
  metadata: z.object({
    email_addresses: z.array(z.string().email()).default([]),
  }).passthrough().default({}),
});
```

### 5.5 Supabase migration 0005_email_transport.sql

```sql
-- metadata jsonb on contacts (auto-merge)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS contacts_email_addresses_gin
  ON contacts USING gin ((metadata -> 'email_addresses'));

-- email_oauth_tokens
CREATE TABLE IF NOT EXISTS email_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  email_address text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_history_id text,
  watch_expiration timestamptz,                    -- when gmail.users.watch will expire
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','error','revoked')),
  last_error text,
  consecutive_renewal_failures int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, email_address)
);
ALTER TABLE email_oauth_tokens ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full access" ON email_oauth_tokens
  FOR ALL TO authenticated USING (true) WITH CHECK (true);

-- email_webhook_events for idempotency (dedup Pub/Sub at-least-once delivery)
CREATE TABLE IF NOT EXISTS email_webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_address text NOT NULL,
  history_id text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (email_address, history_id)
);
ALTER TABLE email_webhook_events ENABLE ROW LEVEL SECURITY;
CREATE POLICY "service_role full access" ON email_webhook_events
  FOR ALL TO authenticated USING (true) WITH CHECK (true);
-- Optional: TTL cleanup (keep 30 days)
CREATE INDEX IF NOT EXISTS email_webhook_events_received_at_idx
  ON email_webhook_events (received_at);

-- dedup index for messages
CREATE UNIQUE INDEX IF NOT EXISTS messages_channel_external_uniq
  ON messages (channel_id, external_id) WHERE external_id IS NOT NULL;
```

### 5.6 MCP tool changes

**`send_message`** — adds `channel?` and `subject?`:
```ts
inputSchema: {
  type: "object",
  required: ["body"],
  properties: {
    to: { type: "string" },
    channel: { type: "string", enum: ["telegram", "email"] },
    body: { type: "string", minLength: 1 },
    reply_to_message_id: { type: "string" },
    subject: { type: "string" },
  },
}
```
Behavior: if `channel` missing → infer from origin Thread. If no origin Thread → error.

**`link_email_to_contact`** (new):
```ts
{
  name: "link_email_to_contact",
  inputSchema: {
    type: "object",
    required: ["contact_id", "email"],
    properties: {
      contact_id: { type: "string", format: "uuid" },
      email: { type: "string", format: "email" },
    },
  },
}
```

### 5.7 Env vars

```
GOOGLE_OAUTH_CLIENT_ID=...
GOOGLE_OAUTH_CLIENT_SECRET=...
GOOGLE_PUBSUB_TOPIC=projects/<proj>/topics/gmail-notifications
GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL=<sa>@<proj>.iam.gserviceaccount.com  # expected aud/iss in JWT
EMAIL_WEBHOOK_AUDIENCE=https://agent-mouth.fly.dev/email-webhook         # must match JWT aud
AGENT_MOUTH_TOKEN_ENCRYPTION_KEY=<32 bytes hex>   # openssl rand -hex 32
ENABLE_EMAIL_TRANSPORT=true                       # master switch
ENABLE_EMAIL_AUTO=true                            # kill switch → silent if false
EMAIL_POLL_FALLBACK_INTERVAL_MIN=10               # safety-net polling
EMAIL_WATCH_RENEW_INTERVAL_DAYS=6                 # watch refresh cron
```

## 6. Error handling & resilience

| Scenario | Detection | Action |
|---|---|---|
| Refresh token revoked | `invalid_grant` on refresh | `status='revoked'`, Telegram alert, skip |
| Refresh token expired (>6mo inactive) | `invalid_grant` | same |
| Network error on refresh | 5xx/timeout | retry 3× exponential (1/3/9s); fail → `status='error'` |
| Scope insufficient | 403 on send | `status='error'`, alert: "re-run email:setup" |
| historyId expired (>7d idle) | 404 on history.list | fallback to `messages.list(q="after:<unix>")` + reset historyId |
| Double webhook delivery | Pub/Sub at-least-once | `email_webhook_events` UNIQUE (email_address, history_id) → no-op on duplicate |
| Webhook JWT invalid / signature mismatch | JWT validation throws | return 401, log warn (likely attack attempt) |
| Webhook payload malformed (no historyId) | Zod parse fails | return 400, log warn |
| `gmail.users.watch` expired (no renewal in 7 days) | No webhooks received | fallback polling covers the gap; alert if no webhooks for >24h |
| Watch renewal API call fails | 5xx | increment `consecutive_renewal_failures`; ≥3 failures → `status='error'` + alert |
| Pub/Sub outage (no webhooks) | Heartbeat: no webhook in 30min | fallback polling covers; if 6h without webhooks, alert |
| Gmail rate limit | 429 | exponential backoff, skip cycle if persistent |
| NDR (bounce) | inbound email tagged as bounce | persist + alert user |
| Malformed MIME on send | catch | log error, draft persisted as `error`, no send |
| Empty body | pre-validate | reject; never send empty |
| Budget exceeded | reuse Phase 2 `daily_budget_usd_cap` | skip respond; email persisted but agent silent |

**Kill switch:** `ENABLE_EMAIL_AUTO=false` → router forces `policy='silent'` for email regardless of policy table. The router re-reads `process.env.ENABLE_EMAIL_AUTO` on every inbound (no caching), so once the new env value is in the running process the switch is instant. Setting it via `flyctl secrets set` requires `flyctl deploy` to inject into the running process (~1-2 min for rolling restart).

## 7. Testing strategy

### 7.1 Unit (vitest, ~55 tests total)

- `transport-email/gmail-driver` (~10): fetchNewMessages, send MIME, refresh, history fallback, watch call
- `transport-email/normalize` (~5): plaintext, html-only, multipart, base64url, RFC2047
- `transport-email/mime` (~4): build with In-Reply-To, References, UTF-8, quoted-printable
- `transport-email/oauth/crypto` (~3): AES-GCM roundtrip, wrong key, base64 encoding
- `transport-email/oauth/google` (~3): URL builder, code exchange, refresh
- `transport-email/webhook/jwt` (~5): valid JWT accepted, wrong issuer rejected, wrong audience rejected, expired token rejected, mismatched signature rejected
- `transport-email/webhook/payload` (~3): valid Pub/Sub envelope parsed, malformed envelope returns 400, missing historyId returns 400
- `core/email` schemas (~5): EmailToken, NormalizedEmail, Contact.metadata, InboundMessage with email type
- `storage-supabase/email-token-store` (~4): list/upsert/updateCursor/markError + watch_expiration update
- `storage-supabase/email-webhook-events-store` (~2): insert + idempotency check
- `storage-supabase/identity-resolver` (~3): exact match, metadata merge, no match
- `api/email-webhook` endpoint (~4): valid push → enqueue job, duplicate historyId → no-op, invalid JWT → 401, malformed → 400
- `api/send-message` (~4): with channel:"email", with "telegram", infer from thread, error no context
- `api/link-email-to-contact` (~2)
- `api/email-setup` CLI (~3): OAuth flow happy path, port retry, code expired

### 7.2 Integration (vitest, Supabase real)

- `email-flow-webhook.test.ts`: insert fake EmailToken → mock Pub/Sub POST to `/email-webhook` with valid JWT → assert `email.fetch` job enqueued → run job → assert messages/contact/identity/audit
- `email-flow-polling.test.ts`: same setup → simulate Pub/Sub absence → fallback poll → same assertions (idempotency: webhook + poll see same message → only 1 row)
- `auto-merge.test.ts`: pre-populated Contact with `metadata.email_addresses` → inbound email → assert merge
- `watch-renewal.test.ts`: simulate cron tick → assert `gmail.users.watch` called → `watch_expiration` updated

### 7.3 E2E (Gate 1b)

1. User sends email from `gavrilo.markovic@gmail.com` → `gavrilux.agent@gmail.com` body `"phase-1b gate test, respond with 'gate ok'"`
2. Wait ≤60s
3. User receives reply in personal inbox containing "gate ok"
4. User calls `read_inbox` from Claude Code → sees both email + Telegram messages mixed
5. Audit log shows 3 rows for this flow: `email.received` + `agent.respond.completed` + `email.sent`

## 8. Deployment plan

### 8.1 Pre-deploy checklist

**Google Cloud setup (one-time):**
- [ ] GCP project created (`agent-mouth-email` or reuse existing)
- [ ] Pub/Sub API enabled
- [ ] Pub/Sub topic `projects/<proj>/topics/gmail-notifications` created
- [ ] Pub/Sub push subscription `projects/<proj>/subscriptions/gmail-push-agent-mouth` created
  - Push endpoint: `https://agent-mouth.fly.dev/email-webhook`
  - Authentication: OIDC token with service account
  - Audience: `https://agent-mouth.fly.dev/email-webhook`
- [ ] Service account created for push subscription
- [ ] IAM: `gmail-api-push@system.gserviceaccount.com` granted `roles/pubsub.publisher` on the topic

**Gmail account setup:**
- [ ] `gavrilux.agent@gmail.com` exists with 2FA
- [ ] Google Cloud Console: OAuth client (`Web application`) with `http://localhost:53682/callback` as redirect URI

**Local secrets:**
- [ ] `AGENT_MOUTH_TOKEN_ENCRYPTION_KEY` generated (`openssl rand -hex 32`)

**Code quality:**
- [ ] `pnpm -r test` ≥95% pass
- [ ] `pnpm -r typecheck` clean

### 8.2 Deploy sequence

```
 1. Apply migration 0005 in Supabase                       (idempotent)
 2. flyctl secrets set GOOGLE_OAUTH_CLIENT_ID
                        GOOGLE_OAUTH_CLIENT_SECRET
                        GOOGLE_PUBSUB_TOPIC
                        GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL
                        EMAIL_WEBHOOK_AUDIENCE
                        AGENT_MOUTH_TOKEN_ENCRYPTION_KEY
                        ENABLE_EMAIL_TRANSPORT=true
                        ENABLE_EMAIL_AUTO=false              (start silent)
 3. flyctl deploy                                            (rolling)
 4. flyctl logs | grep "email transport bootstrapped"        (verify boot)
 5. pnpm cli email:setup (local, points to Fly DB)           (OAuth + watch initial call)
 6. Send manual email to gavrilux.agent@gmail.com
 7. Verify in logs: "received Pub/Sub push" + "email.fetch job enqueued"
    Verify in DB: messages row with channel_type='email' in <5s
 8. flyctl secrets set ENABLE_EMAIL_AUTO=true
 9. flyctl deploy                                            (apply secret)
10. Run Gate 1b E2E
11. If Gate passes → merge feat/phase-1b → main → tag v0.X
```

### 8.3 Rollback

| Symptom | Immediate action |
|---|---|
| Agent replying badly | `flyctl secrets set ENABLE_EMAIL_AUTO=false && flyctl deploy` |
| Budget runaway | `flyctl secrets set ENABLE_EMAIL_TRANSPORT=false && flyctl deploy` |
| Send bug | `ENABLE_EMAIL_TRANSPORT=false` |
| Migration failure in prod | Manual DDL rollback + reapply with fix |

### 8.4 Acceptance checklist (Gate 1b)

- [ ] `read_inbox` returns Telegram + Email messages mixed by timestamp
- [ ] Email to `gavrilux.agent@gmail.com` → `messages` row with `channel_type='email'` in **<5s** (webhook path)
- [ ] Agent replies via Gmail API → arrives in user's personal inbox
- [ ] Reply preserves `In-Reply-To` + `References` (native Gmail threading)
- [ ] `audit_log` shows 3 rows: `email.received` + `agent.respond.completed` + `email.sent`
- [ ] Auto-merge: 2nd email same sender → same Contact (no duplicate)
- [ ] `link_email_to_contact` registered email → future emails merge into target Contact
- [ ] Kill switch: `ENABLE_EMAIL_AUTO=false` → emails persist, no auto-reply
- [ ] Webhook JWT validation: forged POST to `/email-webhook` → 401
- [ ] Polling fallback: temporarily stop Pub/Sub → email arrives → still persisted within 10min
- [ ] Watch renewal cron fires + extends `watch_expiration` correctly
- [ ] Cost ≤ $0.02 average per email reply

## 9. Cost analysis

- Gmail API: **free** up to 1B quota units/day (each email ≈5 units)
- Webhook (primary): ~10 calls/day per active token (1 per inbound message + watch renewal). Negligible.
- Polling fallback (every 10min): 144 calls/day × 5 units = 720 units/day. Negligible.
- Pub/Sub: **free** up to 10GB/mo (a personal mailbox uses ~0.01GB)
- LLM cost: ~$0.005-0.02 per email reply, capped by Phase 2's `daily_budget_usd_cap=$1`
- Fly.io: no change (same VM, same memory)
- Gmail account: free (no Workspace seat)
- **Total marginal cost: $0/mo**

## 10. Estimated effort

6-8 focused days, ~22-25 commits, distributed across 5 sprints:

| Sprint | Scope | Tasks |
|---|---|---|
| 1 | Foundations: package, schemas, migration (incl. webhook_events table), token store | 4 |
| 2 | Gmail driver (fetch + send + watch) + EmailTransport + normalize + OAuth helpers | 5 |
| 3 | Webhook endpoint with JWT validation + Pub/Sub payload parsing + email.fetch worker job | 4 |
| 4 | Identity auto-merge + MCP tools (send_message channel param + link_email_to_contact) + TransportRegistry | 4 |
| 5 | CLI email:setup (OAuth + initial watch) + cron jobs (fallback poll + watch renew) + wiring + kill switch | 4 |
| 6 | Runbook + GCP setup checklist + deploy + Gate 1b | 3 |

## 11. Out-of-scope follow-ups (Phase 1c+)

- IMAP / Outlook drivers (`EmailDriver` interface is ready)
- Multi-account per workspace (architecture supports it; UX needed)
- Heuristic identity merge (name similarity, etc.)
- Attachments
- Email signature management
- HTML body rendering (currently we send text/plain only)
- Per-contact email rate limiting
- Pub/Sub dead-letter queue for retries beyond Google's default retry policy
