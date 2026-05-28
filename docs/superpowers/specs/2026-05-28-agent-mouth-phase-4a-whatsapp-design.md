# Agent Mouth — Phase 4a Design (WhatsApp transport, Meta Cloud API, reactive)

**Status:** Draft (brainstorming output)
**Date:** 2026-05-28
**Author:** Gavrilo + Claude (brainstorming session 2026-05-28)
**Opens:** Phase 4 (multi-channel expansion) of the vision roadmap (`docs/superpowers/specs/2026-05-20-agent-mouth-vision-design.md` §6). Covers **4a (WhatsApp)** only; 4b (Discord) + 4c (Slack) are separate specs.

---

## 0. Context

Phase 1 is CLOSED (Phase 0 + 1a + 1b + 2 + 3 LIVE in `agent-mouth.fly.dev`). The agent already talks over **Telegram + Email** through the same `processInbound` router, `TransportRegistry`, and `agent.respond` worker.

Phase 4a adds **WhatsApp** as a third channel via the **Meta WhatsApp Cloud API** (official, direct — no BSP). The agent receives WhatsApp messages and replies, exactly as it does for Telegram/email. People (Marco, clients) message the agent's WhatsApp business number and it responds.

Conceptual model: **the agent has its own WhatsApp business number** (a WhatsApp Business Account / WABA phone number), just like it has `@Gavrilux_bot` on Telegram and `gavrilux.agent@gmail.com` on email. No personal WhatsApp account is touched.

The transport layer is already prepared for this: `ChannelType` enum already includes `"whatsapp"` (`packages/core/src/identity.ts:26`), the `Transport` interface is frozen, and `TransportRegistry` is channel-agnostic. **The email transport (Phase 1b) is the structural template** — webhook-driven, `receive()`/`waitForMessages()` return `[]`, auth injected at construction.

## 1. Goals & non-goals

### Goals
- The agent can **receive and reply** to WhatsApp text messages via Meta Cloud API on its own business number.
- Inbound WhatsApp messages flow through the **same `processInbound` router** as Telegram/email.
- `send_message` MCP tool can target `channel: "whatsapp"`.
- **Allow-list by default** (cost/safety): the agent only auto-replies to known/allow-listed senders; unknown numbers are persisted but the agent stays silent.
- Sub-second inbound: Meta pushes the message in the webhook payload itself (no fetch round-trip needed).
- Kill switch via env var (`ENABLE_WHATSAPP_AUTO`) to force silent without code changes.
- Webhook is authenticated: GET verification handshake + `X-Hub-Signature-256` HMAC validation on every POST.

### Non-goals (Phase 4a)
- **No message templates / no proactive messaging.** Reactive only: the agent replies inside Meta's 24-hour customer-service window. It never initiates a conversation or replies outside the window. (This is the single biggest complexity driver and is deliberately out.)
- **No media.** Text messages only — no inbound/outbound images, audio, documents, stickers, location, reactions. (Meta delivers these with different payload shapes; deferred.)
- **No BSP (Twilio/360dialog).** Meta Cloud API direct only. No driver abstraction (see decision #1).
- **No multi-number / multi-tenant.** One WABA phone number, matching the current single-tenant deployment.
- **No DB-backed allow-list UX.** Allow-list is an env var in v1 (see decision #4).
- **Meta provisioning + live activation are OUT OF SCOPE (decision D).** This spec covers the *code* + automated tests with mocked Meta payloads. Creating the Meta Business account, WABA, dedicated number, Meta App, and the live Gate 4a are handled separately by the user and are **deferred** (see §3 "Out of scope" and §7.3).

## 2. Decisions log (from brainstorming session 2026-05-28)

| # | Decision | Rationale |
|---|---|---|
| 1 | **Monolithic `WhatsAppTransport`, no driver layer** (A) | User chose Meta direct and rejected Twilio. One provider = one impl. Email's `EmailDriver` abstraction existed to allow IMAP/Outlook; WhatsApp has no second provider in scope. YAGNI — refactor to a driver only if a BSP is added later. |
| 2 | **Reactive only — no templates** | User decision. Agent replies within the 24h window like any other channel. Templates + Meta approval add friction with no MVP value. |
| 3 | **Text only in v1** (C) | Media has distinct payloads and storage needs. Out for v1. |
| 4 | **Allow-list via `WHATSAPP_ALLOWLIST` env var** (B) | WhatsApp charges per conversation. Default policy for WhatsApp senders = `silent`; only E.164 numbers in the allow-list reach normal policy evaluation (`auto`). Env var is the simplest safe mechanism for a single-user deployment; a DB-backed allow-list/MCP tool is a follow-up. |
| 5 | **Meta WhatsApp Cloud API, direct** | Free hosting by Meta, lowest per-message cost, official, aligned with vision doc §6. Fits the existing webhook pattern. |
| 6 | **No new DB tables; no OAuth token store** | WhatsApp auth is a long-lived System User access token kept as a Fly secret (no OAuth refresh dance, unlike Gmail). Inbound dedup reuses the existing `messages` UNIQUE `(channel_id, external_id)` index (migration 0005), keyed by `wamid`. No `*_oauth_tokens` / `*_webhook_events` tables needed. |
| 7 | **Idempotency via `wamid`** | Meta retries webhooks (at-least-once). Inbound message insert is idempotent on `(channel_id, external_id = wamid)`; the `agent.respond` job uses `singletonKey = wamid` so duplicate deliveries never double-reply. |
| 8 | **Ignore non-message events** | Meta posts `statuses` (sent/delivered/read) to the same webhook. The handler must 200-skip any payload whose `value` has no `messages[]`. |
| 9 | **Meta provisioning + live Gate deferred (D)** | User decision: spec covers code + mocked tests; the Meta-side setup and go-live happen later by the user. |
| 10 | **Reply threading via `context.message_id`** | When the runtime supplies `reply_to_message_id`, map it to WhatsApp's `context.message_id` so replies thread natively. Cheap; included. |

## 3. Architecture overview

```
   META CLOUD                              agent-mouth.fly.dev
  ──────────────                          ───────────────────────

  ┌──────────────┐  user sends WA msg   ┌────────────────────────────┐
  │  WhatsApp    │ ───────────────────► │  HTTP server               │
  │  user (wa_id)│                      │                            │
  └──────────────┘                      │  /telegram-webhook         │
        ▲                               │  /email-webhook            │
        │ Graph API send                │  /whatsapp-webhook    NEW  │
        │                               │  /mcp · /health            │
  ┌──────────────┐                      └──────────┬─────────────────┘
  │ Meta Cloud   │  POST + X-Hub-Sig-256           │
  │ API (WABA)   │ ───────────────────────────────►│ verify sig
  │ phone_number │   {entry[].changes[].value      │ normalize
  │ _id          │     .messages[]}                ▼
  └──────────────┘                        ┌────────────────────────┐
        ▲                                 │ processInbound (router) │
        │ POST /{phone_number_id}/messages│  identity → thread →    │
        │ {type:"text", text:{body}}      │  policy → MessageStore  │
        │                                 └──────────┬─────────────┘
        │                                            │ if policy≠silent
        │                                            ▼  enqueue agent.respond
        │                                 ┌────────────────────────┐
        │                                 │ pg-boss worker          │
        │                                 │  resolve transport by   │
        └─────────────────────────────── │  channelType="whatsapp" │
              WhatsAppTransport.send      │  → runtime → send_message│
                                          └─────────────────────────┘
```

**Inbound path:** Meta posts the message (with `wamid`) to `/whatsapp-webhook` → verify `X-Hub-Signature-256` → `whatsappMessageToInbound()` → `InboundMessageSchema.safeParse()` → `processInbound()` (same router as Telegram/email) → if `policy !== "silent"` enqueue `agent.respond` with `singletonKey = wamid`. No fetch round-trip (unlike email's historyId); the payload carries the message body.

**Outbound path:** worker `agent.respond` resolves transport via `TransportRegistry.get("whatsapp")` → runtime calls `send_message(channel:"whatsapp")` → `WhatsAppTransport.send()` → `POST graph.facebook.com/{ver}/{phone_number_id}/messages`.

### Components (new)
1. `@agent-mouth/transport-whatsapp` — package: `WhatsAppTransport` (implements `Transport`) + `whatsappMessageToInbound` (normalize) + `verifyMetaSignature` + Zod schema for the Meta webhook payload.
2. HTTP endpoints in `serve-http.ts`: `GET /whatsapp-webhook` (verification handshake) + `POST /whatsapp-webhook` (signature validation → normalize → `processInbound` → enqueue).

### Components (modified)
1. `send_message` MCP tool (`packages/api/src/tools/messaging.ts`) — add `"whatsapp"` to the `channel` enum (currently hardcoded `["telegram","email"]`).
2. `serve-http.ts` — bootstrap `WhatsAppTransport` from env, register in `TransportRegistry` as `"whatsapp"`, bootstrap a `whatsapp` channel row (mirroring the telegram/email channel bootstrap), return 503 from the webhook if not configured.
3. Router (`processInbound` / policy evaluation) — apply the WhatsApp allow-list + `ENABLE_WHATSAPP_AUTO` kill switch (force `silent` when sender not allow-listed or switch off), mirroring `ENABLE_EMAIL_AUTO`.
4. Worker `agent.respond` handler — already resolves transport by `channelType` (commit `7ed4b34`); `subject` is email-only and ignored for WhatsApp. No change expected beyond confirming `"whatsapp"` resolves.

### Out of scope — Meta provisioning + live activation (decision D, DEFERRED)
Not part of this deliverable; the user provisions these later, after which the live Gate 4a (§7.3) can run:
- Meta Business account + WhatsApp Business Account (WABA).
- A dedicated phone number registered to the WABA (must NOT be active on a personal WhatsApp app).
- A Meta App (Business type) with the WhatsApp product added → yields `phone_number_id`, `app_secret`, and a permanent **System User** access token.
- Webhook configured in the Meta App dashboard → callback `https://agent-mouth.fly.dev/whatsapp-webhook`, `verify_token` matching `WHATSAPP_VERIFY_TOKEN`, subscribed to the `messages` field.

The code is built **config-driven**: it reads the resulting values from Fly secrets (§5.5). Until they exist, the transport is simply not configured (webhook returns 503), and unit/integration tests run against mocked Meta payloads.

## 4. Data flows

### 4.1 Webhook verification (GET, once at setup — DEFERRED side, but handler is in scope)

```
1. Meta calls GET /whatsapp-webhook?hub.mode=subscribe
       &hub.verify_token=<token>&hub.challenge=<n>
2. Handler: if hub.mode=="subscribe" && hub.verify_token==WHATSAPP_VERIFY_TOKEN
       → respond 200 text/plain body=<hub.challenge>
   else → 403
```

### 4.2 Inbound message (POST, sub-second)

```
1. WhatsApp user sends text to the business number.
2. Meta POSTs /whatsapp-webhook with:
   header X-Hub-Signature-256: sha256=<hmac_sha256(rawBody, WHATSAPP_APP_SECRET)>
   body {object:"whatsapp_business_account", entry:[{changes:[{field:"messages",
         value:{metadata:{phone_number_id}, contacts:[{profile:{name}, wa_id}],
                messages:[{from, id:<wamid>, timestamp, type:"text", text:{body}}]}}]}]}
3. Handler:
   a. Read RAW body (before JSON parse). Compute HMAC-SHA256 with WHATSAPP_APP_SECRET.
      Constant-time compare to X-Hub-Signature-256. Mismatch → 403, log warn.
   b. Parse with WhatsAppWebhookSchema (Zod, .safeParse). Malformed → 200 skipped, log.
   c. If value has `statuses` and no `messages` → 200 skipped (delivery/read receipt).
   d. For each message of type "text":
        whatsappMessageToInbound(value, msg) → InboundMessage{
          channel_type:"whatsapp", external_id:<wamid>, from_handle:<wa_id>,
          body:text.body, display_name:contacts[].profile.name, ...}
   e. InboundMessageSchema.safeParse → processInbound(parsed, routerDeps)
   f. Return 200 immediately (Meta retries on non-2xx).
4. processInbound:
   - IdentityResolver.resolveOrCreate (Contact keyed by wa_id on whatsapp channel)
   - ThreadStore.resolveOrCreate
   - Allow-list + kill-switch gate (see 4.4) → policy
   - MessageStore.insert (idempotent on channel_id + external_id=wamid)
   - if policy != "silent": enqueue agent.respond { ..., channelType:"whatsapp",
       externalChatId: wa_id } with singletonKey = wamid
```

### 4.3 Outbound reply

```
1. Worker.handleRespondJob({channelType:"whatsapp", externalChatId: wa_id, ...})
2. runtime → send_message tool {body, channel:"whatsapp", to:wa_id, reply_to_message_id?}
3. TransportRegistry.get("whatsapp") → WhatsAppTransport.send():
   POST https://graph.facebook.com/${WHATSAPP_GRAPH_VERSION}/${phone_number_id}/messages
   Authorization: Bearer ${WHATSAPP_ACCESS_TOKEN}
   body {messaging_product:"whatsapp", recipient_type:"individual", to:wa_id,
         type:"text", text:{preview_url:false, body},
         context:{message_id: reply_to_message_id}?   // only if provided
        }
   → response {messages:[{id:<wamid>}]} → SentMessage{message_id:wamid, timestamp}
4. MessageStore.add(direction:"out", channel_type:"whatsapp") + audit_log row
```

### 4.4 Allow-list + kill switch (cost/safety gate)

```
In the router (per inbound whatsapp message), before/at policy evaluation:
  - if ENABLE_WHATSAPP_AUTO == "false"  → policy = "silent"
  - else if sender wa_id NOT in WHATSAPP_ALLOWLIST → policy = "silent"
  - else → normal PolicyEngine.evaluate (may be "auto")
Matching is on wa_id format (digits only, no leading "+"); both the inbound `from` and each
allow-list entry are normalized by stripping non-digits before compare. Env vars are read
per-request (no in-process caching); because Fly injects secrets at process start, changing
them requires `flyctl deploy` to take effect. Default for a brand-new WhatsApp contact is
therefore effectively "silent" until allow-listed.
```

## 5. Components & schemas

### 5.1 Package layout

```
packages/transport-whatsapp/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                 # public exports
│   ├── whatsapp-transport.ts    # implements Transport (send; receive/wait → [])
│   ├── normalize.ts             # whatsappMessageToInbound
│   ├── signature.ts             # verifyMetaSignature (X-Hub-Signature-256, constant-time)
│   └── schema.ts                # Zod WhatsAppWebhookSchema (+ text message guard)
└── test/                        # vitest specs
```

### 5.2 WhatsAppTransport (sketch)

```ts
export interface WhatsAppConfig {
  phone_number_id: string;
  access_token: string;       // permanent System User token (Fly secret)
  graph_version?: string;     // default "v21.0"
  display_phone_number?: string;
}

export class WhatsAppTransport implements Transport {
  constructor(private readonly cfg: WhatsAppConfig) {}
  async init(): Promise<void> {}                  // no-op: config injected
  async whoami(): Promise<Identity> {
    return { handle: this.cfg.display_phone_number ?? this.cfg.phone_number_id,
             display_name: "WhatsApp Business" };
  }
  async listContacts(): Promise<Contact[]> { return []; }
  async send(opts: SendOptions): Promise<SentMessage> {
    if (!opts.to) throw new Error("WhatsAppTransport.send: `to` (wa_id) required");
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp", recipient_type: "individual",
      to: opts.to, type: "text",
      text: { preview_url: false, body: opts.body },
    };
    if (opts.reply_to_message_id) body.context = { message_id: opts.reply_to_message_id };
    const res = await fetch(
      `https://graph.facebook.com/${this.cfg.graph_version ?? "v21.0"}/${this.cfg.phone_number_id}/messages`,
      { method:"POST",
        headers:{ Authorization:`Bearer ${this.cfg.access_token}`, "Content-Type":"application/json" },
        body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`WhatsApp send failed ${res.status}: ${await res.text()}`);
    const json = await res.json() as { messages?: { id: string }[] };
    return { message_id: json.messages?.[0]?.id ?? "", timestamp: new Date() };
  }
  async receive(): Promise<ReceivedMessage[]> { return []; }       // webhook-driven
  async waitForMessages(): Promise<ReceivedMessage[]> { return []; }
  async close(): Promise<void> {}
}
```

### 5.3 Zod webhook schema (in `transport-whatsapp/src/schema.ts`)

```ts
export const WhatsAppTextMessageSchema = z.object({
  from: z.string(),                 // wa_id of sender
  id: z.string(),                   // wamid
  timestamp: z.string(),            // unix seconds (string)
  type: z.literal("text"),
  text: z.object({ body: z.string() }),
});

export const WhatsAppValueSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  metadata: z.object({ phone_number_id: z.string(), display_phone_number: z.string().optional() }),
  contacts: z.array(z.object({ profile: z.object({ name: z.string() }).optional(), wa_id: z.string() })).optional(),
  messages: z.array(z.unknown()).optional(),   // narrowed to text via WhatsAppTextMessageSchema
  statuses: z.array(z.unknown()).optional(),   // presence => receipt event, skip
});

export const WhatsAppWebhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(z.object({
    id: z.string(),
    changes: z.array(z.object({ field: z.string(), value: WhatsAppValueSchema })),
  })),
});
```

`normalize.ts` iterates `entry[].changes[]` where `field === "messages"`, skips values with `statuses` and no `messages`, validates each message against `WhatsAppTextMessageSchema` (ignoring non-text), and emits `InboundMessage` objects with `channel_type:"whatsapp"`, `external_id = wamid`, `from_handle = wa_id`, `body = text.body`.

### 5.4 MCP tool change — `send_message`

Add `"whatsapp"` to the enum (and mention it in the description):
```ts
channel: { type: "string", enum: ["telegram", "email", "whatsapp"] }
```
Behavior unchanged: if `channel` omitted, infer from the origin Thread; `to` for WhatsApp is the recipient `wa_id`; `subject` is ignored.

### 5.5 Env vars (Fly secrets)

```
WHATSAPP_PHONE_NUMBER_ID=...        # WABA phone number id (in send URL)
WHATSAPP_ACCESS_TOKEN=...           # permanent System User token
WHATSAPP_APP_SECRET=...             # for X-Hub-Signature-256 verification
WHATSAPP_VERIFY_TOKEN=...           # arbitrary string for GET handshake
WHATSAPP_GRAPH_VERSION=v21.0        # pin Graph API version
WHATSAPP_DISPLAY_PHONE_NUMBER=...   # optional, for whoami
ENABLE_WHATSAPP_TRANSPORT=true      # master switch (503 if false/missing)
ENABLE_WHATSAPP_AUTO=false          # kill switch → silent if false (START false)
WHATSAPP_ALLOWLIST=34XXXXXXXXX,...  # comma-separated wa_id (digits, no +); only these get auto
```

### 5.6 DB
No new migration. Inbound dedup reuses `messages` UNIQUE `(channel_id, external_id)` (migration 0005). A `whatsapp` row in `channels` is bootstrapped at startup from env (mirroring telegram/email), not via migration.

## 6. Error handling & resilience

| Scenario | Detection | Action |
|---|---|---|
| Forged/invalid signature | HMAC mismatch on `X-Hub-Signature-256` | 403, log warn (likely spoof) |
| Malformed payload | Zod `.safeParse` fails | 200 skipped, log warn (never 5xx — avoids Meta retry storms) |
| Status/receipt event | `value.statuses` present, no `messages` | 200 skipped (expected, frequent) |
| Non-text message (image/audio/...) | message `type !== "text"` | 200 skipped, log info (out of scope v1) |
| Duplicate webhook (Meta retry) | `wamid` already in `messages.external_id` | idempotent insert no-ops; `singletonKey=wamid` dedups the job |
| Reply outside 24h window | Graph API error (e.g. 131047) | log error; reactive design means replies are in-window — surfaced if worker lag closes it |
| Access token invalid/expired | Graph 401 on send | log error "rotate WHATSAPP_ACCESS_TOKEN"; reply dropped (no crash) |
| Graph rate limit | 429 | log; rely on worker/pg-boss retry policy |
| Sender not allow-listed | `wa_id` ∉ `WHATSAPP_ALLOWLIST` | persist message, policy `silent` (no reply, no LLM cost) |
| Budget exceeded | reuse Phase 2 `daily_budget_usd_cap` | persist, agent silent |
| Empty body on send | pre-validate | reject; never send empty |

**Kill switch:** `ENABLE_WHATSAPP_AUTO=false` → router forces `policy="silent"` for WhatsApp regardless of allow-list/policy table. Read per-request (no caching); applied once the new env is in the running process (`flyctl secrets set` + `flyctl deploy`, ~1–2 min). `ENABLE_WHATSAPP_TRANSPORT=false` disables the transport entirely (webhook 503).

## 7. Testing strategy

### 7.1 Unit (vitest)
- `transport-whatsapp/signature` (~4): valid sig accepted; wrong secret rejected; tampered body rejected; missing header rejected.
- `transport-whatsapp/schema` (~4): valid text webhook parses; status-only event recognized; malformed rejected; non-text message recognized.
- `transport-whatsapp/normalize` (~5): single text msg → InboundMessage; multiple messages in one payload; status event → []; non-text skipped; missing contact name tolerated.
- `transport-whatsapp/whatsapp-transport.send` (~5): builds correct Graph body; adds `context` when `reply_to_message_id` set; omits it otherwise; maps response wamid; throws on non-200.
- `api/send-message` (~3): `channel:"whatsapp"` resolves WhatsApp transport; infers whatsapp from thread; `subject` ignored.
- `api/whatsapp-webhook` handler (~5): valid POST → processInbound called + 200; bad signature → 403; status event → 200 skipped; malformed → 200 skipped; GET handshake echoes challenge on token match / 403 on mismatch.
- `router/allowlist` (~4): allow-listed sender → auto; non-listed → silent; `ENABLE_WHATSAPP_AUTO=false` → silent; allow-list empty → all silent.

### 7.2 Integration (vitest, Supabase real)
- `whatsapp-flow.test.ts`: insert `whatsapp` channel → POST signed webhook with a text message → assert Contact/Thread/Message persisted + (if allow-listed) `agent.respond` enqueued with `singletonKey=wamid`.
- `whatsapp-idempotency.test.ts`: POST the same `wamid` twice → exactly one `messages` row, one job.
- `whatsapp-allowlist.test.ts`: non-allow-listed sender → message persisted, no job.

### 7.3 E2E — Gate 4a (DEFERRED until Meta provisioning, decision D)
*Cannot run until the user completes the out-of-scope Meta setup (§3). Documented here as the acceptance gate for go-live.*
1. A WhatsApp user (an allow-listed number) messages the agent's business number: `"phase-4a gate test, responde 'gate ok'"`.
2. Within ≤60s the user receives a WhatsApp reply containing "gate ok".
3. `read_inbox` from Claude Code shows Telegram + Email + WhatsApp messages mixed by timestamp.
4. `audit_log` shows `whatsapp.received` + `agent.respond.completed` + `whatsapp.sent`.
5. Non-allow-listed number messaging → persisted, no reply.
6. `ENABLE_WHATSAPP_AUTO=false` → message persists, no auto-reply.

## 8. Deployment plan

**In scope (code):** package + webhook handlers + send_message enum + allow-list/kill-switch + tests. Mergeable and deployable behind `ENABLE_WHATSAPP_TRANSPORT` (defaults off / 503) with zero impact on Telegram/email.

**Deferred (live activation, decision D):** Meta provisioning (§3), setting the `WHATSAPP_*` Fly secrets, configuring the Meta webhook callback, and running Gate 4a.

### 8.1 Deploy sequence (code-side, safe to do now)
```
1. Merge feat/phase-4a-whatsapp → main with ENABLE_WHATSAPP_TRANSPORT unset (transport inert, 503).
2. flyctl deploy (rolling) — no behavior change to existing channels.
3. Verify: GET /health still ok; /whatsapp-webhook returns 503 (not configured).
```
### 8.2 Go-live sequence (after Meta provisioning — DEFERRED)
```
4. flyctl secrets set WHATSAPP_PHONE_NUMBER_ID WHATSAPP_ACCESS_TOKEN WHATSAPP_APP_SECRET
                      WHATSAPP_VERIFY_TOKEN WHATSAPP_GRAPH_VERSION
                      ENABLE_WHATSAPP_TRANSPORT=true ENABLE_WHATSAPP_AUTO=false
                      WHATSAPP_ALLOWLIST=<your numbers>
5. flyctl deploy
6. Configure Meta App webhook → https://agent-mouth.fly.dev/whatsapp-webhook (GET handshake passes).
7. Send a test WhatsApp → verify logs "whatsapp message received" + messages row in <5s.
8. flyctl secrets set ENABLE_WHATSAPP_AUTO=true && flyctl deploy
9. Run Gate 4a.
```
### 8.3 Rollback
| Symptom | Immediate action |
|---|---|
| Agent replying badly | `flyctl secrets set ENABLE_WHATSAPP_AUTO=false && flyctl deploy` |
| Any WhatsApp issue | `flyctl secrets set ENABLE_WHATSAPP_TRANSPORT=false && flyctl deploy` (webhook 503) |

## 9. Cost analysis
- Meta Cloud API hosting: **free** (Meta-hosted). 
- WhatsApp messaging: **conversation-based pricing** (per 24h conversation, varies by country/category; service conversations have a monthly free tier). Reactive + allow-list keeps volume to known contacts → low. This is the only channel with a per-message cost (vision doc §6).
- LLM cost: ~$0.005–0.02 per reply, capped by Phase 2 `daily_budget_usd_cap=$1`.
- Fly.io: no change (same VM). 
- **Marginal infra cost: ~$0/mo; WhatsApp conversation fees scale with allow-listed traffic only.**

## 10. Estimated effort
~3–4 focused days, ~12–16 commits (lower than email — no OAuth, no driver, no token store, no polling/watch crons).

| Sprint | Scope | Tasks |
|---|---|---|
| 1 | Package scaffold: schema (Zod) + signature verify + normalize + unit tests | 4 |
| 2 | `WhatsAppTransport.send` (Graph API) + unit tests | 3 |
| 3 | `/whatsapp-webhook` GET+POST in serve-http + bootstrap/register transport + channel row + send_message enum | 4 |
| 4 | Allow-list + kill switch in router + integration tests + runbook (+ deferred Gate 4a doc) | 4 |

## 11. Out-of-scope follow-ups (Phase 4a+)
- **Templates / proactive messaging** (write first / outside 24h window) — requires Meta-approved templates.
- **Media** (images, audio, documents, location, reactions) inbound + outbound.
- **DB-backed allow-list + MCP tool** to manage allowed contacts without redeploy.
- **Multi-number / multi-tenant** WABA support.
- **BSP driver** (Twilio/360dialog) if direct Meta proves limiting — would reintroduce a driver abstraction.
- **4b (Discord)** and **4c (Slack)** — separate specs, reuse this transport + webhook pattern.
- Interactive messages (buttons / list replies), read receipts surfaced to the agent.
