# Agent Mouth — Phase 1b (EmailTransport + cross-channel inbox) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Gmail-backed EmailTransport so the agent has its own email identity (`gavrilux.agent@gmail.com`), can receive emails via Pub/Sub push webhook (<5s latency) with polling fallback (every 10min), can send emails via Gmail API, and supports cross-channel inbox + identity auto-merge with the Telegram channel that's already in production.

**Architecture:** New `@agent-mouth/transport-email` package implementing the existing `Transport` interface via a pluggable `EmailDriver` (Gmail is the only shipped driver; IMAP/Outlook are future). New HTTP endpoint `POST /email-webhook` validates Google-signed JWT tokens and enqueues `email.fetch` worker jobs. Two new cron jobs (`email.poll.fallback` every 10min as safety net, `email.watch.renew` every 6 days). New Supabase migration (`0005`) adds `email_oauth_tokens` (with AES-256-GCM-encrypted refresh tokens) and `email_webhook_events` (idempotency dedup), plus `contacts.metadata jsonb` for identity auto-merge. `SupabaseIdentityResolver` extended to check `metadata.email_addresses[]` before creating duplicate Contacts. `send_message` MCP tool gains optional `channel` and `subject` params; new `link_email_to_contact` MCP tool. New `TransportRegistry` resolves the right transport per `ChannelType`. Kill switch `ENABLE_EMAIL_AUTO=false` forces email policy to silent at the router layer.

**Tech Stack:** TypeScript 5.5 · Node 20 · pnpm monorepo · Vitest 2.1 · Zod · Gmail API (REST) · Google Pub/Sub push subscription · Google OIDC JWT verification (jose) · AES-256-GCM (node:crypto) · pg-boss recurring jobs · Fly.io.

**Spec reference:** `docs/superpowers/specs/2026-05-25-agent-mouth-phase-1b-design.md`

---

## Branch strategy

All work happens on `feat/phase-1b-email-transport` branched from `main` (already created with 2 spec commits). Merge to main only after Gate 1b passes in production.

---

## File structure overview

### New package

```
packages/transport-email/
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── src/
│   ├── index.ts                      # public exports
│   ├── email-transport.ts            # implements Transport (Phase 0 interface)
│   ├── types.ts                      # SendEmailArgs + driver shared types
│   ├── drivers/
│   │   ├── driver.ts                 # EmailDriver interface
│   │   └── gmail-driver.ts           # GmailDriver concrete impl
│   ├── normalize.ts                  # gmailMessageToInbound (NormalizedEmail → InboundMessage)
│   ├── mime.ts                       # buildMime, parseHeaders, decodeBody
│   ├── oauth/
│   │   ├── google.ts                 # URL builder, code exchange, refresh
│   │   └── crypto.ts                 # AES-256-GCM encrypt/decrypt
│   └── webhook/
│       ├── jwt.ts                    # Google OIDC JWT validator
│       └── pubsub-payload.ts         # Pub/Sub envelope parser + Zod schema
└── tests/
    ├── normalize.test.ts
    ├── mime.test.ts
    ├── gmail-driver.test.ts
    ├── oauth-crypto.test.ts
    ├── oauth-google.test.ts
    ├── webhook-jwt.test.ts
    └── webhook-payload.test.ts
```

### New files in existing packages

```
packages/core/src/email.ts                                # EmailTokenSchema, NormalizedEmailSchema
packages/storage-supabase/src/email-token-store.ts         # SupabaseEmailTokenStore
packages/storage-supabase/src/email-webhook-events-store.ts # SupabaseEmailWebhookEventsStore
packages/api/src/transports/registry.ts                    # TransportRegistry
packages/api/src/tools/link-email-to-contact.ts            # new MCP tool
packages/api/src/cli/email-setup.ts                        # OAuth flow CLI
supabase/migrations/0005_email_transport.sql               # migration
docs/runbooks/2026-05-25-phase-1b-rollout.md               # operator runbook
```

### Modified files

```
packages/core/src/identity.ts              # ContactSchema.metadata field
packages/core/src/transport.ts             # SendOptions adds optional `subject`
packages/core/src/index.ts                 # export email schemas
packages/storage-supabase/src/identity-resolver.ts  # auto-merge logic
packages/storage-supabase/src/index.ts     # export new stores
packages/api/src/tools/messaging.ts        # send_message accepts channel + subject
packages/api/src/router.ts                 # kill switch logic
packages/api/src/worker.ts                 # email.fetch/email.poll.fallback/email.watch.renew handlers
packages/api/src/cli/serve-http.ts         # bootstrap EmailTransport + /email-webhook + crons
packages/api/src/cli/index.ts              # wire email:setup command
packages/api/package.json                  # add jose dependency
fly.toml                                   # no change needed (no new volume)
```

---

## Dependencies & parallelization

```
Sprint 1 (Foundations) ── must complete first ──┐
   T1 → T2 → T3 → T4                            │
                                                │
                                                ▼
Sprint 2 (Gmail driver) ── T5 → [T6 ‖ T7 ‖ T8] → T9 → T10
                                                │
                                                ▼
Sprint 3 (Webhook + JWT) ── [T11 ‖ T12] → T13 → T14
                                                │
                                                ▼
Sprint 4 (Identity + MCP) ── [T15 ‖ T16 ‖ T17 ‖ T18]
                                                │
                                                ▼
Sprint 5 (CLI + cron) ── T19 → T20 → T21 → T22
                                                │
                                                ▼
Sprint 6 (Deploy + Gate) ── T23 → T24 → T25
```

`‖` = parallelizable when dispatched as separate subagents.

---

## Sprint 1 — Foundations (T1 → T4, sequential)

### Task 1: Scaffold `@agent-mouth/transport-email` package

**Files:**
- Create: `packages/transport-email/package.json`
- Create: `packages/transport-email/tsconfig.json`
- Create: `packages/transport-email/vitest.config.ts`
- Create: `packages/transport-email/src/index.ts` (empty stub)
- Modify: `pnpm-workspace.yaml` (no change if `packages/*` already covers it — verify)

- [ ] **Step 1: Create package.json**

```json
{
  "name": "@agent-mouth/transport-email",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "./dist/index.js",
  "exports": { ".": "./dist/index.js" },
  "files": ["dist/"],
  "scripts": {
    "build": "tsc",
    "test": "vitest run"
  },
  "dependencies": {
    "@agent-mouth/core": "workspace:*",
    "jose": "^5.9.0"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "typescript": "5.5.4",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ES2022"],
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true,
    "resolveJsonModule": true
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "tests"]
}
```

- [ ] **Step 3: Create vitest.config.ts**

```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

- [ ] **Step 4: Create src/index.ts (empty placeholder, real exports added later)**

```ts
// public exports will be added as tasks land
export {};
```

- [ ] **Step 5: Install deps and verify scaffolding builds**

Run:
```bash
cd /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth
pnpm install
pnpm --filter @agent-mouth/transport-email build
```

Expected: clean build, `dist/index.js` created.

- [ ] **Step 6: Commit**

```bash
git add packages/transport-email/
git commit -m "feat(transport-email): scaffold package (T1)"
```

---

### Task 2: New Zod schemas in `@agent-mouth/core/email.ts` + extend `ContactSchema`

**Files:**
- Create: `packages/core/src/email.ts`
- Modify: `packages/core/src/identity.ts` (extend ContactSchema)
- Modify: `packages/core/src/transport.ts` (extend SendOptions with optional subject)
- Modify: `packages/core/src/index.ts` (re-export email.ts)
- Test: `packages/core/tests/email.test.ts` (create) + extend existing identity test if any

- [ ] **Step 1: Create test file for new schemas**

Create `packages/core/tests/email.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  EmailTokenSchema,
  NormalizedEmailSchema,
} from "../src/email.js";
import { ContactSchema } from "../src/identity.js";

describe("EmailTokenSchema", () => {
  const base = {
    id: "00000000-0000-0000-0000-000000000001",
    workspace_id: "00000000-0000-0000-0000-000000000002",
    channel_id: "00000000-0000-0000-0000-000000000003",
    email_address: "gavrilux.agent@gmail.com",
    refresh_token_encrypted: "base64ciphertext",
    scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    last_history_id: "12345",
    watch_expiration: "2026-06-01T00:00:00.000Z",
    status: "active" as const,
    last_error: null,
    consecutive_renewal_failures: 0,
    created_at: "2026-05-25T00:00:00.000Z",
    updated_at: "2026-05-25T00:00:00.000Z",
  };

  it("accepts a valid row", () => {
    expect(EmailTokenSchema.parse(base)).toEqual(base);
  });

  it("defaults status to active", () => {
    const { status: _s, ...rest } = base;
    const parsed = EmailTokenSchema.parse(rest);
    expect(parsed.status).toBe("active");
  });

  it("rejects invalid email", () => {
    expect(() => EmailTokenSchema.parse({ ...base, email_address: "not-email" })).toThrow();
  });
});

describe("NormalizedEmailSchema", () => {
  const base = {
    external_id: "abc123",
    external_thread_id: "thr456",
    from_address: "marco@thecuina.com",
    from_name: "Marco",
    to_addresses: ["gavrilux.agent@gmail.com"],
    cc_addresses: [],
    subject: "Hello",
    body_text: "Hi Gavrilux",
    body_html: null,
    message_id_header: "<msg123@gmail.com>",
    in_reply_to_header: null,
    references_header: [],
    received_at: "2026-05-25T10:00:00.000Z",
  };

  it("accepts valid", () => {
    expect(NormalizedEmailSchema.parse(base)).toEqual(base);
  });

  it("defaults cc_addresses to empty array", () => {
    const { cc_addresses: _, ...rest } = base;
    expect(NormalizedEmailSchema.parse(rest).cc_addresses).toEqual([]);
  });

  it("rejects invalid from_address", () => {
    expect(() => NormalizedEmailSchema.parse({ ...base, from_address: "x" })).toThrow();
  });
});

describe("ContactSchema.metadata", () => {
  const baseContact = {
    id: "00000000-0000-0000-0000-000000000001",
    workspace_id: "00000000-0000-0000-0000-000000000002",
    display_name: "Marco",
    notes: "",
    created_at: "2026-05-25T00:00:00.000Z",
  };

  it("defaults metadata to empty object when absent", () => {
    const parsed = ContactSchema.parse(baseContact);
    expect(parsed.metadata).toEqual({});
  });

  it("accepts email_addresses array", () => {
    const parsed = ContactSchema.parse({
      ...baseContact,
      metadata: { email_addresses: ["marco@thecuina.com"] },
    });
    expect(parsed.metadata.email_addresses).toEqual(["marco@thecuina.com"]);
  });

  it("passthrough unknown metadata keys", () => {
    const parsed = ContactSchema.parse({
      ...baseContact,
      metadata: { email_addresses: [], custom_field: "x" },
    });
    expect((parsed.metadata as Record<string, unknown>).custom_field).toBe("x");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run:
```bash
pnpm --filter @agent-mouth/core test -- tests/email.test.ts
```

Expected: FAIL — `EmailTokenSchema` and `NormalizedEmailSchema` not exported.

- [ ] **Step 3: Create `packages/core/src/email.ts`**

```ts
// packages/core/src/email.ts
import { z } from "zod";

export const EmailTokenStatusEnum = z.enum(["active", "error", "revoked"]);
export type EmailTokenStatus = z.infer<typeof EmailTokenStatusEnum>;

export const EmailTokenSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  channel_id: z.string().uuid(),
  email_address: z.string().email(),
  refresh_token_encrypted: z.string(),
  scopes: z.array(z.string()).default([]),
  last_history_id: z.string().nullable().default(null),
  watch_expiration: z.string().datetime({ offset: true }).nullable().default(null),
  status: EmailTokenStatusEnum.default("active"),
  last_error: z.string().nullable().default(null),
  consecutive_renewal_failures: z.number().int().nonnegative().default(0),
  created_at: z.string().datetime({ offset: true }),
  updated_at: z.string().datetime({ offset: true }),
});
export type EmailToken = z.infer<typeof EmailTokenSchema>;

export const NormalizedEmailSchema = z.object({
  external_id: z.string().min(1),
  external_thread_id: z.string().min(1),
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

export const EmailWebhookEventSchema = z.object({
  id: z.string().uuid(),
  email_address: z.string().email(),
  history_id: z.string(),
  received_at: z.string().datetime({ offset: true }),
});
export type EmailWebhookEvent = z.infer<typeof EmailWebhookEventSchema>;
```

- [ ] **Step 4: Extend `ContactSchema` in `packages/core/src/identity.ts`**

Find:
```ts
export const ContactSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  display_name: z.string().min(1),
  notes: z.string().default(""),
  created_at: z.string().datetime({ offset: true }),
});
```

Replace with:
```ts
export const ContactSchema = z.object({
  id: z.string().uuid(),
  workspace_id: z.string().uuid(),
  display_name: z.string().min(1),
  notes: z.string().default(""),
  metadata: z.object({
    email_addresses: z.array(z.string().email()).default([]),
  }).passthrough().default({}),
  created_at: z.string().datetime({ offset: true }),
});
```

- [ ] **Step 5: Extend `SendOptions` in `packages/core/src/transport.ts`**

Find:
```ts
export interface SendOptions {
  to?: string; // handle, or "broadcast" / undefined
  body: string;
  reply_to_message_id?: string;
}
```

Replace with:
```ts
export interface SendOptions {
  to?: string; // handle, or "broadcast" / undefined
  body: string;
  reply_to_message_id?: string;
  /** Email-only: subject line. Ignored by non-email transports. */
  subject?: string;
}
```

- [ ] **Step 6: Add export to `packages/core/src/index.ts`**

Find:
```ts
export * from "./tools.js";
```

Add after:
```ts
export * from "./email.js";
```

- [ ] **Step 7: Run tests to verify they pass**

Run:
```bash
pnpm --filter @agent-mouth/core test
```

Expected: all green, including the new email.test.ts (8 assertions).

- [ ] **Step 8: Typecheck**

Run:
```bash
pnpm -r typecheck
```

Expected: clean (no errors caused by new metadata field — passthrough preserves backward compat).

- [ ] **Step 9: Commit**

```bash
git add packages/core/src/email.ts packages/core/src/identity.ts packages/core/src/transport.ts packages/core/src/index.ts packages/core/tests/email.test.ts
git commit -m "feat(core): EmailToken + NormalizedEmail schemas + Contact.metadata + SendOptions.subject (T2)"
```

---

### Task 3: Supabase migration `0005_email_transport.sql`

**Files:**
- Create: `packages/storage-supabase/sql/0005_email_transport.sql`

- [ ] **Step 1: Create migration file**

```sql
-- Phase 1b schema — EmailTransport (Gmail OAuth + Pub/Sub webhook)
-- Spec: docs/superpowers/specs/2026-05-25-agent-mouth-phase-1b-design.md §5.5

-- contacts.metadata jsonb (identity auto-merge)
ALTER TABLE contacts ADD COLUMN IF NOT EXISTS metadata jsonb NOT NULL DEFAULT '{}'::jsonb;
CREATE INDEX IF NOT EXISTS contacts_email_addresses_gin
  ON contacts USING gin ((metadata -> 'email_addresses'));

-- email_oauth_tokens — encrypted refresh tokens + Gmail watch state
CREATE TABLE IF NOT EXISTS email_oauth_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  channel_id uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
  email_address text NOT NULL,
  refresh_token_encrypted text NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY[]::text[],
  last_history_id text,
  watch_expiration timestamptz,
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

-- email_webhook_events — dedup at-least-once Pub/Sub delivery
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
CREATE INDEX IF NOT EXISTS email_webhook_events_received_at_idx
  ON email_webhook_events (received_at);

-- dedup index on messages (idempotency across webhook + polling paths)
CREATE UNIQUE INDEX IF NOT EXISTS messages_channel_external_uniq
  ON messages (channel_id, external_id) WHERE external_id IS NOT NULL;
```

- [ ] **Step 2: Validate SQL syntactically (dry-run against test Supabase or use a Postgres lint)**

```bash
# Optional but recommended: copy SQL into Supabase SQL editor and run EXPLAIN
# or apply against a throwaway local Postgres:
# docker run --rm -e POSTGRES_PASSWORD=x -d -p 55432:5432 postgres:16
# psql -h localhost -p 55432 -U postgres -f packages/storage-supabase/sql/0005_email_transport.sql
```

The migration is idempotent (`IF NOT EXISTS` everywhere) so it can be re-run safely.

- [ ] **Step 3: Commit**

```bash
git add packages/storage-supabase/sql/0005_email_transport.sql
git commit -m "feat(storage-supabase): migration 0005 — email_oauth_tokens, email_webhook_events, contacts.metadata (T3)"
```

> **Note:** the migration is NOT applied to production yet. Application happens in Task 24.

---

### Task 4: AES-256-GCM crypto + `SupabaseEmailTokenStore` + `SupabaseEmailWebhookEventsStore`

**Files:**
- Create: `packages/transport-email/src/oauth/crypto.ts`
- Create: `packages/transport-email/tests/oauth-crypto.test.ts`
- Create: `packages/storage-supabase/src/email-token-store.ts`
- Create: `packages/storage-supabase/src/email-webhook-events-store.ts`
- Modify: `packages/storage-supabase/src/index.ts` (export new stores)

- [ ] **Step 1: Write failing tests for crypto helpers**

Create `packages/transport-email/tests/oauth-crypto.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { decryptToken, encryptToken } from "../src/oauth/crypto.js";

const KEY_HEX = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 32 bytes

describe("encryptToken / decryptToken", () => {
  it("round-trips a token", () => {
    const plain = "1//abc123refresh_token_value";
    const ct = encryptToken(plain, KEY_HEX);
    expect(ct).not.toBe(plain);
    expect(decryptToken(ct, KEY_HEX)).toBe(plain);
  });

  it("produces different ciphertext per call (random IV)", () => {
    const plain = "secret";
    const ct1 = encryptToken(plain, KEY_HEX);
    const ct2 = encryptToken(plain, KEY_HEX);
    expect(ct1).not.toBe(ct2);
    expect(decryptToken(ct1, KEY_HEX)).toBe(plain);
    expect(decryptToken(ct2, KEY_HEX)).toBe(plain);
  });

  it("throws on wrong key", () => {
    const plain = "secret";
    const ct = encryptToken(plain, KEY_HEX);
    const wrongKey = "ff".repeat(32);
    expect(() => decryptToken(ct, wrongKey)).toThrow();
  });

  it("throws on truncated ciphertext", () => {
    expect(() => decryptToken("aGVsbG8=", KEY_HEX)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
pnpm --filter @agent-mouth/transport-email test
```

Expected: FAIL — `oauth/crypto.js` not found.

- [ ] **Step 3: Create `packages/transport-email/src/oauth/crypto.ts`**

```ts
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;       // 96 bits — recommended for GCM
const TAG_LEN = 16;      // 128 bits

function keyToBuffer(hex: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(hex)) {
    throw new Error("AGENT_MOUTH_TOKEN_ENCRYPTION_KEY must be 32 bytes hex (64 chars)");
  }
  return Buffer.from(hex, "hex");
}

/**
 * AES-256-GCM encrypt. Output format: base64(iv || ciphertext || authTag).
 * Different IV per call → ciphertext is non-deterministic.
 */
export function encryptToken(plaintext: string, keyHex: string): string {
  const key = keyToBuffer(keyHex);
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, ct, tag]).toString("base64");
}

/**
 * Reverse of encryptToken. Throws on wrong key, truncated input, or tampered ciphertext.
 */
export function decryptToken(b64: string, keyHex: string): string {
  const key = keyToBuffer(keyHex);
  const buf = Buffer.from(b64, "base64");
  if (buf.length < IV_LEN + TAG_LEN + 1) {
    throw new Error("ciphertext too short");
  }
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(buf.length - TAG_LEN);
  const ct = buf.subarray(IV_LEN, buf.length - TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @agent-mouth/transport-email test
```

Expected: PASS (4 tests in oauth-crypto.test.ts).

- [ ] **Step 5: Create `SupabaseEmailTokenStore`**

Create `packages/storage-supabase/src/email-token-store.ts`:

```ts
import type { EmailToken } from "@agent-mouth/core";
import { EmailTokenSchema } from "@agent-mouth/core";

export interface SupabaseEmailTokenStoreOptions {
  url: string;
  anonKey: string;
}

export class SupabaseEmailTokenStore {
  constructor(private readonly opts: SupabaseEmailTokenStoreOptions) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.opts.anonKey,
      Authorization: `Bearer ${this.opts.anonKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  async list(workspaceId?: string): Promise<EmailToken[]> {
    const wsClause = workspaceId ? `workspace_id=eq.${workspaceId}&` : "";
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?${wsClause}select=*`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`email_oauth_tokens list failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.map((r) => EmailTokenSchema.parse(r));
  }

  async getByAddress(workspaceId: string, email: string): Promise<EmailToken | null> {
    const enc = encodeURIComponent(email.toLowerCase());
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?workspace_id=eq.${workspaceId}&email_address=eq.${enc}&select=*&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`email_oauth_tokens get failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length ? EmailTokenSchema.parse(rows[0]) : null;
  }

  async upsert(row: Omit<EmailToken, "id" | "created_at" | "updated_at"> & { id?: string }): Promise<EmailToken> {
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?on_conflict=workspace_id,email_address`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ Prefer: "return=representation,resolution=merge-duplicates" }),
      body: JSON.stringify({ ...row, email_address: row.email_address.toLowerCase(), updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`email_oauth_tokens upsert failed: ${res.status} ${await res.text()}`);
    const rows = (await res.json()) as unknown[];
    return EmailTokenSchema.parse(rows[0]);
  }

  async updateCursor(id: string, historyId: string): Promise<void> {
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?id=eq.${id}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ last_history_id: historyId, updated_at: new Date().toISOString() }),
    });
    if (!res.ok) throw new Error(`email_oauth_tokens updateCursor failed: ${res.status}`);
  }

  async updateWatchExpiration(id: string, expiration: string): Promise<void> {
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?id=eq.${id}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({
        watch_expiration: expiration,
        consecutive_renewal_failures: 0,
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`email_oauth_tokens updateWatchExpiration failed: ${res.status}`);
  }

  async markError(id: string, err: string): Promise<void> {
    const url = `${this.opts.url}/rest/v1/email_oauth_tokens?id=eq.${id}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({
        status: "error",
        last_error: err.slice(0, 1000),
        updated_at: new Date().toISOString(),
      }),
    });
    if (!res.ok) throw new Error(`email_oauth_tokens markError failed: ${res.status}`);
  }

  async incrementRenewalFailures(id: string): Promise<number> {
    // Use rpc would be cleaner but for simplicity do a fetch+patch
    const cur = await fetch(
      `${this.opts.url}/rest/v1/email_oauth_tokens?id=eq.${id}&select=consecutive_renewal_failures`,
      { headers: this.headers() },
    );
    if (!cur.ok) throw new Error(`renewalFailures read failed: ${cur.status}`);
    const rows = (await cur.json()) as Array<{ consecutive_renewal_failures: number }>;
    const next = (rows[0]?.consecutive_renewal_failures ?? 0) + 1;
    const upd = await fetch(`${this.opts.url}/rest/v1/email_oauth_tokens?id=eq.${id}`, {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify({ consecutive_renewal_failures: next, updated_at: new Date().toISOString() }),
    });
    if (!upd.ok) throw new Error(`renewalFailures inc failed: ${upd.status}`);
    return next;
  }
}
```

- [ ] **Step 6: Create `SupabaseEmailWebhookEventsStore`**

Create `packages/storage-supabase/src/email-webhook-events-store.ts`:

```ts
export interface SupabaseEmailWebhookEventsStoreOptions {
  url: string;
  anonKey: string;
}

export class SupabaseEmailWebhookEventsStore {
  constructor(private readonly opts: SupabaseEmailWebhookEventsStoreOptions) {}

  private headers(extra: Record<string, string> = {}) {
    return {
      apikey: this.opts.anonKey,
      Authorization: `Bearer ${this.opts.anonKey}`,
      "Content-Type": "application/json",
      ...extra,
    };
  }

  /**
   * Inserts the (email_address, history_id) row. Returns true if inserted (first time),
   * false if it already existed (duplicate webhook). Used for at-least-once dedup.
   */
  async recordOnce(emailAddress: string, historyId: string): Promise<boolean> {
    const url = `${this.opts.url}/rest/v1/email_webhook_events`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers({ Prefer: "return=minimal" }),
      body: JSON.stringify({ email_address: emailAddress.toLowerCase(), history_id: historyId }),
    });
    if (res.status === 201) return true;
    if (res.status === 409) return false;        // UNIQUE violation → duplicate
    throw new Error(`email_webhook_events insert failed: ${res.status} ${await res.text()}`);
  }
}
```

- [ ] **Step 7: Export new stores from `packages/storage-supabase/src/index.ts`**

Add:
```ts
export { SupabaseEmailTokenStore } from "./email-token-store.js";
export type { SupabaseEmailTokenStoreOptions } from "./email-token-store.js";
export { SupabaseEmailWebhookEventsStore } from "./email-webhook-events-store.js";
export type { SupabaseEmailWebhookEventsStoreOptions } from "./email-webhook-events-store.js";
```

- [ ] **Step 8: Typecheck**

```bash
pnpm -r typecheck
```

Expected: clean.

- [ ] **Step 9: Build**

```bash
pnpm --filter @agent-mouth/storage-supabase build
pnpm --filter @agent-mouth/transport-email build
```

Expected: clean build.

- [ ] **Step 10: Commit**

```bash
git add packages/transport-email/src/oauth/ packages/transport-email/tests/oauth-crypto.test.ts \
        packages/storage-supabase/src/email-token-store.ts \
        packages/storage-supabase/src/email-webhook-events-store.ts \
        packages/storage-supabase/src/index.ts
git commit -m "feat(storage-supabase, transport-email): AES-GCM crypto + EmailToken/WebhookEvents stores (T4)"
```

---

## Sprint 2 — Gmail driver + EmailTransport (T5 → T10)

### Task 5: EmailDriver interface + shared types

**Files:**
- Create: `packages/transport-email/src/drivers/driver.ts`
- Create: `packages/transport-email/src/types.ts`
- Modify: `packages/transport-email/src/index.ts` (re-export)

- [ ] **Step 1: Create `src/types.ts`**

```ts
// packages/transport-email/src/types.ts
import type { NormalizedEmail } from "@agent-mouth/core";

export interface SendEmailArgs {
  /** From-address (matches the EmailToken.email_address used to authenticate) */
  from_address: string;
  to_addresses: string[];
  cc_addresses?: string[];
  subject: string;
  body_text: string;
  in_reply_to?: string;          // RFC822 Message-ID header value
  references?: string[];         // accumulated thread references
}

export interface SendEmailResult {
  message_id: string;            // Gmail message id
  thread_id: string;             // Gmail threadId
}

export interface FetchResult {
  messages: NormalizedEmail[];
  next_cursor: string;           // new historyId (or empty if unchanged)
}

export interface WatchResult {
  history_id: string;            // historyId at watch creation time
  expiration: string;            // ISO 8601 — when this watch expires (~7 days out)
}

/** Per-token state injected into the driver before each call */
export interface EmailDriverAuthCtx {
  refresh_token: string;
  email_address: string;
}
```

- [ ] **Step 2: Create `src/drivers/driver.ts`**

```ts
// packages/transport-email/src/drivers/driver.ts
import type {
  EmailDriverAuthCtx,
  FetchResult,
  SendEmailArgs,
  SendEmailResult,
  WatchResult,
} from "../types.js";

export interface EmailDriver {
  readonly kind: "gmail" | "imap" | string;

  /** OAuth scopes required for fetch/send/watch. Used during email:setup. */
  readonly requiredScopes: string[];

  /** Returns the email address associated with the auth context. */
  whoami(auth: EmailDriverAuthCtx): Promise<{ email_address: string }>;

  /** Fetch new messages since `last_cursor` (historyId for Gmail). */
  fetchNewMessages(args: {
    auth: EmailDriverAuthCtx;
    last_cursor: string;
  }): Promise<FetchResult>;

  /** Send an outbound email. */
  send(args: { auth: EmailDriverAuthCtx; payload: SendEmailArgs }): Promise<SendEmailResult>;

  /** Create or refresh a Pub/Sub push watch on INBOX. */
  watch(args: { auth: EmailDriverAuthCtx; topic_name: string }): Promise<WatchResult>;
}
```

- [ ] **Step 3: Re-export from `src/index.ts`**

Replace placeholder content:
```ts
export type { EmailDriver } from "./drivers/driver.js";
export type {
  EmailDriverAuthCtx,
  FetchResult,
  SendEmailArgs,
  SendEmailResult,
  WatchResult,
} from "./types.js";
```

- [ ] **Step 4: Build**

```bash
pnpm --filter @agent-mouth/transport-email build
```

Expected: clean build, no test changes (interface only).

- [ ] **Step 5: Commit**

```bash
git add packages/transport-email/src/drivers/driver.ts packages/transport-email/src/types.ts packages/transport-email/src/index.ts
git commit -m "feat(transport-email): EmailDriver interface + shared types (T5)"
```

---

### Task 6: `gmailMessageToInbound` normalizer + Gmail message parser

> **Parallelizable with T7, T8** (all read-only, no cross-dependency).

**Files:**
- Create: `packages/transport-email/src/normalize.ts`
- Create: `packages/transport-email/tests/normalize.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/transport-email/tests/normalize.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { gmailMessageToInbound, gmailMessageToNormalized } from "../src/normalize.js";

// Real-shaped Gmail API payload (users.messages.get format=full)
const gmailMsg = {
  id: "abc123",
  threadId: "thr456",
  labelIds: ["INBOX"],
  internalDate: "1716638400000",
  payload: {
    mimeType: "multipart/alternative",
    headers: [
      { name: "From", value: "Marco <marco@thecuina.com>" },
      { name: "To", value: "gavrilux.agent@gmail.com" },
      { name: "Subject", value: "Hello" },
      { name: "Date", value: "Mon, 25 May 2026 10:00:00 +0200" },
      { name: "Message-ID", value: "<msg123@mail.thecuina.com>" },
      { name: "In-Reply-To", value: "<prev@gmail.com>" },
      { name: "References", value: "<a@gmail.com> <b@gmail.com>" },
    ],
    parts: [
      {
        mimeType: "text/plain",
        body: { data: Buffer.from("Hi Gavrilux", "utf8").toString("base64url") },
      },
      {
        mimeType: "text/html",
        body: { data: Buffer.from("<p>Hi Gavrilux</p>", "utf8").toString("base64url") },
      },
    ],
  },
};

describe("gmailMessageToNormalized", () => {
  it("extracts headers + plaintext body", () => {
    const n = gmailMessageToNormalized(gmailMsg as never);
    expect(n.external_id).toBe("abc123");
    expect(n.external_thread_id).toBe("thr456");
    expect(n.from_address).toBe("marco@thecuina.com");
    expect(n.from_name).toBe("Marco");
    expect(n.to_addresses).toEqual(["gavrilux.agent@gmail.com"]);
    expect(n.subject).toBe("Hello");
    expect(n.body_text).toBe("Hi Gavrilux");
    expect(n.body_html).toBe("<p>Hi Gavrilux</p>");
    expect(n.message_id_header).toBe("<msg123@mail.thecuina.com>");
    expect(n.in_reply_to_header).toBe("<prev@gmail.com>");
    expect(n.references_header).toEqual(["<a@gmail.com>", "<b@gmail.com>"]);
  });

  it("handles text/plain only body", () => {
    const msg = {
      id: "x",
      threadId: "y",
      payload: {
        mimeType: "text/plain",
        headers: [
          { name: "From", value: "x@x.com" },
          { name: "To", value: "y@y.com" },
          { name: "Subject", value: "" },
          { name: "Date", value: "Mon, 25 May 2026 10:00:00 +0200" },
          { name: "Message-ID", value: "<a@b>" },
        ],
        body: { data: Buffer.from("just text", "utf8").toString("base64url") },
      },
    };
    const n = gmailMessageToNormalized(msg as never);
    expect(n.body_text).toBe("just text");
    expect(n.body_html).toBeNull();
  });

  it("falls back to HTML stripped of tags when no plaintext", () => {
    const msg = {
      id: "x",
      threadId: "y",
      payload: {
        mimeType: "text/html",
        headers: [
          { name: "From", value: "x@x.com" },
          { name: "To", value: "y@y.com" },
          { name: "Subject", value: "" },
          { name: "Date", value: "Mon, 25 May 2026 10:00:00 +0200" },
          { name: "Message-ID", value: "<a@b>" },
        ],
        body: { data: Buffer.from("<b>Hello</b> world", "utf8").toString("base64url") },
      },
    };
    const n = gmailMessageToNormalized(msg as never);
    expect(n.body_text).toBe("Hello world");
    expect(n.body_html).toBe("<b>Hello</b> world");
  });

  it("parses From with bare address (no name)", () => {
    const msg = {
      ...gmailMsg,
      payload: {
        ...gmailMsg.payload,
        headers: [
          { name: "From", value: "marco@thecuina.com" },
          ...gmailMsg.payload.headers.filter((h) => h.name !== "From"),
        ],
      },
    };
    const n = gmailMessageToNormalized(msg as never);
    expect(n.from_address).toBe("marco@thecuina.com");
    expect(n.from_name).toBeNull();
  });

  it("splits multi-recipient To header", () => {
    const msg = {
      ...gmailMsg,
      payload: {
        ...gmailMsg.payload,
        headers: [
          ...gmailMsg.payload.headers.filter((h) => h.name !== "To"),
          { name: "To", value: "a@a.com, b@b.com" },
        ],
      },
    };
    const n = gmailMessageToNormalized(msg as never);
    expect(n.to_addresses).toEqual(["a@a.com", "b@b.com"]);
  });
});

describe("gmailMessageToInbound", () => {
  it("wraps NormalizedEmail into InboundMessage", () => {
    const inbound = gmailMessageToInbound(gmailMsg as never, "channel-uuid-123");
    expect(inbound.channel_type).toBe("email");
    expect(inbound.external_message_id).toBe("abc123");
    expect(inbound.external_thread_id).toBe("thr456");
    expect(inbound.sender_identifier).toBe("marco@thecuina.com");
    expect(inbound.sender_display_name).toBe("Marco");
    expect(inbound.sender_handle).toBeNull();
    expect(inbound.chat_type).toBe("private");
    expect(inbound.content).toBe("Hi Gavrilux");
    expect(inbound.attachments).toEqual([]);
  });

  it("lower-cases sender_identifier", () => {
    const msg = {
      ...gmailMsg,
      payload: {
        ...gmailMsg.payload,
        headers: [
          ...gmailMsg.payload.headers.filter((h) => h.name !== "From"),
          { name: "From", value: "Marco <Marco@TheCuina.com>" },
        ],
      },
    };
    const inbound = gmailMessageToInbound(msg as never, "ch");
    expect(inbound.sender_identifier).toBe("marco@thecuina.com");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/transport-email test -- normalize.test.ts
```

Expected: FAIL — `normalize.js` missing.

- [ ] **Step 3: Create `src/normalize.ts`**

```ts
// packages/transport-email/src/normalize.ts
import type { InboundMessage, NormalizedEmail } from "@agent-mouth/core";

interface GmailHeader { name: string; value: string }
interface GmailBody { data?: string; size?: number }
interface GmailPart {
  mimeType?: string;
  headers?: GmailHeader[];
  body?: GmailBody;
  parts?: GmailPart[];
}
interface GmailMessage {
  id: string;
  threadId: string;
  internalDate?: string;
  payload: GmailPart;
}

function headerValue(headers: GmailHeader[] | undefined, name: string): string | undefined {
  return headers?.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value;
}

/** Parse "Name <addr@dom>" or "addr@dom" into {name, address}. Returns lower-cased address. */
function parseAddress(raw: string): { name: string | null; address: string } {
  const m = raw.match(/^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/);
  if (m) {
    const name = (m[1] ?? "").trim();
    return { name: name.length ? name : null, address: m[2].trim().toLowerCase() };
  }
  return { name: null, address: raw.trim().toLowerCase() };
}

function parseAddressList(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((s) => parseAddress(s).address)
    .filter((s) => s.length > 0);
}

function findPart(part: GmailPart, mimeType: string): GmailPart | null {
  if (part.mimeType === mimeType) return part;
  for (const child of part.parts ?? []) {
    const hit = findPart(child, mimeType);
    if (hit) return hit;
  }
  return null;
}

function decodeBody(part: GmailPart | null): string | null {
  if (!part?.body?.data) return null;
  return Buffer.from(part.body.data, "base64url").toString("utf8");
}

function stripHtmlToText(html: string): string {
  return html.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

export function gmailMessageToNormalized(msg: GmailMessage): NormalizedEmail {
  const headers = msg.payload.headers ?? [];
  const fromRaw = headerValue(headers, "From") ?? "";
  const from = parseAddress(fromRaw);
  const subject = headerValue(headers, "Subject") ?? "";
  const date = headerValue(headers, "Date");
  const receivedAt = date
    ? new Date(date).toISOString()
    : (msg.internalDate
      ? new Date(Number(msg.internalDate)).toISOString()
      : new Date().toISOString());
  const messageIdHeader = headerValue(headers, "Message-ID") ?? `<${msg.id}@gmail.local>`;
  const inReplyTo = headerValue(headers, "In-Reply-To") ?? null;
  const referencesRaw = headerValue(headers, "References");
  const references = referencesRaw
    ? referencesRaw.split(/\s+/).filter((s) => s.length > 0)
    : [];

  const plainPart = findPart(msg.payload, "text/plain");
  const htmlPart = findPart(msg.payload, "text/html");
  const plainText = decodeBody(plainPart);
  const htmlText = decodeBody(htmlPart);
  const bodyText = plainText ?? (htmlText ? stripHtmlToText(htmlText) : "");

  return {
    external_id: msg.id,
    external_thread_id: msg.threadId,
    from_address: from.address,
    from_name: from.name,
    to_addresses: parseAddressList(headerValue(headers, "To")),
    cc_addresses: parseAddressList(headerValue(headers, "Cc")),
    subject,
    body_text: bodyText,
    body_html: htmlText,
    message_id_header: messageIdHeader,
    in_reply_to_header: inReplyTo,
    references_header: references,
    received_at: receivedAt,
  };
}

export function gmailMessageToInbound(msg: GmailMessage, channelId: string): InboundMessage {
  const n = gmailMessageToNormalized(msg);
  // `channelId` is informational; routers look it up via channel_type+workspace.
  // Stored in raw_payload for traceability.
  return {
    channel_type: "email",
    external_message_id: n.external_id,
    external_thread_id: n.external_thread_id,
    sender_identifier: n.from_address,
    sender_display_name: n.from_name ?? n.from_address,
    sender_handle: null,
    chat_type: "private",
    content: n.body_text || n.subject || "(empty)",
    attachments: [],
    raw_payload: {
      gmail: msg as unknown as Record<string, unknown>,
      channel_id: channelId,
      normalized: n as unknown as Record<string, unknown>,
    },
    received_at: n.received_at,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @agent-mouth/transport-email test -- normalize.test.ts
```

Expected: PASS (8 assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/transport-email/src/normalize.ts packages/transport-email/tests/normalize.test.ts
git commit -m "feat(transport-email): gmail message normalizer + InboundMessage adapter (T6)"
```

---

### Task 7: MIME builder for outbound emails

> **Parallelizable with T6, T8.**

**Files:**
- Create: `packages/transport-email/src/mime.ts`
- Create: `packages/transport-email/tests/mime.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/transport-email/tests/mime.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { buildMime } from "../src/mime.js";

describe("buildMime", () => {
  it("produces valid RFC822 MIME with required headers", () => {
    const mime = buildMime({
      from_address: "gavrilux.agent@gmail.com",
      to_addresses: ["marco@thecuina.com"],
      subject: "Hello",
      body_text: "Hi Marco",
    });
    expect(mime).toContain("From: gavrilux.agent@gmail.com");
    expect(mime).toContain("To: marco@thecuina.com");
    expect(mime).toContain("Subject: Hello");
    expect(mime).toContain("Content-Type: text/plain; charset=\"UTF-8\"");
    expect(mime).toContain("MIME-Version: 1.0");
    expect(mime).toContain("\r\n\r\nHi Marco");
  });

  it("includes In-Reply-To + References when given (threading)", () => {
    const mime = buildMime({
      from_address: "a@a.com",
      to_addresses: ["b@b.com"],
      subject: "Re: hi",
      body_text: "yes",
      in_reply_to: "<prev@gmail.com>",
      references: ["<a@gmail.com>", "<prev@gmail.com>"],
    });
    expect(mime).toContain("In-Reply-To: <prev@gmail.com>");
    expect(mime).toContain("References: <a@gmail.com> <prev@gmail.com>");
  });

  it("joins multiple to_addresses with comma", () => {
    const mime = buildMime({
      from_address: "a@a.com",
      to_addresses: ["b@b.com", "c@c.com"],
      subject: "x",
      body_text: "y",
    });
    expect(mime).toContain("To: b@b.com, c@c.com");
  });

  it("includes Cc when provided", () => {
    const mime = buildMime({
      from_address: "a@a.com",
      to_addresses: ["b@b.com"],
      cc_addresses: ["c@c.com"],
      subject: "x",
      body_text: "y",
    });
    expect(mime).toContain("Cc: c@c.com");
  });

  it("encodes non-ASCII subject (RFC 2047)", () => {
    const mime = buildMime({
      from_address: "a@a.com",
      to_addresses: ["b@b.com"],
      subject: "Hola — café",
      body_text: "y",
    });
    expect(mime).toMatch(/Subject: =\?UTF-8\?B\?.*\?=/);
  });

  it("uses CRLF line endings", () => {
    const mime = buildMime({
      from_address: "a@a.com",
      to_addresses: ["b@b.com"],
      subject: "x",
      body_text: "y",
    });
    expect(mime.split("\r\n").length).toBeGreaterThan(5);
    expect(mime.includes("\n\n")).toBe(false); // no bare LF blank line
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/transport-email test -- mime.test.ts
```

Expected: FAIL — `mime.js` missing.

- [ ] **Step 3: Create `src/mime.ts`**

```ts
// packages/transport-email/src/mime.ts
import type { SendEmailArgs } from "./types.js";

const CRLF = "\r\n";
const NON_ASCII = /[^\x00-\x7F]/;

function encodeHeaderIfNeeded(value: string): string {
  if (!NON_ASCII.test(value)) return value;
  const b64 = Buffer.from(value, "utf8").toString("base64");
  return `=?UTF-8?B?${b64}?=`;
}

export function buildMime(args: SendEmailArgs): string {
  const lines: string[] = [];
  lines.push(`From: ${args.from_address}`);
  lines.push(`To: ${args.to_addresses.join(", ")}`);
  if (args.cc_addresses?.length) {
    lines.push(`Cc: ${args.cc_addresses.join(", ")}`);
  }
  lines.push(`Subject: ${encodeHeaderIfNeeded(args.subject)}`);
  lines.push("MIME-Version: 1.0");
  lines.push('Content-Type: text/plain; charset="UTF-8"');
  lines.push("Content-Transfer-Encoding: 8bit");
  if (args.in_reply_to) {
    lines.push(`In-Reply-To: ${args.in_reply_to}`);
  }
  if (args.references?.length) {
    lines.push(`References: ${args.references.join(" ")}`);
  }
  // Date header (Gmail will set its own but RFC requires it)
  lines.push(`Date: ${new Date().toUTCString()}`);

  // Blank line separates headers from body
  lines.push("");
  lines.push(args.body_text);

  return lines.join(CRLF);
}

/** Gmail messages.send expects raw = base64url(mime). */
export function mimeToBase64Url(mime: string): string {
  return Buffer.from(mime, "utf8").toString("base64url");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @agent-mouth/transport-email test -- mime.test.ts
```

Expected: PASS (6 assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/transport-email/src/mime.ts packages/transport-email/tests/mime.test.ts
git commit -m "feat(transport-email): MIME builder with RFC822 headers + threading + UTF-8 (T7)"
```

---

### Task 8: OAuth helpers (URL builder, code exchange, refresh)

> **Parallelizable with T6, T7.**

**Files:**
- Create: `packages/transport-email/src/oauth/google.ts`
- Create: `packages/transport-email/tests/oauth-google.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/transport-email/tests/oauth-google.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAuthUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
} from "../src/oauth/google.js";

describe("buildAuthUrl", () => {
  it("includes client_id, redirect_uri, scopes and access_type=offline", () => {
    const url = buildAuthUrl({
      clientId: "abc.apps.googleusercontent.com",
      redirectUri: "http://localhost:53682/callback",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
    });
    const u = new URL(url);
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("client_id")).toBe("abc.apps.googleusercontent.com");
    expect(u.searchParams.get("redirect_uri")).toBe("http://localhost:53682/callback");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("prompt")).toBe("consent");
    expect(u.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/gmail.readonly");
  });
});

describe("exchangeCodeForTokens", () => {
  const origFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({
          access_token: "ya29.abc",
          refresh_token: "1//refresh_xyz",
          expires_in: 3599,
          scope: "https://www.googleapis.com/auth/gmail.readonly",
          token_type: "Bearer",
        }),
        { status: 200 },
      ),
    ) as never;
  });
  afterEach(() => { globalThis.fetch = origFetch; });

  it("posts form to token endpoint and returns parsed tokens", async () => {
    const r = await exchangeCodeForTokens({
      clientId: "abc",
      clientSecret: "shh",
      redirectUri: "http://localhost:53682/callback",
      code: "AUTH_CODE",
    });
    expect(r.access_token).toBe("ya29.abc");
    expect(r.refresh_token).toBe("1//refresh_xyz");
    expect(r.expires_in).toBe(3599);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://oauth2.googleapis.com/token",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("throws on non-2xx response", async () => {
    globalThis.fetch = vi.fn(async () => new Response("bad", { status: 400 })) as never;
    await expect(
      exchangeCodeForTokens({ clientId: "x", clientSecret: "x", redirectUri: "x", code: "x" }),
    ).rejects.toThrow(/code exchange failed: 400/);
  });
});

describe("refreshAccessToken", () => {
  const origFetch = globalThis.fetch;
  afterEach(() => { globalThis.fetch = origFetch; });

  it("posts refresh_token and returns access_token", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(
        JSON.stringify({ access_token: "ya29.new", expires_in: 3599, token_type: "Bearer" }),
        { status: 200 },
      ),
    ) as never;
    const r = await refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "rt" });
    expect(r.access_token).toBe("ya29.new");
    expect(r.expires_in).toBe(3599);
  });

  it("throws ExpiredRefreshTokenError on invalid_grant", async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 }),
    ) as never;
    await expect(
      refreshAccessToken({ clientId: "c", clientSecret: "s", refreshToken: "bad" }),
    ).rejects.toThrow(/invalid_grant/);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/transport-email test -- oauth-google.test.ts
```

Expected: FAIL — `oauth/google.js` missing.

- [ ] **Step 3: Create `src/oauth/google.ts`**

```ts
// packages/transport-email/src/oauth/google.ts

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";

export interface OAuthTokens {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  token_type: string;
}

export function buildAuthUrl(args: {
  clientId: string;
  redirectUri: string;
  scopes: string[];
  state?: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.clientId,
    redirect_uri: args.redirectUri,
    response_type: "code",
    access_type: "offline",
    prompt: "consent",
    scope: args.scopes.join(" "),
  });
  if (args.state) params.set("state", args.state);
  return `${AUTH_URL}?${params.toString()}`;
}

export async function exchangeCodeForTokens(args: {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  code: string;
}): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    redirect_uri: args.redirectUri,
    code: args.code,
    grant_type: "authorization_code",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    throw new Error(`code exchange failed: ${res.status} ${await res.text()}`);
  }
  return (await res.json()) as OAuthTokens;
}

export async function refreshAccessToken(args: {
  clientId: string;
  clientSecret: string;
  refreshToken: string;
}): Promise<OAuthTokens> {
  const form = new URLSearchParams({
    client_id: args.clientId,
    client_secret: args.clientSecret,
    refresh_token: args.refreshToken,
    grant_type: "refresh_token",
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: form.toString(),
  });
  if (!res.ok) {
    const body = await res.text();
    if (body.includes("invalid_grant")) {
      throw new Error(`invalid_grant — refresh token revoked or expired: ${body}`);
    }
    throw new Error(`token refresh failed: ${res.status} ${body}`);
  }
  return (await res.json()) as OAuthTokens;
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
pnpm --filter @agent-mouth/transport-email test -- oauth-google.test.ts
```

Expected: PASS (5 assertions).

- [ ] **Step 5: Commit**

```bash
git add packages/transport-email/src/oauth/google.ts packages/transport-email/tests/oauth-google.test.ts
git commit -m "feat(transport-email): Google OAuth URL builder + code exchange + token refresh (T8)"
```

---

### Task 9: GmailDriver implementation

**Files:**
- Create: `packages/transport-email/src/drivers/gmail-driver.ts`
- Create: `packages/transport-email/tests/gmail-driver.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/transport-email/tests/gmail-driver.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GmailDriver } from "../src/drivers/gmail-driver.js";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

const refresh = "1//abc_refresh";
const accessToken = "ya29.fresh";

function mockRefresh(): typeof fetch {
  return vi.fn(async (url: string | URL) => {
    if (String(url).includes("oauth2.googleapis.com/token")) {
      return new Response(
        JSON.stringify({ access_token: accessToken, expires_in: 3599, token_type: "Bearer" }),
        { status: 200 },
      );
    }
    throw new Error(`unexpected URL: ${url}`);
  }) as never;
}

describe("GmailDriver.whoami", () => {
  it("calls users.getProfile and returns email_address", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      if (String(url).includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3599, token_type: "Bearer" }), { status: 200 });
      }
      if (String(url).includes("/gmail/v1/users/me/profile")) {
        return new Response(JSON.stringify({ emailAddress: "gavrilux.agent@gmail.com", historyId: "100" }), { status: 200 });
      }
      throw new Error(`unexpected: ${url}`);
    }) as never;

    const d = new GmailDriver({ clientId: "c", clientSecret: "s" });
    const r = await d.whoami({ refresh_token: refresh, email_address: "gavrilux.agent@gmail.com" });
    expect(r.email_address).toBe("gavrilux.agent@gmail.com");
  });
});

describe("GmailDriver.fetchNewMessages", () => {
  it("calls history.list and messages.get; returns NormalizedEmail[]", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3599, token_type: "Bearer" }), { status: 200 });
      }
      if (s.includes("/users/me/history")) {
        return new Response(
          JSON.stringify({
            historyId: "200",
            history: [
              { messagesAdded: [{ message: { id: "m1", threadId: "t1" } }] },
            ],
          }),
          { status: 200 },
        );
      }
      if (s.includes("/users/me/messages/m1")) {
        return new Response(
          JSON.stringify({
            id: "m1",
            threadId: "t1",
            payload: {
              mimeType: "text/plain",
              headers: [
                { name: "From", value: "marco@thecuina.com" },
                { name: "To", value: "gavrilux.agent@gmail.com" },
                { name: "Subject", value: "hi" },
                { name: "Date", value: "Mon, 25 May 2026 10:00:00 +0200" },
                { name: "Message-ID", value: "<a@b>" },
              ],
              body: { data: Buffer.from("hello", "utf8").toString("base64url") },
            },
          }),
          { status: 200 },
        );
      }
      throw new Error(`unexpected: ${url}`);
    }) as never;

    const d = new GmailDriver({ clientId: "c", clientSecret: "s" });
    const r = await d.fetchNewMessages({
      auth: { refresh_token: refresh, email_address: "gavrilux.agent@gmail.com" },
      last_cursor: "100",
    });
    expect(r.messages).toHaveLength(1);
    expect(r.messages[0].external_id).toBe("m1");
    expect(r.messages[0].body_text).toBe("hello");
    expect(r.next_cursor).toBe("200");
  });

  it("falls back to messages.list on 404 historyId expired", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3599, token_type: "Bearer" }), { status: 200 });
      }
      if (s.includes("/users/me/history")) {
        return new Response("not found", { status: 404 });
      }
      if (s.includes("/users/me/messages?")) {
        return new Response(JSON.stringify({ messages: [{ id: "fallback1" }] }), { status: 200 });
      }
      if (s.includes("/users/me/messages/fallback1")) {
        return new Response(JSON.stringify({
          id: "fallback1", threadId: "tF",
          payload: { mimeType: "text/plain", headers: [
            { name: "From", value: "x@x.com" }, { name: "To", value: "y@y.com" },
            { name: "Subject", value: "" }, { name: "Date", value: "Mon, 25 May 2026 10:00:00 +0200" },
            { name: "Message-ID", value: "<f@b>" },
          ], body: { data: Buffer.from("fb", "utf8").toString("base64url") } },
        }), { status: 200 });
      }
      if (s.includes("/users/me/profile")) {
        return new Response(JSON.stringify({ emailAddress: "x@x.com", historyId: "999" }), { status: 200 });
      }
      callCount++;
      throw new Error(`unexpected: ${url}`);
    }) as never;

    const d = new GmailDriver({ clientId: "c", clientSecret: "s" });
    const r = await d.fetchNewMessages({
      auth: { refresh_token: refresh, email_address: "x@x.com" },
      last_cursor: "100",
    });
    expect(r.messages).toHaveLength(1);
    expect(r.next_cursor).toBe("999");
  });
});

describe("GmailDriver.send", () => {
  it("builds MIME and calls messages.send", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL, init?: RequestInit) => {
      const s = String(url);
      if (s.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3599, token_type: "Bearer" }), { status: 200 });
      }
      if (s.includes("/users/me/messages/send")) {
        const body = JSON.parse(init?.body as string);
        expect(body.raw).toBeTruthy();
        const mime = Buffer.from(body.raw, "base64url").toString("utf8");
        expect(mime).toContain("From: gavrilux.agent@gmail.com");
        expect(mime).toContain("Subject: hi");
        return new Response(JSON.stringify({ id: "sent1", threadId: "stx" }), { status: 200 });
      }
      throw new Error(`unexpected: ${url}`);
    }) as never;

    const d = new GmailDriver({ clientId: "c", clientSecret: "s" });
    const r = await d.send({
      auth: { refresh_token: refresh, email_address: "gavrilux.agent@gmail.com" },
      payload: {
        from_address: "gavrilux.agent@gmail.com",
        to_addresses: ["marco@thecuina.com"],
        subject: "hi",
        body_text: "hello",
      },
    });
    expect(r.message_id).toBe("sent1");
    expect(r.thread_id).toBe("stx");
  });
});

describe("GmailDriver.watch", () => {
  it("calls users.watch and returns historyId + expiration", async () => {
    globalThis.fetch = vi.fn(async (url: string | URL) => {
      const s = String(url);
      if (s.includes("oauth2.googleapis.com")) {
        return new Response(JSON.stringify({ access_token: accessToken, expires_in: 3599, token_type: "Bearer" }), { status: 200 });
      }
      if (s.includes("/users/me/watch")) {
        return new Response(JSON.stringify({ historyId: "500", expiration: "1717920000000" }), { status: 200 });
      }
      throw new Error(`unexpected: ${url}`);
    }) as never;

    const d = new GmailDriver({ clientId: "c", clientSecret: "s" });
    const r = await d.watch({
      auth: { refresh_token: refresh, email_address: "gavrilux.agent@gmail.com" },
      topic_name: "projects/p/topics/gmail-notifications",
    });
    expect(r.history_id).toBe("500");
    expect(new Date(r.expiration).getTime()).toBe(1717920000000);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/transport-email test -- gmail-driver.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `src/drivers/gmail-driver.ts`**

```ts
// packages/transport-email/src/drivers/gmail-driver.ts
import { gmailMessageToNormalized } from "../normalize.js";
import { buildMime, mimeToBase64Url } from "../mime.js";
import { refreshAccessToken } from "../oauth/google.js";
import type {
  EmailDriverAuthCtx,
  FetchResult,
  SendEmailArgs,
  SendEmailResult,
  WatchResult,
} from "../types.js";
import type { EmailDriver } from "./driver.js";

const API_BASE = "https://gmail.googleapis.com/gmail/v1";

const GMAIL_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export interface GmailDriverConfig {
  clientId: string;
  clientSecret: string;
}

export class GmailDriver implements EmailDriver {
  readonly kind = "gmail" as const;
  readonly requiredScopes = GMAIL_SCOPES;

  constructor(private readonly cfg: GmailDriverConfig) {}

  private async getAccessToken(auth: EmailDriverAuthCtx): Promise<string> {
    const r = await refreshAccessToken({
      clientId: this.cfg.clientId,
      clientSecret: this.cfg.clientSecret,
      refreshToken: auth.refresh_token,
    });
    return r.access_token;
  }

  private authHeaders(accessToken: string): HeadersInit {
    return {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    };
  }

  async whoami(auth: EmailDriverAuthCtx): Promise<{ email_address: string }> {
    const tok = await this.getAccessToken(auth);
    const res = await fetch(`${API_BASE}/users/me/profile`, { headers: this.authHeaders(tok) });
    if (!res.ok) throw new Error(`profile failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { emailAddress: string };
    return { email_address: body.emailAddress };
  }

  async fetchNewMessages(args: {
    auth: EmailDriverAuthCtx;
    last_cursor: string;
  }): Promise<FetchResult> {
    const tok = await this.getAccessToken(args.auth);

    // Primary: history.list
    const histUrl = new URL(`${API_BASE}/users/me/history`);
    histUrl.searchParams.set("startHistoryId", args.last_cursor || "1");
    histUrl.searchParams.set("historyTypes", "messageAdded");
    histUrl.searchParams.set("labelId", "INBOX");
    const histRes = await fetch(histUrl, { headers: this.authHeaders(tok) });

    if (histRes.status === 404) {
      // historyId expired (>7 days idle) — fallback to messages.list since the last known time.
      return this.fallbackResync(args.auth, tok);
    }
    if (!histRes.ok) throw new Error(`history.list failed: ${histRes.status} ${await histRes.text()}`);

    const hist = (await histRes.json()) as {
      historyId: string;
      history?: Array<{ messagesAdded?: Array<{ message: { id: string; threadId: string } }> }>;
    };

    const ids = new Set<string>();
    for (const h of hist.history ?? []) {
      for (const m of h.messagesAdded ?? []) ids.add(m.message.id);
    }
    const messages = await this.fetchMessagesByIds(tok, [...ids]);
    return { messages, next_cursor: hist.historyId };
  }

  private async fallbackResync(auth: EmailDriverAuthCtx, tok: string): Promise<FetchResult> {
    // Fetch INBOX messages from the last 24h as a coarse net.
    const sinceUnix = Math.floor((Date.now() - 24 * 3600 * 1000) / 1000);
    const listUrl = new URL(`${API_BASE}/users/me/messages`);
    listUrl.searchParams.set("q", `in:inbox after:${sinceUnix}`);
    listUrl.searchParams.set("maxResults", "100");
    const listRes = await fetch(listUrl, { headers: this.authHeaders(tok) });
    if (!listRes.ok) throw new Error(`messages.list fallback failed: ${listRes.status}`);
    const list = (await listRes.json()) as { messages?: Array<{ id: string }> };
    const ids = (list.messages ?? []).map((m) => m.id);
    const messages = await this.fetchMessagesByIds(tok, ids);

    // Refresh historyId via profile
    const profRes = await fetch(`${API_BASE}/users/me/profile`, { headers: this.authHeaders(tok) });
    if (!profRes.ok) throw new Error(`profile (resync) failed: ${profRes.status}`);
    const prof = (await profRes.json()) as { historyId: string };
    return { messages, next_cursor: prof.historyId };
  }

  private async fetchMessagesByIds(tok: string, ids: string[]) {
    const out = [];
    for (const id of ids) {
      const res = await fetch(`${API_BASE}/users/me/messages/${id}?format=full`, {
        headers: this.authHeaders(tok),
      });
      if (!res.ok) continue; // skip individual failures
      const raw = (await res.json()) as Parameters<typeof gmailMessageToNormalized>[0];
      out.push(gmailMessageToNormalized(raw));
    }
    return out;
  }

  async send(args: {
    auth: EmailDriverAuthCtx;
    payload: SendEmailArgs;
  }): Promise<SendEmailResult> {
    const tok = await this.getAccessToken(args.auth);
    const mime = buildMime(args.payload);
    const raw = mimeToBase64Url(mime);
    const res = await fetch(`${API_BASE}/users/me/messages/send`, {
      method: "POST",
      headers: this.authHeaders(tok),
      body: JSON.stringify({ raw }),
    });
    if (!res.ok) throw new Error(`messages.send failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { id: string; threadId: string };
    return { message_id: body.id, thread_id: body.threadId };
  }

  async watch(args: { auth: EmailDriverAuthCtx; topic_name: string }): Promise<WatchResult> {
    const tok = await this.getAccessToken(args.auth);
    const res = await fetch(`${API_BASE}/users/me/watch`, {
      method: "POST",
      headers: this.authHeaders(tok),
      body: JSON.stringify({
        topicName: args.topic_name,
        labelIds: ["INBOX"],
        labelFilterAction: "include",
      }),
    });
    if (!res.ok) throw new Error(`users.watch failed: ${res.status} ${await res.text()}`);
    const body = (await res.json()) as { historyId: string; expiration: string };
    return {
      history_id: body.historyId,
      expiration: new Date(Number(body.expiration)).toISOString(),
    };
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @agent-mouth/transport-email test -- gmail-driver.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Update `src/index.ts` to export GmailDriver**

Add:
```ts
export { GmailDriver } from "./drivers/gmail-driver.js";
export type { GmailDriverConfig } from "./drivers/gmail-driver.js";
export { buildAuthUrl, exchangeCodeForTokens, refreshAccessToken } from "./oauth/google.js";
export { encryptToken, decryptToken } from "./oauth/crypto.js";
export { gmailMessageToInbound, gmailMessageToNormalized } from "./normalize.js";
export { buildMime, mimeToBase64Url } from "./mime.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/transport-email/src/drivers/gmail-driver.ts \
        packages/transport-email/tests/gmail-driver.test.ts \
        packages/transport-email/src/index.ts
git commit -m "feat(transport-email): GmailDriver (fetch + send + watch + history fallback) (T9)"
```

---

### Task 10: EmailTransport (implements Transport)

**Files:**
- Create: `packages/transport-email/src/email-transport.ts`
- Create: `packages/transport-email/tests/email-transport.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/transport-email/tests/email-transport.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { EmailTransport } from "../src/email-transport.js";
import type { EmailDriver } from "../src/drivers/driver.js";

function makeFakeDriver(): EmailDriver {
  return {
    kind: "gmail",
    requiredScopes: ["s"],
    whoami: vi.fn(async () => ({ email_address: "gavrilux.agent@gmail.com" })),
    fetchNewMessages: vi.fn(async () => ({ messages: [], next_cursor: "999" })),
    send: vi.fn(async () => ({ message_id: "out1", thread_id: "thrOut" })),
    watch: vi.fn(async () => ({ history_id: "1", expiration: "2026-06-01T00:00:00.000Z" })),
  };
}

describe("EmailTransport", () => {
  it("init does not throw", async () => {
    const t = new EmailTransport({
      driver: makeFakeDriver(),
      auth: { refresh_token: "x", email_address: "gavrilux.agent@gmail.com" },
    });
    await expect(t.init({})).resolves.toBeUndefined();
  });

  it("whoami returns email_address as handle", async () => {
    const t = new EmailTransport({
      driver: makeFakeDriver(),
      auth: { refresh_token: "x", email_address: "gavrilux.agent@gmail.com" },
    });
    const me = await t.whoami();
    expect(me.handle).toBe("gavrilux.agent@gmail.com");
    expect(me.display_name).toBe("gavrilux.agent@gmail.com");
  });

  it("send wraps driver.send with subject from SendOptions", async () => {
    const driver = makeFakeDriver();
    const t = new EmailTransport({
      driver,
      auth: { refresh_token: "x", email_address: "gavrilux.agent@gmail.com" },
    });
    const r = await t.send({
      to: "marco@thecuina.com",
      body: "Hi",
      subject: "Re: hello",
    });
    expect(r.message_id).toBe("out1");
    expect(driver.send).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ subject: "Re: hello", body_text: "Hi" }),
    }));
  });

  it("send defaults subject to '(no subject)' when missing", async () => {
    const driver = makeFakeDriver();
    const t = new EmailTransport({
      driver,
      auth: { refresh_token: "x", email_address: "gavrilux.agent@gmail.com" },
    });
    await t.send({ to: "marco@thecuina.com", body: "Hi" });
    expect(driver.send).toHaveBeenCalledWith(expect.objectContaining({
      payload: expect.objectContaining({ subject: "(no subject)" }),
    }));
  });

  it("send rejects when no to recipient", async () => {
    const t = new EmailTransport({
      driver: makeFakeDriver(),
      auth: { refresh_token: "x", email_address: "gavrilux.agent@gmail.com" },
    });
    await expect(t.send({ body: "x" } as never)).rejects.toThrow(/to.+required/i);
  });

  it("receive returns empty array when driver has nothing", async () => {
    const t = new EmailTransport({
      driver: makeFakeDriver(),
      auth: { refresh_token: "x", email_address: "gavrilux.agent@gmail.com" },
    });
    const msgs = await t.receive({});
    expect(msgs).toEqual([]);
  });

  it("listContacts returns empty (email has no roster)", async () => {
    const t = new EmailTransport({
      driver: makeFakeDriver(),
      auth: { refresh_token: "x", email_address: "gavrilux.agent@gmail.com" },
    });
    expect(await t.listContacts()).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/transport-email test -- email-transport.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `src/email-transport.ts`**

```ts
// packages/transport-email/src/email-transport.ts
import type {
  TransportContact,
  Identity,
  ReceiveOptions,
  ReceivedMessage,
  SendOptions,
  SentMessage,
  Transport,
  TransportConfig,
  WaitOptions,
} from "@agent-mouth/core";
import type { EmailDriver } from "./drivers/driver.js";
import type { EmailDriverAuthCtx } from "./types.js";

export interface EmailTransportOptions {
  driver: EmailDriver;
  auth: EmailDriverAuthCtx;
}

/**
 * EmailTransport bridges the Phase 0 `Transport` interface to Gmail (via EmailDriver).
 *
 * Note: receive() and waitForMessages() return [] because email ingress happens
 * via webhook + cron polling at the worker layer (not via Transport.receive).
 * read_inbox in the MCP server uses MessageStore (cross-channel) which already
 * has the persisted emails.
 */
export class EmailTransport implements Transport {
  constructor(private readonly opts: EmailTransportOptions) {}

  async init(_config: TransportConfig): Promise<void> {
    // No-op: auth is injected at construction
  }

  async whoami(): Promise<Identity> {
    return {
      handle: this.opts.auth.email_address,
      display_name: this.opts.auth.email_address,
      chat_id: this.opts.auth.email_address,
    };
  }

  async listContacts(): Promise<TransportContact[]> {
    return [];
  }

  async send(opts: SendOptions): Promise<SentMessage> {
    if (!opts.to) throw new Error("EmailTransport.send: `to` (recipient address) is required");
    const result = await this.opts.driver.send({
      auth: this.opts.auth,
      payload: {
        from_address: this.opts.auth.email_address,
        to_addresses: [opts.to],
        subject: opts.subject ?? "(no subject)",
        body_text: opts.body,
        in_reply_to: opts.reply_to_message_id ?? undefined,
      },
    });
    return { message_id: result.message_id, timestamp: new Date() };
  }

  async receive(_opts: ReceiveOptions): Promise<ReceivedMessage[]> {
    return [];
  }

  async waitForMessages(_opts: WaitOptions): Promise<ReceivedMessage[]> {
    return [];
  }

  async close(): Promise<void> {
    // No persistent state to release
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @agent-mouth/transport-email test
```

Expected: ALL PASS (sum: crypto 4 + normalize 8 + mime 6 + oauth 5 + gmail-driver 4 + email-transport 7 = 34 tests).

- [ ] **Step 5: Update `src/index.ts`**

Add:
```ts
export { EmailTransport } from "./email-transport.js";
export type { EmailTransportOptions } from "./email-transport.js";
```

- [ ] **Step 6: Build**

```bash
pnpm --filter @agent-mouth/transport-email build
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/transport-email/src/email-transport.ts \
        packages/transport-email/tests/email-transport.test.ts \
        packages/transport-email/src/index.ts
git commit -m "feat(transport-email): EmailTransport implements Transport interface (T10)"
```

---

## Sprint 3 — Webhook endpoint + JWT validation (T11 → T14)

### Task 11: Google OIDC JWT validator

> **Parallelizable with T12.**

**Files:**
- Create: `packages/transport-email/src/webhook/jwt.ts`
- Create: `packages/transport-email/tests/webhook-jwt.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/transport-email/tests/webhook-jwt.test.ts`:

```ts
import { generateKeyPair, exportJWK, SignJWT } from "jose";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { verifyGooglePushJwt } from "../src/webhook/jwt.js";

// We generate a local keypair to sign test JWTs, then mock Google JWKS to return our public key.
async function makeSignedJwt(payload: Record<string, unknown>, opts: { iss: string; aud: string; expSec?: number }) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const pubJwk = await exportJWK(publicKey);
  pubJwk.kid = "test-key-1";
  pubJwk.alg = "RS256";
  pubJwk.use = "sig";
  const jwt = await new SignJWT(payload)
    .setProtectedHeader({ alg: "RS256", kid: "test-key-1" })
    .setIssuer(opts.iss)
    .setAudience(opts.aud)
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.expSec ?? 600))
    .sign(privateKey);
  return { jwt, pubJwk };
}

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

describe("verifyGooglePushJwt", () => {
  it("accepts a valid JWT with correct iss + aud", async () => {
    const { jwt, pubJwk } = await makeSignedJwt(
      { email: "service@p.iam.gserviceaccount.com" },
      { iss: "https://accounts.google.com", aud: "https://agent-mouth.fly.dev/email-webhook" },
    );
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 })) as never;

    const payload = await verifyGooglePushJwt(jwt, {
      audience: "https://agent-mouth.fly.dev/email-webhook",
      serviceAccountEmail: "service@p.iam.gserviceaccount.com",
    });
    expect(payload.email).toBe("service@p.iam.gserviceaccount.com");
  });

  it("rejects wrong issuer", async () => {
    const { jwt, pubJwk } = await makeSignedJwt(
      { email: "service@p.iam.gserviceaccount.com" },
      { iss: "https://evil.com", aud: "https://agent-mouth.fly.dev/email-webhook" },
    );
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 })) as never;

    await expect(
      verifyGooglePushJwt(jwt, {
        audience: "https://agent-mouth.fly.dev/email-webhook",
        serviceAccountEmail: "service@p.iam.gserviceaccount.com",
      }),
    ).rejects.toThrow();
  });

  it("rejects wrong audience", async () => {
    const { jwt, pubJwk } = await makeSignedJwt(
      { email: "service@p.iam.gserviceaccount.com" },
      { iss: "https://accounts.google.com", aud: "https://other.example.com" },
    );
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 })) as never;

    await expect(
      verifyGooglePushJwt(jwt, {
        audience: "https://agent-mouth.fly.dev/email-webhook",
        serviceAccountEmail: "service@p.iam.gserviceaccount.com",
      }),
    ).rejects.toThrow();
  });

  it("rejects wrong service account email", async () => {
    const { jwt, pubJwk } = await makeSignedJwt(
      { email: "attacker@p.iam.gserviceaccount.com" },
      { iss: "https://accounts.google.com", aud: "https://agent-mouth.fly.dev/email-webhook" },
    );
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 })) as never;

    await expect(
      verifyGooglePushJwt(jwt, {
        audience: "https://agent-mouth.fly.dev/email-webhook",
        serviceAccountEmail: "service@p.iam.gserviceaccount.com",
      }),
    ).rejects.toThrow(/service.*account/i);
  });

  it("rejects expired JWT", async () => {
    const { jwt, pubJwk } = await makeSignedJwt(
      { email: "service@p.iam.gserviceaccount.com" },
      { iss: "https://accounts.google.com", aud: "https://agent-mouth.fly.dev/email-webhook", expSec: -10 },
    );
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ keys: [pubJwk] }), { status: 200 })) as never;

    await expect(
      verifyGooglePushJwt(jwt, {
        audience: "https://agent-mouth.fly.dev/email-webhook",
        serviceAccountEmail: "service@p.iam.gserviceaccount.com",
      }),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/transport-email test -- webhook-jwt.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `src/webhook/jwt.ts`**

```ts
// packages/transport-email/src/webhook/jwt.ts
import { createRemoteJWKSet, jwtVerify } from "jose";

const GOOGLE_JWKS_URL = "https://www.googleapis.com/oauth2/v3/certs";
let cachedJwks: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJwks() {
  if (!cachedJwks) {
    cachedJwks = createRemoteJWKSet(new URL(GOOGLE_JWKS_URL), {
      cacheMaxAge: 60 * 60 * 1000, // 1h
      cooldownDuration: 30 * 1000,
    });
  }
  return cachedJwks;
}

export interface GooglePushJwtPayload {
  email: string;        // service account email
  email_verified?: boolean;
  iss: string;
  aud: string;
  exp: number;
  iat: number;
  sub: string;
}

export async function verifyGooglePushJwt(
  token: string,
  opts: { audience: string; serviceAccountEmail: string },
): Promise<GooglePushJwtPayload> {
  const jwks = getJwks();
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "https://accounts.google.com",
    audience: opts.audience,
  });
  const p = payload as unknown as GooglePushJwtPayload;
  if (p.email !== opts.serviceAccountEmail) {
    throw new Error(
      `service account email mismatch: expected=${opts.serviceAccountEmail} got=${p.email}`,
    );
  }
  return p;
}

/** Test-only: clear cached JWKS to force re-fetch (used in unit tests). */
export function _resetJwksCache(): void {
  cachedJwks = null;
}
```

> **Note on testing:** the test uses `vi.fn(globalThis.fetch)` to mock Google's JWKS endpoint. Because `createRemoteJWKSet` caches, we call `_resetJwksCache()` between tests. Update the test file accordingly:

In `tests/webhook-jwt.test.ts` at top of file:
```ts
import { _resetJwksCache } from "../src/webhook/jwt.js";

beforeEach(() => { _resetJwksCache(); });
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @agent-mouth/transport-email test -- webhook-jwt.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Export from `src/index.ts`**

Add:
```ts
export { verifyGooglePushJwt } from "./webhook/jwt.js";
export type { GooglePushJwtPayload } from "./webhook/jwt.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/transport-email/src/webhook/jwt.ts \
        packages/transport-email/tests/webhook-jwt.test.ts \
        packages/transport-email/src/index.ts
git commit -m "feat(transport-email): Google OIDC JWT validator for Pub/Sub push (T11)"
```

---

### Task 12: Pub/Sub envelope parser + Zod schema

> **Parallelizable with T11.**

**Files:**
- Create: `packages/transport-email/src/webhook/pubsub-payload.ts`
- Create: `packages/transport-email/tests/webhook-payload.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/transport-email/tests/webhook-payload.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parsePubSubEnvelope } from "../src/webhook/pubsub-payload.js";

const gmailNotif = { emailAddress: "gavrilux.agent@gmail.com", historyId: "12345" };

describe("parsePubSubEnvelope", () => {
  it("decodes base64 data field into Gmail notification", () => {
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify(gmailNotif), "utf8").toString("base64"),
        messageId: "1234567890",
        publishTime: "2026-05-25T10:00:00Z",
      },
      subscription: "projects/p/subscriptions/gmail-push-agent-mouth",
    };
    const r = parsePubSubEnvelope(envelope);
    expect(r.email_address).toBe("gavrilux.agent@gmail.com");
    expect(r.history_id).toBe("12345");
    expect(r.pubsub_message_id).toBe("1234567890");
  });

  it("throws on missing message", () => {
    expect(() => parsePubSubEnvelope({})).toThrow();
  });

  it("throws on missing data field", () => {
    expect(() =>
      parsePubSubEnvelope({ message: { messageId: "1" }, subscription: "x" }),
    ).toThrow();
  });

  it("throws on invalid base64", () => {
    expect(() =>
      parsePubSubEnvelope({ message: { data: "!!!not-base64!!!", messageId: "1" }, subscription: "x" }),
    ).toThrow();
  });

  it("throws on payload missing historyId", () => {
    const envelope = {
      message: {
        data: Buffer.from(JSON.stringify({ emailAddress: "x@y.com" }), "utf8").toString("base64"),
        messageId: "1",
      },
      subscription: "x",
    };
    expect(() => parsePubSubEnvelope(envelope)).toThrow();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/transport-email test -- webhook-payload.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `src/webhook/pubsub-payload.ts`**

```ts
// packages/transport-email/src/webhook/pubsub-payload.ts
import { z } from "zod";

const PubSubEnvelopeSchema = z.object({
  message: z.object({
    data: z.string().min(1),
    messageId: z.string().optional(),
    publishTime: z.string().optional(),
  }),
  subscription: z.string().optional(),
});

const GmailNotificationSchema = z.object({
  emailAddress: z.string().email(),
  historyId: z.union([z.string(), z.number()]).transform((v) => String(v)),
});

export interface ParsedPubSubPayload {
  email_address: string;
  history_id: string;
  pubsub_message_id: string | null;
  publish_time: string | null;
  subscription: string | null;
}

export function parsePubSubEnvelope(envelope: unknown): ParsedPubSubPayload {
  const env = PubSubEnvelopeSchema.parse(envelope);
  let decoded: string;
  try {
    decoded = Buffer.from(env.message.data, "base64").toString("utf8");
    // Reject if it doesn't look like JSON
    if (!decoded.trim().startsWith("{")) {
      throw new Error("decoded data is not JSON");
    }
  } catch (err) {
    throw new Error(`invalid base64 data: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(decoded);
  } catch {
    throw new Error("data is not valid JSON");
  }
  const notif = GmailNotificationSchema.parse(parsed);
  return {
    email_address: notif.emailAddress.toLowerCase(),
    history_id: notif.historyId,
    pubsub_message_id: env.message.messageId ?? null,
    publish_time: env.message.publishTime ?? null,
    subscription: env.subscription ?? null,
  };
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @agent-mouth/transport-email test -- webhook-payload.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Export from `src/index.ts`**

Add:
```ts
export { parsePubSubEnvelope } from "./webhook/pubsub-payload.js";
export type { ParsedPubSubPayload } from "./webhook/pubsub-payload.js";
```

- [ ] **Step 6: Commit**

```bash
git add packages/transport-email/src/webhook/pubsub-payload.ts \
        packages/transport-email/tests/webhook-payload.test.ts \
        packages/transport-email/src/index.ts
git commit -m "feat(transport-email): Pub/Sub envelope parser with Zod validation (T12)"
```

---

### Task 13: `POST /email-webhook` HTTP endpoint with idempotency

**Files:**
- Modify: `packages/api/src/cli/serve-http.ts` (add /email-webhook route)
- Modify: `packages/api/package.json` (add @agent-mouth/transport-email dependency)
- Create: `packages/api/tests/email-webhook.test.ts`

- [ ] **Step 1: Add transport-email dependency to packages/api/package.json**

Edit `packages/api/package.json`:
- Add to `dependencies`:
```json
    "@agent-mouth/transport-email": "workspace:*",
```

Run:
```bash
pnpm install
```

- [ ] **Step 2: Write failing tests**

Create `packages/api/tests/email-webhook.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IncomingMessage, ServerResponse } from "node:http";
import { handleEmailWebhook } from "../src/email-webhook.js";

function mockReq(body: unknown, headers: Record<string, string> = {}): IncomingMessage {
  const json = typeof body === "string" ? body : JSON.stringify(body);
  const chunks = [Buffer.from(json, "utf8")];
  let i = 0;
  const handlers = new Map<string, ((arg?: unknown) => void)[]>();
  const r = {
    headers: { "content-type": "application/json", ...headers },
    on(evt: string, fn: (arg?: unknown) => void) {
      handlers.get(evt) ?? handlers.set(evt, []);
      handlers.get(evt)!.push(fn);
      if (evt === "data") setImmediate(() => fn(chunks[i++]));
      if (evt === "end") setImmediate(() => fn());
      return r;
    },
  } as unknown as IncomingMessage;
  return r;
}

function mockRes(): { res: ServerResponse; status: () => number; body: () => string } {
  let status = 200;
  let body = "";
  const r = {
    writeHead(s: number) { status = s; return r; },
    end(b?: string) { if (b) body = b; },
    headersSent: false,
  } as unknown as ServerResponse;
  return { res: r, status: () => status, body: () => body };
}

describe("handleEmailWebhook", () => {
  let recordOnce: ReturnType<typeof vi.fn>;
  let verifyJwt: ReturnType<typeof vi.fn>;
  let enqueue: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    recordOnce = vi.fn(async () => true);
    verifyJwt = vi.fn(async () => ({ email: "sa@p.iam.gserviceaccount.com" }));
    enqueue = vi.fn(async () => undefined);
  });

  it("returns 200 + enqueues job for valid JWT and fresh historyId", async () => {
    const data = Buffer.from(JSON.stringify({ emailAddress: "gavrilux.agent@gmail.com", historyId: "100" }), "utf8").toString("base64");
    const { res, status } = mockRes();
    await handleEmailWebhook(
      mockReq({ message: { data, messageId: "1" }, subscription: "s" }, { authorization: "Bearer fake.jwt.token" }),
      res,
      {
        verifyJwt: verifyJwt as never,
        webhookEventsStore: { recordOnce } as never,
        queueEnqueue: enqueue as never,
        config: { audience: "https://agent-mouth.fly.dev/email-webhook", serviceAccountEmail: "sa@p.iam.gserviceaccount.com" },
      },
    );
    expect(status()).toBe(200);
    expect(verifyJwt).toHaveBeenCalled();
    expect(recordOnce).toHaveBeenCalledWith("gavrilux.agent@gmail.com", "100");
    expect(enqueue).toHaveBeenCalledWith(
      "email.fetch",
      { email_address: "gavrilux.agent@gmail.com", history_id: "100" },
      expect.objectContaining({ singletonKey: "email.fetch.gavrilux.agent@gmail.com.100" }),
    );
  });

  it("returns 200 + no-op when duplicate (recordOnce → false)", async () => {
    recordOnce = vi.fn(async () => false);
    const data = Buffer.from(JSON.stringify({ emailAddress: "x@x.com", historyId: "100" }), "utf8").toString("base64");
    const { res, status } = mockRes();
    await handleEmailWebhook(
      mockReq({ message: { data, messageId: "1" } }, { authorization: "Bearer fake.jwt" }),
      res,
      {
        verifyJwt: verifyJwt as never,
        webhookEventsStore: { recordOnce } as never,
        queueEnqueue: enqueue as never,
        config: { audience: "https://agent-mouth.fly.dev/email-webhook", serviceAccountEmail: "sa@p.iam.gserviceaccount.com" },
      },
    );
    expect(status()).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns 401 on invalid JWT", async () => {
    verifyJwt = vi.fn(async () => { throw new Error("bad jwt"); });
    const { res, status } = mockRes();
    await handleEmailWebhook(
      mockReq({ message: { data: "x", messageId: "1" } }, { authorization: "Bearer bad" }),
      res,
      {
        verifyJwt: verifyJwt as never,
        webhookEventsStore: { recordOnce } as never,
        queueEnqueue: enqueue as never,
        config: { audience: "x", serviceAccountEmail: "x" },
      },
    );
    expect(status()).toBe(401);
  });

  it("returns 401 on missing Authorization header", async () => {
    const { res, status } = mockRes();
    await handleEmailWebhook(
      mockReq({ message: { data: "x", messageId: "1" } }),  // no authorization
      res,
      {
        verifyJwt: verifyJwt as never,
        webhookEventsStore: { recordOnce } as never,
        queueEnqueue: enqueue as never,
        config: { audience: "x", serviceAccountEmail: "x" },
      },
    );
    expect(status()).toBe(401);
  });

  it("returns 400 on malformed envelope", async () => {
    const { res, status } = mockRes();
    await handleEmailWebhook(
      mockReq({ wrong: "envelope" }, { authorization: "Bearer fake" }),
      res,
      {
        verifyJwt: verifyJwt as never,
        webhookEventsStore: { recordOnce } as never,
        queueEnqueue: enqueue as never,
        config: { audience: "x", serviceAccountEmail: "sa@p.iam.gserviceaccount.com" },
      },
    );
    expect(status()).toBe(400);
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/api test -- email-webhook.test.ts
```

Expected: FAIL — `email-webhook.js` not found.

- [ ] **Step 4: Create `packages/api/src/email-webhook.ts`**

```ts
// packages/api/src/email-webhook.ts
import type { IncomingMessage, ServerResponse } from "node:http";
import { parsePubSubEnvelope, verifyGooglePushJwt } from "@agent-mouth/transport-email";
import type { SupabaseEmailWebhookEventsStore } from "@agent-mouth/storage-supabase";
import { logger } from "./logger.js";

export interface EmailWebhookConfig {
  audience: string;
  serviceAccountEmail: string;
}

export interface EmailWebhookDeps {
  verifyJwt: typeof verifyGooglePushJwt;
  webhookEventsStore: Pick<SupabaseEmailWebhookEventsStore, "recordOnce">;
  queueEnqueue: (
    name: string,
    data: Record<string, unknown>,
    options?: { singletonKey?: string },
  ) => Promise<void>;
  config: EmailWebhookConfig;
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      try { resolve(raw ? JSON.parse(raw) : {}); }
      catch { resolve(undefined); }
    });
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export async function handleEmailWebhook(
  req: IncomingMessage,
  res: ServerResponse,
  deps: EmailWebhookDeps,
): Promise<void> {
  // 1. Extract + validate JWT
  const auth = req.headers.authorization;
  if (!auth || !auth.toLowerCase().startsWith("bearer ")) {
    send(res, 401, { error: "missing bearer token" });
    return;
  }
  const token = auth.slice(7);
  try {
    await deps.verifyJwt(token, {
      audience: deps.config.audience,
      serviceAccountEmail: deps.config.serviceAccountEmail,
    });
  } catch (err) {
    logger.warn({ err: String(err) }, "email-webhook JWT validation failed");
    send(res, 401, { error: "invalid token" });
    return;
  }

  // 2. Parse + validate envelope
  const body = await readBody(req);
  let parsed: ReturnType<typeof parsePubSubEnvelope>;
  try {
    parsed = parsePubSubEnvelope(body);
  } catch (err) {
    logger.warn({ err: String(err) }, "email-webhook payload malformed");
    send(res, 400, { error: "malformed pub/sub envelope" });
    return;
  }

  // 3. Idempotency: insert-or-noop (email_address, history_id)
  let isNew: boolean;
  try {
    isNew = await deps.webhookEventsStore.recordOnce(parsed.email_address, parsed.history_id);
  } catch (err) {
    logger.error({ err: String(err) }, "email-webhook idempotency check failed");
    send(res, 200, { ok: true, skipped: "idempotency-check-failed" });
    return;
  }

  if (!isNew) {
    logger.info({ email: parsed.email_address, historyId: parsed.history_id }, "email-webhook duplicate, noop");
    send(res, 200, { ok: true, duplicate: true });
    return;
  }

  // 4. Enqueue fetch job
  try {
    await deps.queueEnqueue(
      "email.fetch",
      { email_address: parsed.email_address, history_id: parsed.history_id },
      { singletonKey: `email.fetch.${parsed.email_address}.${parsed.history_id}` },
    );
    logger.info({ email: parsed.email_address, historyId: parsed.history_id }, "email-webhook job enqueued");
  } catch (err) {
    logger.error({ err: String(err) }, "email-webhook enqueue failed");
    // Still return 200 — webhook delivered, job retry will catch up via fallback polling.
  }

  send(res, 200, { ok: true });
}
```

- [ ] **Step 5: Run tests to verify pass**

```bash
pnpm --filter @agent-mouth/api test -- email-webhook.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 6: Wire route in serve-http.ts**

Open `packages/api/src/cli/serve-http.ts` and find the `if (url.pathname === "/telegram-webhook" && ...)` block. After it, **before** the auth-token gate, add:

```ts
      if (url.pathname === "/email-webhook" && req.method === "POST") {
        if (!emailWebhookDeps) {
          sendJson(res, 503, { error: "email transport not configured" });
          return;
        }
        await handleEmailWebhook(req, res, emailWebhookDeps);
        return;
      }
```

At the top of `serve-http.ts`, add the import:
```ts
import { handleEmailWebhook, type EmailWebhookDeps } from "../email-webhook.js";
```

Note: `emailWebhookDeps` will be populated in T22 (bootstrap). For now, declare it conditionally:
```ts
  const emailWebhookDeps: EmailWebhookDeps | null = null; // wired in T22
```

This keeps the route alive but returns 503 until T22.

- [ ] **Step 7: Typecheck and build**

```bash
pnpm -r typecheck
pnpm --filter @agent-mouth/api build
```

Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add packages/api/src/email-webhook.ts \
        packages/api/tests/email-webhook.test.ts \
        packages/api/src/cli/serve-http.ts \
        packages/api/package.json
git commit -m "feat(api): POST /email-webhook with JWT validation + idempotency + job enqueue (T13)"
```

---

### Task 14: Worker job `email.fetch` handler

**Files:**
- Modify: `packages/api/src/worker.ts` (add handleEmailFetch + register handler)
- Create: `packages/api/tests/email-fetch-handler.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/api/tests/email-fetch-handler.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleEmailFetch } from "../src/email-fetch.js";

describe("handleEmailFetch", () => {
  it("fetches new messages, persists, calls processInbound", async () => {
    const decryptToken = vi.fn(() => "1//refresh_xyz");
    const fetchNewMessages = vi.fn(async () => ({
      messages: [{
        external_id: "m1",
        external_thread_id: "t1",
        from_address: "marco@thecuina.com",
        from_name: "Marco",
        to_addresses: ["gavrilux.agent@gmail.com"],
        cc_addresses: [],
        subject: "Hi",
        body_text: "hello",
        body_html: null,
        message_id_header: "<a@b>",
        in_reply_to_header: null,
        references_header: [],
        received_at: "2026-05-25T10:00:00.000Z",
      }],
      next_cursor: "999",
    }));
    const updateCursor = vi.fn(async () => undefined);
    const processInbound = vi.fn(async () => ({ kind: "persisted", policy: "auto", messageId: "msg-uuid", contactId: "c", threadId: "th", channelType: "email", channelId: "ch", channelIdentityId: "ci", externalChatId: "x", messageContent: "hello" }));
    const queueSend = vi.fn(async () => undefined);

    const tokenStore = {
      getByAddress: vi.fn(async () => ({
        id: "tok1",
        workspace_id: "ws1",
        channel_id: "ch1",
        email_address: "gavrilux.agent@gmail.com",
        refresh_token_encrypted: "encrypted",
        scopes: [],
        last_history_id: "100",
        watch_expiration: null,
        status: "active",
        last_error: null,
        consecutive_renewal_failures: 0,
        created_at: "2026-05-25T00:00:00.000Z",
        updated_at: "2026-05-25T00:00:00.000Z",
      })),
      updateCursor,
    };

    await handleEmailFetch({
      data: { email_address: "gavrilux.agent@gmail.com", history_id: "150" },
      workspaceId: "ws1",
      tokenStore: tokenStore as never,
      driver: { fetchNewMessages } as never,
      decrypt: decryptToken,
      encryptionKey: "k",
      routerDeps: {} as never,
      processInbound: processInbound as never,
      queueSend: queueSend as never,
    });

    expect(decryptToken).toHaveBeenCalledWith("encrypted", "k");
    expect(fetchNewMessages).toHaveBeenCalledWith({
      auth: { refresh_token: "1//refresh_xyz", email_address: "gavrilux.agent@gmail.com" },
      last_cursor: "100",
    });
    expect(processInbound).toHaveBeenCalledTimes(1);
    expect(updateCursor).toHaveBeenCalledWith("tok1", "999");
    expect(queueSend).toHaveBeenCalledWith(
      "agent.respond",
      expect.objectContaining({ messageId: "msg-uuid" }),
      expect.any(Object),
    );
  });

  it("skips when token not active", async () => {
    const fetchNewMessages = vi.fn();
    const processInbound = vi.fn();
    const tokenStore = {
      getByAddress: vi.fn(async () => ({
        id: "tok1", workspace_id: "ws1", channel_id: "ch1",
        email_address: "x@x.com", refresh_token_encrypted: "e",
        scopes: [], last_history_id: null, watch_expiration: null,
        status: "revoked", last_error: null, consecutive_renewal_failures: 0,
        created_at: "2026-05-25T00:00:00.000Z", updated_at: "2026-05-25T00:00:00.000Z",
      })),
      updateCursor: vi.fn(),
    };
    await handleEmailFetch({
      data: { email_address: "x@x.com", history_id: "1" },
      workspaceId: "ws1",
      tokenStore: tokenStore as never,
      driver: { fetchNewMessages } as never,
      decrypt: vi.fn(),
      encryptionKey: "k",
      routerDeps: {} as never,
      processInbound: processInbound as never,
      queueSend: vi.fn(),
    });
    expect(fetchNewMessages).not.toHaveBeenCalled();
    expect(processInbound).not.toHaveBeenCalled();
  });

  it("skips agent.respond when policy is silent", async () => {
    const processInbound = vi.fn(async () => ({ kind: "persisted", policy: "silent" }));
    const queueSend = vi.fn();
    const tokenStore = {
      getByAddress: vi.fn(async () => ({
        id: "tok1", workspace_id: "ws1", channel_id: "ch1",
        email_address: "x@x.com", refresh_token_encrypted: "e",
        scopes: [], last_history_id: "1", watch_expiration: null,
        status: "active", last_error: null, consecutive_renewal_failures: 0,
        created_at: "2026-05-25T00:00:00.000Z", updated_at: "2026-05-25T00:00:00.000Z",
      })),
      updateCursor: vi.fn(),
    };
    await handleEmailFetch({
      data: { email_address: "x@x.com", history_id: "2" },
      workspaceId: "ws1",
      tokenStore: tokenStore as never,
      driver: { fetchNewMessages: vi.fn(async () => ({
        messages: [{
          external_id: "m1", external_thread_id: "t1",
          from_address: "y@y.com", from_name: null,
          to_addresses: ["x@x.com"], cc_addresses: [],
          subject: "", body_text: "x", body_html: null,
          message_id_header: "<a>", in_reply_to_header: null, references_header: [],
          received_at: "2026-05-25T00:00:00.000Z",
        }],
        next_cursor: "2",
      })) } as never,
      decrypt: vi.fn(() => "rt"),
      encryptionKey: "k",
      routerDeps: {} as never,
      processInbound: processInbound as never,
      queueSend: queueSend as never,
    });
    expect(processInbound).toHaveBeenCalledTimes(1);
    expect(queueSend).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/api test -- email-fetch-handler.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `packages/api/src/email-fetch.ts`**

```ts
// packages/api/src/email-fetch.ts
import type { InboundMessage } from "@agent-mouth/core";
import { InboundMessageSchema } from "@agent-mouth/core";
import type { SupabaseEmailTokenStore } from "@agent-mouth/storage-supabase";
import type { GmailDriver } from "@agent-mouth/transport-email";
import { gmailMessageToInbound } from "@agent-mouth/transport-email";
import { logger } from "./logger.js";
import type { processInbound, RouterDeps, RouterResult } from "./router.js";

export interface EmailFetchJobData {
  email_address: string;
  history_id: string;
}

export interface EmailFetchDeps {
  data: EmailFetchJobData;
  workspaceId: string;
  tokenStore: Pick<SupabaseEmailTokenStore, "getByAddress" | "updateCursor">;
  driver: Pick<GmailDriver, "fetchNewMessages">;
  decrypt: (cipher: string, keyHex: string) => string;
  encryptionKey: string;
  routerDeps: RouterDeps;
  processInbound: typeof processInbound;
  queueSend: (
    name: string,
    data: Record<string, unknown>,
    opts?: { singletonKey?: string },
  ) => Promise<void>;
}

export async function handleEmailFetch(deps: EmailFetchDeps): Promise<void> {
  const tok = await deps.tokenStore.getByAddress(deps.workspaceId, deps.data.email_address);
  if (!tok) {
    logger.warn({ email: deps.data.email_address }, "email.fetch: no token row");
    return;
  }
  if (tok.status !== "active") {
    logger.warn({ email: tok.email_address, status: tok.status }, "email.fetch: token not active, skipping");
    return;
  }

  let refreshToken: string;
  try {
    refreshToken = deps.decrypt(tok.refresh_token_encrypted, deps.encryptionKey);
  } catch (err) {
    logger.error({ err: String(err) }, "email.fetch: decrypt failed");
    return;
  }

  const lastCursor = tok.last_history_id ?? deps.data.history_id;
  let fetchResult;
  try {
    fetchResult = await deps.driver.fetchNewMessages({
      auth: { refresh_token: refreshToken, email_address: tok.email_address },
      last_cursor: lastCursor,
    });
  } catch (err) {
    logger.error({ err: String(err), email: tok.email_address }, "email.fetch: driver failed");
    return;
  }

  for (const normalized of fetchResult.messages) {
    const inbound = gmailMessageToInbound(
      {
        id: normalized.external_id,
        threadId: normalized.external_thread_id,
        payload: { mimeType: "text/plain", headers: [] }, // raw is in normalized
      } as never,
      tok.channel_id,
    );
    // gmailMessageToInbound rebuilds from raw — but here we already have NormalizedEmail.
    // Build InboundMessage directly:
    const inboundFromNormalized: InboundMessage = {
      channel_type: "email",
      external_message_id: normalized.external_id,
      external_thread_id: normalized.external_thread_id,
      sender_identifier: normalized.from_address,
      sender_display_name: normalized.from_name ?? normalized.from_address,
      sender_handle: null,
      chat_type: "private",
      content: normalized.body_text || normalized.subject || "(empty)",
      attachments: [],
      raw_payload: {
        channel_id: tok.channel_id,
        normalized: normalized as unknown as Record<string, unknown>,
      },
      received_at: normalized.received_at,
    };
    void inbound; // silence unused
    const parsed = InboundMessageSchema.safeParse(inboundFromNormalized);
    if (!parsed.success) {
      logger.warn({ issues: parsed.error.issues }, "email inbound schema mismatch");
      continue;
    }
    let result: RouterResult;
    try {
      result = await deps.processInbound(parsed.data, deps.routerDeps);
    } catch (err) {
      logger.error({ err: String(err) }, "email.fetch: processInbound failed");
      continue;
    }
    if (result.kind === "persisted" && result.policy !== "silent") {
      await deps.queueSend(
        "agent.respond",
        {
          workspaceId: deps.routerDeps.workspaceId,
          contactId: result.contactId,
          threadId: result.threadId,
          channelType: result.channelType,
          channelId: result.channelId,
          channelIdentityId: result.channelIdentityId,
          externalChatId: result.externalChatId,
          messageId: result.messageId,
          messageContent: result.messageContent,
        },
        { singletonKey: result.messageId },
      ).catch((err) => logger.error({ err: String(err) }, "email.fetch enqueue agent.respond failed"));
    }
  }

  await deps.tokenStore.updateCursor(tok.id, fetchResult.next_cursor);
}
```

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @agent-mouth/api test -- email-fetch-handler.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Register handler in worker.ts**

Open `packages/api/src/worker.ts`. After `queue.work("notes.update", ...)` (or wherever existing handlers are registered), add:

```ts
  if (deps.emailFetchDeps) {
    await queue.work("email.fetch", async (job) => {
      await handleEmailFetch({
        data: job.data as { email_address: string; history_id: string },
        workspaceId: deps.defaultWorkspaceId!,
        tokenStore: deps.emailFetchDeps!.tokenStore,
        driver: deps.emailFetchDeps!.driver,
        decrypt: deps.emailFetchDeps!.decrypt,
        encryptionKey: deps.emailFetchDeps!.encryptionKey,
        routerDeps: deps.emailFetchDeps!.routerDeps,
        processInbound: deps.emailFetchDeps!.processInbound,
        queueSend: (name, data, opts) => queue.send(name, data, opts ?? {}),
      });
    });
  }
```

Extend `WorkerDeps` interface to include the optional `emailFetchDeps`:

```ts
  emailFetchDeps?: {
    tokenStore: SupabaseEmailTokenStore;
    driver: GmailDriver;
    decrypt: (cipher: string, keyHex: string) => string;
    encryptionKey: string;
    routerDeps: RouterDeps;
    processInbound: typeof processInbound;
  };
```

Add imports at top of worker.ts:
```ts
import { handleEmailFetch } from "./email-fetch.js";
import type { RouterDeps, processInbound } from "./router.js";
import type { SupabaseEmailTokenStore } from "@agent-mouth/storage-supabase";
import type { GmailDriver } from "@agent-mouth/transport-email";
```

- [ ] **Step 6: Typecheck**

```bash
pnpm -r typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/email-fetch.ts \
        packages/api/tests/email-fetch-handler.test.ts \
        packages/api/src/worker.ts
git commit -m "feat(api): email.fetch worker job handler (fetch new messages + process + enqueue agent.respond) (T14)"
```

---

## Sprint 4 — Identity auto-merge + MCP tools (T15 → T18, parallelizable)

### Task 15: Extend `SupabaseIdentityResolver` with auto-merge

**Files:**
- Modify: `packages/storage-supabase/src/identity-resolver.ts`
- Modify: `packages/storage-supabase/src/contact-store.ts` (add helper)
- Create: `packages/storage-supabase/tests/identity-resolver-auto-merge.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/storage-supabase/tests/identity-resolver-auto-merge.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SupabaseIdentityResolver } from "../src/identity-resolver.js";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

const channel = {
  id: "ch-uuid",
  workspace_id: "ws1",
  type: "email",
  config: {},
  status: "active",
  created_at: "2026-05-25T00:00:00.000Z",
};

function makeFetch(routes: Record<string, (init?: RequestInit) => Promise<Response>>) {
  return vi.fn(async (url: string | URL, init?: RequestInit) => {
    const s = String(url);
    for (const [pattern, handler] of Object.entries(routes)) {
      if (s.includes(pattern)) return handler(init);
    }
    throw new Error(`unexpected URL: ${s}`);
  }) as never;
}

describe("SupabaseIdentityResolver.resolveOrCreate (email)", () => {
  it("returns existing Contact on exact ChannelIdentity match (case-insensitive)", async () => {
    globalThis.fetch = makeFetch({
      "/rest/v1/channels?": async () => new Response(JSON.stringify([channel]), { status: 200 }),
      "/rest/v1/channel_identities?": async () => new Response(JSON.stringify([{
        id: "ci-uuid", contact_id: "c-existing", channel_id: "ch-uuid",
        identifier: "marco@thecuina.com", verified: false,
      }]), { status: 200 }),
      "/rest/v1/contacts?": async () => new Response(JSON.stringify([{
        id: "c-existing", workspace_id: "ws1", display_name: "Marco",
        notes: "", metadata: {}, created_at: "2026-05-25T00:00:00.000Z",
      }]), { status: 200 }),
    });

    const r = new SupabaseIdentityResolver("https://supabase", "anon");
    const result = await r.resolveOrCreate({
      workspaceId: "ws1",
      channelType: "email",
      identifier: "Marco@TheCuina.com",  // mixed case — should still match
      displayName: "Marco",
    });
    expect(result.contact.id).toBe("c-existing");
    expect(result.created).toBe(false);
  });

  it("auto-merges via contacts.metadata.email_addresses match (creates new ChannelIdentity)", async () => {
    let identityCreateCalled = false;
    globalThis.fetch = makeFetch({
      "/rest/v1/channels?": async () => new Response(JSON.stringify([channel]), { status: 200 }),
      "/rest/v1/channel_identities?": async (init) => {
        if (init?.method === "POST") {
          identityCreateCalled = true;
          return new Response(JSON.stringify([{
            id: "ci-new", contact_id: "c-merged", channel_id: "ch-uuid",
            identifier: "marco@thecuina.com", verified: false,
          }]), { status: 201 });
        }
        return new Response(JSON.stringify([]), { status: 200 }); // no exact CI match
      },
      "/rest/v1/contacts?": async () => new Response(JSON.stringify([{
        id: "c-merged", workspace_id: "ws1", display_name: "Marco",
        notes: "", metadata: { email_addresses: ["marco@thecuina.com"] },
        created_at: "2026-05-25T00:00:00.000Z",
      }]), { status: 200 }),
    });

    const r = new SupabaseIdentityResolver("https://supabase", "anon");
    const result = await r.resolveOrCreate({
      workspaceId: "ws1",
      channelType: "email",
      identifier: "marco@thecuina.com",
      displayName: "Marco",
    });
    expect(result.contact.id).toBe("c-merged");
    expect(result.created).toBe(true);    // new ChannelIdentity, existing Contact
    expect(identityCreateCalled).toBe(true);
  });

  it("creates new Contact + ChannelIdentity on no match", async () => {
    globalThis.fetch = makeFetch({
      "/rest/v1/channels?": async () => new Response(JSON.stringify([channel]), { status: 200 }),
      "/rest/v1/channel_identities?": async (init) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify([{
            id: "ci-new", contact_id: "c-new", channel_id: "ch-uuid",
            identifier: "stranger@example.com", verified: false,
          }]), { status: 201 });
        }
        return new Response(JSON.stringify([]), { status: 200 });
      },
      "/rest/v1/contacts?": async (init) => {
        if (init?.method === "POST") {
          return new Response(JSON.stringify([{
            id: "c-new", workspace_id: "ws1", display_name: "Stranger",
            notes: "", metadata: {}, created_at: "2026-05-25T00:00:00.000Z",
          }]), { status: 201 });
        }
        return new Response(JSON.stringify([]), { status: 200 });   // no metadata match
      },
    });

    const r = new SupabaseIdentityResolver("https://supabase", "anon");
    const result = await r.resolveOrCreate({
      workspaceId: "ws1",
      channelType: "email",
      identifier: "stranger@example.com",
      displayName: "Stranger",
    });
    expect(result.contact.id).toBe("c-new");
    expect(result.created).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/storage-supabase test -- identity-resolver-auto-merge.test.ts
```

Expected: FAIL (current code doesn't do metadata lookup).

- [ ] **Step 3: Modify `packages/storage-supabase/src/identity-resolver.ts`**

Replace the existing `resolveOrCreate` method body. Find:
```ts
  async resolveOrCreate(args: {
    workspaceId: string;
    channelType: Channel["type"];
    identifier: string;
    displayName: string;
  }): Promise<IdentityResolveResult> {
    const channel = await this.findChannel(args.workspaceId, args.channelType);
    if (!channel) throw new Error(`no ${args.channelType} channel configured for workspace ${args.workspaceId}`);

    const existing = await this.findIdentity(channel.id, args.identifier);
    if (existing) {
      const contact = await this.contacts.findById(args.workspaceId, existing.contact_id);
      if (!contact) throw new Error(`identity ${existing.id} references missing contact ${existing.contact_id}`);
      return { contact, channel, channel_identity: existing, created: false };
    }

    const contact = await this.contacts.upsertByDisplayName(args.workspaceId, args.displayName);
    const created = await this.createIdentity(contact.id, channel.id, args.identifier);
    return { contact, channel, channel_identity: created, created: true };
  }
```

Replace with:
```ts
  async resolveOrCreate(args: {
    workspaceId: string;
    channelType: Channel["type"];
    identifier: string;
    displayName: string;
  }): Promise<IdentityResolveResult> {
    // Normalize email identifiers to lowercase. Other channels keep raw casing.
    const identifier = args.channelType === "email" ? args.identifier.toLowerCase() : args.identifier;

    const channel = await this.findChannel(args.workspaceId, args.channelType);
    if (!channel) throw new Error(`no ${args.channelType} channel configured for workspace ${args.workspaceId}`);

    // 1. Exact ChannelIdentity match
    const existing = await this.findIdentity(channel.id, identifier);
    if (existing) {
      const contact = await this.contacts.findById(args.workspaceId, existing.contact_id);
      if (!contact) throw new Error(`identity ${existing.id} references missing contact ${existing.contact_id}`);
      return { contact, channel, channel_identity: existing, created: false };
    }

    // 2. For email: try auto-merge via metadata.email_addresses[]
    if (args.channelType === "email") {
      const merged = await this.findContactByEmailMetadata(args.workspaceId, identifier);
      if (merged) {
        const newIdentity = await this.createIdentity(merged.id, channel.id, identifier);
        return { contact: merged, channel, channel_identity: newIdentity, created: true };
      }
    }

    // 3. No match → create new Contact + ChannelIdentity
    const contact = await this.contacts.upsertByDisplayName(args.workspaceId, args.displayName);
    const newIdentity = await this.createIdentity(contact.id, channel.id, identifier);
    return { contact, channel, channel_identity: newIdentity, created: true };
  }

  private async findContactByEmailMetadata(workspaceId: string, email: string): Promise<Contact | null> {
    // PostgREST: filter on jsonb contains. metadata->'email_addresses' ? <email>
    // URL-encode the email and use cs (contains) operator on the jsonb array.
    const enc = encodeURIComponent(JSON.stringify([email]));
    const url = `${this.url}/rest/v1/contacts?workspace_id=eq.${workspaceId}&metadata->email_addresses=cs.${enc}&select=*&limit=1`;
    const res = await fetch(url, { headers: this.headers() });
    if (!res.ok) throw new Error(`metadata contact lookup failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return rows.length ? ContactSchema.parse(rows[0]) : null;
  }
```

The `createIdentity` method is already lowercase-safe (it accepts the `identifier` arg verbatim, and we've lower-cased it in `resolveOrCreate` for email).

Update imports at top of `identity-resolver.ts` to include `Contact`:
```ts
import { ChannelSchema, ChannelIdentitySchema, ContactSchema, type Contact } from "@agent-mouth/core";
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @agent-mouth/storage-supabase test -- identity-resolver-auto-merge.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/storage-supabase/src/identity-resolver.ts \
        packages/storage-supabase/tests/identity-resolver-auto-merge.test.ts
git commit -m "feat(storage-supabase): IdentityResolver auto-merge via contacts.metadata.email_addresses (T15)"
```

---

### Task 16: Extend `send_message` MCP tool with `channel` and `subject` params

> **Parallelizable with T15, T17, T18** (different files).

**Files:**
- Modify: `packages/api/src/tools/messaging.ts`
- Modify: `packages/api/src/server.ts` (if `ToolDef` context needs registry — check first)
- Create: `packages/api/tests/send-message-channel.test.ts`

- [ ] **Step 1: Inspect existing ToolDef context**

Run:
```bash
head -60 /Users/gavrilomarkovicjankovic/01-Proyectos/agent-mouth/packages/api/src/server.ts
```

Expected: see the `ToolContext` type that `messaging.ts` handlers receive. We need to extend it with `transportRegistry` and `threadStore`.

- [ ] **Step 2: Write failing tests**

Create `packages/api/tests/send-message-channel.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { sendMessageTool } from "../src/tools/messaging.js";

const tgTransport = { send: vi.fn(async () => ({ message_id: "tg1", timestamp: new Date() })) };
const emailTransport = { send: vi.fn(async () => ({ message_id: "em1", timestamp: new Date() })) };

const registry = {
  get: (type: "telegram" | "email") => (type === "telegram" ? tgTransport : emailTransport),
};

const threadStore = {
  findById: vi.fn(async () => ({ id: "th1", channel_id: "ch1" })),
};

const channelStore = {
  findById: vi.fn(async () => ({ id: "ch1", type: "email" })),
};

describe("send_message tool with channel + subject params", () => {
  it("routes to email transport when channel='email'", async () => {
    await sendMessageTool.handler(
      { body: "hi", channel: "email", to: "marco@thecuina.com", subject: "Re: hello" },
      { transport: tgTransport as never, transportRegistry: registry as never, threadStore: threadStore as never, channelStore: channelStore as never } as never,
    );
    expect(emailTransport.send).toHaveBeenCalledWith(expect.objectContaining({
      to: "marco@thecuina.com", body: "hi", subject: "Re: hello",
    }));
    expect(tgTransport.send).not.toHaveBeenCalled();
  });

  it("routes to telegram transport when channel='telegram'", async () => {
    tgTransport.send.mockClear();
    emailTransport.send.mockClear();
    await sendMessageTool.handler(
      { body: "hello", channel: "telegram", to: "618021852" },
      { transport: tgTransport as never, transportRegistry: registry as never, threadStore: threadStore as never, channelStore: channelStore as never } as never,
    );
    expect(tgTransport.send).toHaveBeenCalled();
    expect(emailTransport.send).not.toHaveBeenCalled();
  });

  it("infers channel from reply_to_message_id thread when channel absent", async () => {
    tgTransport.send.mockClear();
    emailTransport.send.mockClear();
    threadStore.findById.mockResolvedValueOnce({ id: "th1", channel_id: "ch1" } as never);
    channelStore.findById.mockResolvedValueOnce({ id: "ch1", type: "email" } as never);
    await sendMessageTool.handler(
      { body: "hi", to: "marco@thecuina.com", reply_to_message_id: "th1", subject: "Re: x" },
      { transport: tgTransport as never, transportRegistry: registry as never, threadStore: threadStore as never, channelStore: channelStore as never } as never,
    );
    expect(emailTransport.send).toHaveBeenCalled();
  });

  it("falls back to default transport when no channel context", async () => {
    tgTransport.send.mockClear();
    emailTransport.send.mockClear();
    await sendMessageTool.handler(
      { body: "broadcast", to: "broadcast" },
      { transport: tgTransport as never, transportRegistry: registry as never, threadStore: threadStore as never, channelStore: channelStore as never } as never,
    );
    expect(tgTransport.send).toHaveBeenCalled();
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/api test -- send-message-channel.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Modify `packages/api/src/tools/messaging.ts`**

Replace `sendMessageTool` with:

```ts
export const sendMessageTool: ToolDef = {
  name: "send_message",
  description:
    "Send a message. For Telegram: `to` is a numeric chat id or handle. For Email: `to` is an email address; `subject` is required for new threads. If `channel` is omitted, the tool infers it from `reply_to_message_id`'s thread, falling back to the default transport.",
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
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const parsed = z
      .object({
        to: z.string().optional(),
        channel: z.enum(["telegram", "email"]).optional(),
        body: z.string().min(1),
        reply_to_message_id: z.string().optional(),
        subject: z.string().optional(),
      })
      .parse(input);

    // Resolve channel
    let channel = parsed.channel;
    if (!channel && parsed.reply_to_message_id && ctx.threadStore && ctx.channelStore) {
      try {
        const thread = await ctx.threadStore.findById(parsed.reply_to_message_id);
        if (thread) {
          const ch = await ctx.channelStore.findById(thread.channel_id);
          if (ch) channel = ch.type as "telegram" | "email";
        }
      } catch {
        // ignore lookup failures, fall back to default
      }
    }

    // Pick transport
    const transport = (channel && ctx.transportRegistry)
      ? ctx.transportRegistry.get(channel)
      : ctx.transport;

    return transport.send({
      to: parsed.to,
      body: parsed.body,
      reply_to_message_id: parsed.reply_to_message_id,
      subject: parsed.subject,
    });
  },
};
```

At the top of `messaging.ts`, no new imports needed (the `ctx` is passed by reference through `ToolContext`).

- [ ] **Step 5: Update `ToolContext` in `packages/api/src/server.ts`**

Find the `ToolContext` (or equivalent) interface and add optional fields:

```ts
export interface ToolContext {
  // existing fields ...
  transport: Transport;
  // new:
  transportRegistry?: {
    get(type: "telegram" | "email"): Transport;
  };
  channelStore?: { findById(id: string): Promise<{ id: string; type: string } | null> };
  // threadStore is likely already there; if not, add:
  threadStore?: { findById(id: string): Promise<{ id: string; channel_id: string } | null> };
}
```

- [ ] **Step 6: Run tests**

```bash
pnpm --filter @agent-mouth/api test -- send-message-channel.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/tools/messaging.ts \
        packages/api/src/server.ts \
        packages/api/tests/send-message-channel.test.ts
git commit -m "feat(api): send_message tool accepts channel + subject; infers channel from reply thread (T16)"
```

---

### Task 17: New MCP tool `link_email_to_contact`

> **Parallelizable with T15, T16, T18.**

**Files:**
- Create: `packages/api/src/tools/link-email-to-contact.ts`
- Modify: `packages/api/src/tools/_register.ts` (register new tool)
- Modify: `packages/storage-supabase/src/contact-store.ts` (add `addEmailToMetadata` method)
- Create: `packages/api/tests/link-email-to-contact.test.ts`

- [ ] **Step 1: Add `addEmailToMetadata` to ContactStore**

Open `packages/storage-supabase/src/contact-store.ts` and add a method:

```ts
  async addEmailToMetadata(workspaceId: string, contactId: string, email: string): Promise<Contact> {
    const lower = email.toLowerCase();
    // Atomic-ish: read current metadata, push email, patch
    const cur = await this.findById(workspaceId, contactId);
    if (!cur) throw new Error(`contact ${contactId} not found in workspace ${workspaceId}`);
    const existing = (cur.metadata?.email_addresses ?? []) as string[];
    if (existing.includes(lower)) return cur; // idempotent
    const updated = { ...cur.metadata, email_addresses: [...existing, lower] };
    const url = `${this.url}/rest/v1/contacts?id=eq.${contactId}`;
    const res = await fetch(url, {
      method: "PATCH",
      headers: { ...this.headers(), Prefer: "return=representation" },
      body: JSON.stringify({ metadata: updated }),
    });
    if (!res.ok) throw new Error(`contact metadata patch failed: ${res.status}`);
    const rows = (await res.json()) as unknown[];
    return ContactSchema.parse(rows[0]);
  }
```

(Match the existing class style — add `headers()` helper if not already there.)

- [ ] **Step 2: Write failing test**

Create `packages/api/tests/link-email-to-contact.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { linkEmailToContactTool } from "../src/tools/link-email-to-contact.js";

describe("link_email_to_contact", () => {
  it("calls contactStore.addEmailToMetadata with lowercase email", async () => {
    const addEmailToMetadata = vi.fn(async () => ({
      id: "c1", workspace_id: "ws1", display_name: "Marco",
      notes: "", metadata: { email_addresses: ["marco@thecuina.com"] },
      created_at: "2026-05-25T00:00:00.000Z",
    }));

    const r = await linkEmailToContactTool.handler(
      { contact_id: "c1", email: "Marco@TheCuina.com" },
      { contactStore: { addEmailToMetadata } as never, workspaceId: "ws1" } as never,
    );
    expect(addEmailToMetadata).toHaveBeenCalledWith("ws1", "c1", "Marco@TheCuina.com");
    expect((r as { ok: boolean }).ok).toBe(true);
  });

  it("rejects malformed email", async () => {
    await expect(
      linkEmailToContactTool.handler(
        { contact_id: "c1", email: "not-an-email" },
        { contactStore: { addEmailToMetadata: vi.fn() } as never, workspaceId: "ws1" } as never,
      ),
    ).rejects.toThrow();
  });

  it("rejects malformed contact_id", async () => {
    await expect(
      linkEmailToContactTool.handler(
        { contact_id: "not-uuid", email: "x@y.com" },
        { contactStore: { addEmailToMetadata: vi.fn() } as never, workspaceId: "ws1" } as never,
      ),
    ).rejects.toThrow();
  });
});
```

- [ ] **Step 3: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/api test -- link-email-to-contact.test.ts
```

Expected: FAIL.

- [ ] **Step 4: Create `packages/api/src/tools/link-email-to-contact.ts`**

```ts
// packages/api/src/tools/link-email-to-contact.ts
import { z } from "zod";
import type { ToolDef } from "../server.js";

export const linkEmailToContactTool: ToolDef = {
  name: "link_email_to_contact",
  description:
    "Register an email address to an existing Contact. Future inbound emails from this address will auto-merge into that Contact instead of creating a duplicate. Useful when you confirm someone's identity mid-conversation.",
  inputSchema: {
    type: "object",
    required: ["contact_id", "email"],
    properties: {
      contact_id: { type: "string", format: "uuid" },
      email: { type: "string", format: "email" },
    },
    additionalProperties: false,
  },
  handler: async (input, ctx) => {
    const parsed = z
      .object({
        contact_id: z.string().uuid(),
        email: z.string().email(),
      })
      .parse(input);

    if (!ctx.contactStore) throw new Error("contactStore not configured");
    if (!ctx.workspaceId) throw new Error("workspaceId not configured");

    const contact = await ctx.contactStore.addEmailToMetadata(
      ctx.workspaceId,
      parsed.contact_id,
      parsed.email,
    );
    return {
      ok: true,
      contact_id: contact.id,
      email_addresses: contact.metadata?.email_addresses ?? [],
    };
  },
};
```

- [ ] **Step 5: Register tool in `packages/api/src/tools/_register.ts`**

Add:
```ts
import { linkEmailToContactTool } from "./link-email-to-contact.js";
```

And to the registration block (find existing pattern):
```ts
  server.tool(linkEmailToContactTool);
```

- [ ] **Step 6: Update `ToolContext` to include `contactStore.addEmailToMetadata`**

In `packages/api/src/server.ts`, ensure ToolContext has:
```ts
  contactStore?: {
    addEmailToMetadata(workspaceId: string, contactId: string, email: string): Promise<Contact>;
  };
```

- [ ] **Step 7: Run tests**

```bash
pnpm --filter @agent-mouth/api test -- link-email-to-contact.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 8: Commit**

```bash
git add packages/storage-supabase/src/contact-store.ts \
        packages/api/src/tools/link-email-to-contact.ts \
        packages/api/src/tools/_register.ts \
        packages/api/src/server.ts \
        packages/api/tests/link-email-to-contact.test.ts
git commit -m "feat(api): link_email_to_contact MCP tool + ContactStore.addEmailToMetadata (T17)"
```

---

### Task 18: `TransportRegistry`

> **Parallelizable with T15-T17.**

**Files:**
- Create: `packages/api/src/transports/registry.ts`
- Create: `packages/api/tests/transport-registry.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/api/tests/transport-registry.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { TransportRegistry } from "../src/transports/registry.js";

describe("TransportRegistry", () => {
  it("registers and gets transports by ChannelType", () => {
    const reg = new TransportRegistry();
    const tg = { send: vi.fn() } as never;
    const em = { send: vi.fn() } as never;
    reg.register("telegram", tg);
    reg.register("email", em);
    expect(reg.get("telegram")).toBe(tg);
    expect(reg.get("email")).toBe(em);
  });

  it("throws on get of unregistered type", () => {
    const reg = new TransportRegistry();
    expect(() => reg.get("whatsapp")).toThrow(/no transport.*whatsapp/i);
  });

  it("has(type) returns boolean", () => {
    const reg = new TransportRegistry();
    expect(reg.has("telegram")).toBe(false);
    reg.register("telegram", {} as never);
    expect(reg.has("telegram")).toBe(true);
  });

  it("list() returns all registered channel types", () => {
    const reg = new TransportRegistry();
    reg.register("telegram", {} as never);
    reg.register("email", {} as never);
    expect(reg.list().sort()).toEqual(["email", "telegram"]);
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/api test -- transport-registry.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `packages/api/src/transports/registry.ts`**

```ts
// packages/api/src/transports/registry.ts
import type { ChannelType, Transport } from "@agent-mouth/core";

export class TransportRegistry {
  private byType = new Map<ChannelType, Transport>();

  register(type: ChannelType, transport: Transport): void {
    this.byType.set(type, transport);
  }

  get(type: ChannelType): Transport {
    const t = this.byType.get(type);
    if (!t) throw new Error(`no transport registered for channel type "${type}"`);
    return t;
  }

  has(type: ChannelType): boolean {
    return this.byType.has(type);
  }

  list(): ChannelType[] {
    return [...this.byType.keys()];
  }
}
```

- [ ] **Step 4: Run tests**

```bash
pnpm --filter @agent-mouth/api test -- transport-registry.test.ts
```

Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/transports/registry.ts \
        packages/api/tests/transport-registry.test.ts
git commit -m "feat(api): TransportRegistry resolves transports by ChannelType (T18)"
```

---

## Sprint 5 — CLI + cron jobs + kill switch + bootstrap (T19 → T22)

### Task 19: CLI `email:setup` (OAuth flow + initial watch)

**Files:**
- Create: `packages/api/src/cli/email-setup.ts`
- Modify: `packages/api/src/cli/index.ts` (wire command)
- Create: `packages/api/tests/email-setup.test.ts`

- [ ] **Step 1: Write failing tests (parser + helpers only — actual OAuth flow tested manually)**

Create `packages/api/tests/email-setup.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { parseEmailSetupArgs } from "../src/cli/email-setup.js";

describe("parseEmailSetupArgs", () => {
  it("returns defaults when no args", () => {
    const args = parseEmailSetupArgs([]);
    expect(args.port).toBe(53682);
    expect(args.scopes).toContain("https://www.googleapis.com/auth/gmail.readonly");
  });

  it("parses --port and --workspace-id", () => {
    const args = parseEmailSetupArgs(["--port", "9999", "--workspace-id", "ws-uuid"]);
    expect(args.port).toBe(9999);
    expect(args.workspaceId).toBe("ws-uuid");
  });

  it("parses --topic", () => {
    const args = parseEmailSetupArgs(["--topic", "projects/p/topics/gmail-notifications"]);
    expect(args.topicName).toBe("projects/p/topics/gmail-notifications");
  });
});
```

- [ ] **Step 2: Run tests**

```bash
pnpm --filter @agent-mouth/api test -- email-setup.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Create `packages/api/src/cli/email-setup.ts`**

```ts
// packages/api/src/cli/email-setup.ts
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { Client as PgClient } from "pg";
import {
  GmailDriver,
  buildAuthUrl,
  encryptToken,
  exchangeCodeForTokens,
} from "@agent-mouth/transport-email";
import { SupabaseEmailTokenStore, SupabaseWorkspaceStore } from "@agent-mouth/storage-supabase";
import { logger } from "../logger.js";

const DEFAULT_SCOPES = [
  "https://www.googleapis.com/auth/gmail.readonly",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.modify",
];

export interface EmailSetupArgs {
  port: number;
  workspaceId?: string;
  topicName?: string;
  scopes: string[];
}

export function parseEmailSetupArgs(argv: string[]): EmailSetupArgs {
  const get = (flag: string): string | undefined => {
    const i = argv.indexOf(flag);
    return i >= 0 && i + 1 < argv.length ? argv[i + 1] : undefined;
  };
  return {
    port: Number(get("--port") ?? "53682"),
    workspaceId: get("--workspace-id"),
    topicName: get("--topic") ?? process.env.GOOGLE_PUBSUB_TOPIC,
    scopes: DEFAULT_SCOPES,
  };
}

export async function emailSetup(argv: string[]): Promise<void> {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
  const encryptionKey = process.env.AGENT_MOUTH_TOKEN_ENCRYPTION_KEY;
  if (!supabaseUrl || !supabaseKey || !clientId || !clientSecret || !encryptionKey) {
    logger.error(
      "Missing required env: SUPABASE_URL, SUPABASE_ANON_KEY, GOOGLE_OAUTH_CLIENT_ID, GOOGLE_OAUTH_CLIENT_SECRET, AGENT_MOUTH_TOKEN_ENCRYPTION_KEY",
    );
    process.exit(1);
  }

  const opts = parseEmailSetupArgs(argv);
  if (!opts.topicName) {
    logger.error("Missing --topic <topic-name> or GOOGLE_PUBSUB_TOPIC env var");
    process.exit(1);
  }

  let workspaceId = opts.workspaceId;
  if (!workspaceId) {
    const ws = new SupabaseWorkspaceStore(supabaseUrl, supabaseKey);
    const def = await ws.getDefault();
    workspaceId = def.id;
  }

  const redirectUri = `http://localhost:${opts.port}/callback`;
  const authUrl = buildAuthUrl({ clientId, redirectUri, scopes: opts.scopes });

  console.log("\n=== Agent Mouth — Email Setup ===\n");
  console.log("Open this URL in your browser:\n");
  console.log(authUrl);
  console.log("\nWaiting for redirect (Ctrl-C to abort)...\n");

  const code = await waitForCode(opts.port);
  console.log(`Received code, exchanging for tokens...`);

  const tokens = await exchangeCodeForTokens({ clientId, clientSecret, redirectUri, code });
  if (!tokens.refresh_token) {
    logger.error("No refresh_token returned. Re-run with prompt=consent.");
    process.exit(1);
  }

  // Get email + initial historyId
  const driver = new GmailDriver({ clientId, clientSecret });
  const me = await driver.whoami({ refresh_token: tokens.refresh_token, email_address: "" });
  console.log(`Authenticated as: ${me.email_address}`);

  // Initial watch
  const watch = await driver.watch({
    auth: { refresh_token: tokens.refresh_token, email_address: me.email_address },
    topic_name: opts.topicName,
  });
  console.log(`Watch created. Expires: ${watch.expiration}`);

  // Ensure channel row exists for type='email' in this workspace
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    logger.error("DATABASE_URL required for channel upsert");
    process.exit(1);
  }
  const pg = new PgClient({ connectionString: databaseUrl });
  await pg.connect();
  let channelId: string;
  try {
    const existing = await pg.query(
      `SELECT id FROM channels WHERE workspace_id=$1 AND type='email' LIMIT 1`,
      [workspaceId],
    );
    if (existing.rows.length > 0) {
      channelId = existing.rows[0].id;
    } else {
      const ins = await pg.query(
        `INSERT INTO channels (workspace_id, type, config, status) VALUES ($1, 'email', $2, 'active') RETURNING id`,
        [workspaceId, JSON.stringify({ email_address: me.email_address })],
      );
      channelId = ins.rows[0].id;
    }
  } finally {
    await pg.end().catch(() => {});
  }

  // Save token row
  const tokenStore = new SupabaseEmailTokenStore({ url: supabaseUrl, anonKey: supabaseKey });
  await tokenStore.upsert({
    workspace_id: workspaceId,
    channel_id: channelId,
    email_address: me.email_address,
    refresh_token_encrypted: encryptToken(tokens.refresh_token, encryptionKey),
    scopes: opts.scopes,
    last_history_id: watch.history_id,
    watch_expiration: watch.expiration,
    status: "active",
    last_error: null,
    consecutive_renewal_failures: 0,
  });

  console.log(`\n✅ Setup complete for ${me.email_address}`);
  console.log(`Watch expires ${watch.expiration} — auto-renewal cron will refresh every 6 days`);
}

function waitForCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${port}`);
      if (url.pathname !== "/callback") {
        res.writeHead(404).end("not found");
        return;
      }
      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");
      if (error) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(`<h1>Error: ${error}</h1>`);
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }
      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" }).end(`<h1>No code</h1>`);
        server.close();
        reject(new Error("no code in redirect"));
        return;
      }
      res.writeHead(200, { "Content-Type": "text/html" }).end(
        `<h1>Authorization received</h1><p>You can close this tab.</p>`,
      );
      server.close();
      resolve(code);
    });
    server.on("error", reject);
    server.listen(port, "127.0.0.1");
  });
}
```

- [ ] **Step 4: Wire command in `packages/api/src/cli/index.ts`**

Find the existing command-dispatch switch (similar pattern to `seed-knowledge`) and add:

```ts
  if (cmd === "email:setup") {
    await emailSetup(rest);
    process.exit(0);
  }
```

Add the import at the top:
```ts
import { emailSetup } from "./email-setup.js";
```

- [ ] **Step 5: Run tests**

```bash
pnpm --filter @agent-mouth/api test -- email-setup.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 6: Build + typecheck**

```bash
pnpm -r typecheck
pnpm --filter @agent-mouth/api build
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/cli/email-setup.ts \
        packages/api/src/cli/index.ts \
        packages/api/tests/email-setup.test.ts
git commit -m "feat(api): email:setup CLI (OAuth flow + watch creation + token storage) (T19)"
```

---

### Task 20: Cron jobs `email.poll.fallback` (10min) + `email.watch.renew` (6 days)

**Files:**
- Create: `packages/api/src/email-poll-fallback.ts`
- Create: `packages/api/src/email-watch-renew.ts`
- Modify: `packages/api/src/worker.ts` (register both crons)
- Create: `packages/api/tests/email-poll-fallback.test.ts`
- Create: `packages/api/tests/email-watch-renew.test.ts`

- [ ] **Step 1: Write failing test for email-poll-fallback**

Create `packages/api/tests/email-poll-fallback.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleEmailPollFallback } from "../src/email-poll-fallback.js";

describe("handleEmailPollFallback", () => {
  it("iterates active tokens and triggers email.fetch logic for each", async () => {
    const tokens = [
      { id: "t1", workspace_id: "ws1", channel_id: "ch1", email_address: "a@a.com", refresh_token_encrypted: "e", scopes: [], last_history_id: "10", watch_expiration: null, status: "active", last_error: null, consecutive_renewal_failures: 0, created_at: "x", updated_at: "x" },
      { id: "t2", workspace_id: "ws1", channel_id: "ch2", email_address: "b@b.com", refresh_token_encrypted: "e", scopes: [], last_history_id: "20", watch_expiration: null, status: "active", last_error: null, consecutive_renewal_failures: 0, created_at: "x", updated_at: "x" },
    ];
    const tokenStore = { list: vi.fn(async () => tokens) };
    const fetchOne = vi.fn(async () => undefined);

    await handleEmailPollFallback({
      tokenStore: tokenStore as never,
      fetchOne: fetchOne as never,
    });
    expect(fetchOne).toHaveBeenCalledTimes(2);
    expect(fetchOne).toHaveBeenCalledWith("a@a.com", "10");
    expect(fetchOne).toHaveBeenCalledWith("b@b.com", "20");
  });

  it("skips non-active tokens", async () => {
    const tokens = [
      { id: "t1", workspace_id: "ws1", channel_id: "ch1", email_address: "a@a.com", refresh_token_encrypted: "e", scopes: [], last_history_id: "10", watch_expiration: null, status: "error", last_error: null, consecutive_renewal_failures: 0, created_at: "x", updated_at: "x" },
    ];
    const tokenStore = { list: vi.fn(async () => tokens) };
    const fetchOne = vi.fn();
    await handleEmailPollFallback({
      tokenStore: tokenStore as never,
      fetchOne: fetchOne as never,
    });
    expect(fetchOne).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test, see failure, create `packages/api/src/email-poll-fallback.ts`**

```ts
// packages/api/src/email-poll-fallback.ts
import type { SupabaseEmailTokenStore } from "@agent-mouth/storage-supabase";
import { logger } from "./logger.js";

export interface EmailPollFallbackDeps {
  tokenStore: Pick<SupabaseEmailTokenStore, "list">;
  /**
   * Re-uses the email.fetch logic per token. Implementations should call
   * the same path that the webhook would (driver.fetchNewMessages + processInbound + queue).
   */
  fetchOne: (emailAddress: string, lastHistoryId: string) => Promise<void>;
}

export async function handleEmailPollFallback(deps: EmailPollFallbackDeps): Promise<void> {
  const tokens = await deps.tokenStore.list();
  for (const tok of tokens) {
    if (tok.status !== "active") continue;
    try {
      await deps.fetchOne(tok.email_address, tok.last_history_id ?? "1");
    } catch (err) {
      logger.error({ err: String(err), email: tok.email_address }, "email.poll.fallback per-token failure");
    }
  }
}
```

Run test → PASS (2 tests).

- [ ] **Step 3: Write failing test for email-watch-renew**

Create `packages/api/tests/email-watch-renew.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest";
import { handleEmailWatchRenew } from "../src/email-watch-renew.js";

describe("handleEmailWatchRenew", () => {
  it("calls driver.watch for each active token and updates expiration", async () => {
    const tokens = [
      { id: "t1", email_address: "a@a.com", refresh_token_encrypted: "e", status: "active", consecutive_renewal_failures: 0 },
    ];
    const watch = vi.fn(async () => ({ history_id: "999", expiration: "2026-06-15T00:00:00.000Z" }));
    const updateWatchExpiration = vi.fn(async () => undefined);
    const incrementRenewalFailures = vi.fn(async () => 1);
    const markError = vi.fn(async () => undefined);
    const decrypt = vi.fn(() => "rt");

    await handleEmailWatchRenew({
      tokenStore: { list: vi.fn(async () => tokens), updateWatchExpiration, incrementRenewalFailures, markError } as never,
      driver: { watch } as never,
      decrypt,
      encryptionKey: "k",
      topicName: "projects/p/topics/x",
    });
    expect(watch).toHaveBeenCalled();
    expect(updateWatchExpiration).toHaveBeenCalledWith("t1", "2026-06-15T00:00:00.000Z");
  });

  it("marks status=error after 3 consecutive failures", async () => {
    const tokens = [
      { id: "t1", email_address: "a@a.com", refresh_token_encrypted: "e", status: "active", consecutive_renewal_failures: 2 },
    ];
    const watch = vi.fn(async () => { throw new Error("API down"); });
    const incrementRenewalFailures = vi.fn(async () => 3);
    const markError = vi.fn(async () => undefined);

    await handleEmailWatchRenew({
      tokenStore: { list: vi.fn(async () => tokens), updateWatchExpiration: vi.fn(), incrementRenewalFailures, markError } as never,
      driver: { watch } as never,
      decrypt: vi.fn(() => "rt"),
      encryptionKey: "k",
      topicName: "x",
    });
    expect(incrementRenewalFailures).toHaveBeenCalledWith("t1");
    expect(markError).toHaveBeenCalled();
  });
});
```

- [ ] **Step 4: Run test, see failure, create `packages/api/src/email-watch-renew.ts`**

```ts
// packages/api/src/email-watch-renew.ts
import type { SupabaseEmailTokenStore } from "@agent-mouth/storage-supabase";
import type { GmailDriver } from "@agent-mouth/transport-email";
import { logger } from "./logger.js";

export interface EmailWatchRenewDeps {
  tokenStore: Pick<
    SupabaseEmailTokenStore,
    "list" | "updateWatchExpiration" | "incrementRenewalFailures" | "markError"
  >;
  driver: Pick<GmailDriver, "watch">;
  decrypt: (cipher: string, keyHex: string) => string;
  encryptionKey: string;
  topicName: string;
}

const MAX_RENEWAL_FAILURES = 3;

export async function handleEmailWatchRenew(deps: EmailWatchRenewDeps): Promise<void> {
  const tokens = await deps.tokenStore.list();
  for (const tok of tokens) {
    if (tok.status !== "active") continue;
    try {
      const refreshToken = deps.decrypt(tok.refresh_token_encrypted, deps.encryptionKey);
      const w = await deps.driver.watch({
        auth: { refresh_token: refreshToken, email_address: tok.email_address },
        topic_name: deps.topicName,
      });
      await deps.tokenStore.updateWatchExpiration(tok.id, w.expiration);
      logger.info({ email: tok.email_address, expiration: w.expiration }, "watch renewed");
    } catch (err) {
      const fails = await deps.tokenStore.incrementRenewalFailures(tok.id).catch(() => 0);
      logger.error({ err: String(err), email: tok.email_address, fails }, "watch renewal failed");
      if (fails >= MAX_RENEWAL_FAILURES) {
        await deps.tokenStore.markError(
          tok.id,
          `watch renewal failed ${fails} times: ${String(err).slice(0, 200)}`,
        );
      }
    }
  }
}
```

Run tests → PASS (2 tests).

- [ ] **Step 5: Register cron jobs in worker.ts**

In `packages/api/src/worker.ts`, after the existing `knowledge.sync` registration, add:

```ts
  if (deps.emailFetchDeps) {
    // email.poll.fallback — safety net every 10 min
    const fallbackInterval = Number(process.env.EMAIL_POLL_FALLBACK_INTERVAL_MIN ?? "10");
    await queue.scheduleRecurring(
      "email.poll.fallback",
      `*/${fallbackInterval} * * * *`,
      {},
      { singletonKey: "email.poll.singleton" },
    );
    await queue.work("email.poll.fallback", async () => {
      await handleEmailPollFallback({
        tokenStore: deps.emailFetchDeps!.tokenStore,
        fetchOne: async (email, lastHistoryId) => {
          await queue.send(
            "email.fetch",
            { email_address: email, history_id: lastHistoryId },
            { singletonKey: `email.fetch.${email}.${lastHistoryId}` },
          );
        },
      });
    });

    // email.watch.renew — every 6 days
    const renewIntervalDays = Number(process.env.EMAIL_WATCH_RENEW_INTERVAL_DAYS ?? "6");
    await queue.scheduleRecurring(
      "email.watch.renew",
      `0 5 */${renewIntervalDays} * *`,    // 05:00 UTC every N days
      {},
      { singletonKey: "email.watch.renew.singleton" },
    );
    await queue.work("email.watch.renew", async () => {
      await handleEmailWatchRenew({
        tokenStore: deps.emailFetchDeps!.tokenStore,
        driver: deps.emailFetchDeps!.driver,
        decrypt: deps.emailFetchDeps!.decrypt,
        encryptionKey: deps.emailFetchDeps!.encryptionKey,
        topicName: deps.emailFetchDeps!.topicName,
      });
    });
  }
```

Update `WorkerDeps.emailFetchDeps` interface to include `topicName: string`.

Add imports:
```ts
import { handleEmailPollFallback } from "./email-poll-fallback.js";
import { handleEmailWatchRenew } from "./email-watch-renew.js";
```

- [ ] **Step 6: Build + typecheck**

```bash
pnpm -r typecheck
```

Expected: clean.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/email-poll-fallback.ts \
        packages/api/src/email-watch-renew.ts \
        packages/api/tests/email-poll-fallback.test.ts \
        packages/api/tests/email-watch-renew.test.ts \
        packages/api/src/worker.ts
git commit -m "feat(api): email.poll.fallback (10min) + email.watch.renew (6d) cron handlers (T20)"
```

---

### Task 21: Kill switch `ENABLE_EMAIL_AUTO` in router

**Files:**
- Modify: `packages/api/src/router.ts` (force silent when email + flag false)
- Create: `packages/api/tests/router-email-kill-switch.test.ts`

- [ ] **Step 1: Write failing test**

Create `packages/api/tests/router-email-kill-switch.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processInbound, type RouterDeps } from "../src/router.js";

const inboundEmail = {
  channel_type: "email" as const,
  external_message_id: "m1",
  external_thread_id: "t1",
  sender_identifier: "marco@thecuina.com",
  sender_display_name: "Marco",
  sender_handle: null,
  chat_type: "private" as const,
  content: "hello",
  attachments: [],
  raw_payload: {},
  received_at: "2026-05-25T10:00:00.000Z",
};

function makeDeps(): RouterDeps {
  return {
    workspaceId: "ws1",
    bridgeForwardChats: new Set(),
    bridgeForwardUrl: null,
    identityResolver: { resolveOrCreate: vi.fn(async () => ({
      contact: { id: "c1", workspace_id: "ws1", display_name: "Marco", notes: "", metadata: {}, created_at: "x" },
      channel: { id: "ch1", workspace_id: "ws1", type: "email", config: {}, status: "active", created_at: "x" },
      channel_identity: { id: "ci1", contact_id: "c1", channel_id: "ch1", identifier: "marco@thecuina.com", verified: false },
      created: false,
    })) } as never,
    threadStore: { findOrCreate: vi.fn(async () => ({ id: "th1", workspace_id: "ws1", contact_id: "c1", channel_id: "ch1", external_thread_id: "t1", related_thread_ids: [], last_message_at: null, closed: false, notes_last_updated_at: null, created_at: "x" })) } as never,
    policyEngine: { evaluate: vi.fn(async () => ({ policy: "auto" })) } as never,
    messageStore: { add: vi.fn(async () => ({ id: "msg-uuid" })) } as never,
    forwarder: vi.fn(),
  };
}

describe("router kill switch ENABLE_EMAIL_AUTO", () => {
  const origEnv = process.env.ENABLE_EMAIL_AUTO;
  afterEach(() => { process.env.ENABLE_EMAIL_AUTO = origEnv; });

  it("forces policy=silent when ENABLE_EMAIL_AUTO=false and channel_type=email", async () => {
    process.env.ENABLE_EMAIL_AUTO = "false";
    const result = await processInbound(inboundEmail, makeDeps());
    if (result.kind !== "persisted") throw new Error(`expected persisted, got ${result.kind}`);
    expect(result.policy).toBe("silent");
  });

  it("respects underlying policy when ENABLE_EMAIL_AUTO=true", async () => {
    process.env.ENABLE_EMAIL_AUTO = "true";
    const result = await processInbound(inboundEmail, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("auto");
  });

  it("ignores kill switch for non-email channels", async () => {
    process.env.ENABLE_EMAIL_AUTO = "false";
    const result = await processInbound({ ...inboundEmail, channel_type: "telegram" }, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("auto");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

```bash
pnpm --filter @agent-mouth/api test -- router-email-kill-switch.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Modify `packages/api/src/router.ts`**

In `processInbound`, find where the policy is resolved (after `policyEngine.evaluate`). After that line, add:

```ts
  // Phase 1b kill switch: when ENABLE_EMAIL_AUTO=false, force email policy to silent.
  // Re-read on every invocation (no cache) so flipping the env var is effective at next request.
  let effectivePolicy = policy.policy;
  if (msg.channel_type === "email" && process.env.ENABLE_EMAIL_AUTO === "false") {
    effectivePolicy = "silent";
  }
```

Then use `effectivePolicy` instead of `policy.policy` in the returned object's `policy` field.

- [ ] **Step 4: Run tests to verify pass**

```bash
pnpm --filter @agent-mouth/api test -- router-email-kill-switch.test.ts
```

Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/api/src/router.ts \
        packages/api/tests/router-email-kill-switch.test.ts
git commit -m "feat(api): ENABLE_EMAIL_AUTO kill switch — force email policy to silent at router (T21)"
```

---

### Task 22: Bootstrap EmailTransport + webhook deps + crons in `serve-http.ts`

**Files:**
- Modify: `packages/api/src/cli/serve-http.ts`

- [ ] **Step 1: Add bootstrap block after Telegram bootstrap**

In `serve-http.ts`, after the existing `telegramTransport.init(...)` block, add:

```ts
  // Phase 1b — EmailTransport bootstrap
  let emailWebhookDeps: EmailWebhookDeps | null = null;
  let emailFetchDeps: WorkerDeps["emailFetchDeps"] = undefined;
  let transportRegistry: TransportRegistry | null = null;

  const enableEmail = process.env.ENABLE_EMAIL_TRANSPORT === "true";
  if (enableEmail) {
    const gClientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
    const gClientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;
    const encryptionKey = process.env.AGENT_MOUTH_TOKEN_ENCRYPTION_KEY;
    const pubsubTopic = process.env.GOOGLE_PUBSUB_TOPIC;
    const pubsubSAEmail = process.env.GOOGLE_PUBSUB_SERVICE_ACCOUNT_EMAIL;
    const webhookAudience = process.env.EMAIL_WEBHOOK_AUDIENCE;

    if (!gClientId || !gClientSecret || !encryptionKey || !pubsubTopic || !pubsubSAEmail || !webhookAudience) {
      logger.warn(
        "ENABLE_EMAIL_TRANSPORT=true but missing required env vars; EmailTransport will not boot",
      );
    } else {
      const driver = new GmailDriver({ clientId: gClientId, clientSecret: gClientSecret });
      const tokenStore = new SupabaseEmailTokenStore({ url: supabaseUrl, anonKey: supabaseKey });
      const webhookEventsStore = new SupabaseEmailWebhookEventsStore({ url: supabaseUrl, anonKey: supabaseKey });

      // Pick the first active token for this workspace as the EmailTransport identity
      const tokens = await tokenStore.list(workspace.id);
      const activeToken = tokens.find((t) => t.status === "active");
      if (!activeToken) {
        logger.warn("ENABLE_EMAIL_TRANSPORT=true but no active email_oauth_tokens row — run `pnpm cli email:setup` first");
      } else {
        const refreshToken = decryptToken(activeToken.refresh_token_encrypted, encryptionKey);
        const emailTransport = new EmailTransport({
          driver,
          auth: { refresh_token: refreshToken, email_address: activeToken.email_address },
        });
        await emailTransport.init({});

        transportRegistry = new TransportRegistry();
        transportRegistry.register("telegram", telegramTransport);
        transportRegistry.register("email", emailTransport);

        emailWebhookDeps = {
          verifyJwt: verifyGooglePushJwt,
          webhookEventsStore,
          queueEnqueue: async (name, data, opts) => {
            if (!workerCtl) throw new Error("queue not available");
            await workerCtl.queue.send(name, data, opts ?? {});
          },
          config: { audience: webhookAudience, serviceAccountEmail: pubsubSAEmail },
        };

        emailFetchDeps = {
          tokenStore,
          driver,
          decrypt: decryptToken,
          encryptionKey,
          routerDeps,
          processInbound,
          topicName: pubsubTopic,
        };

        logger.info({ email: activeToken.email_address }, "email transport bootstrapped");
      }
    }
  }
```

Imports at the top of `serve-http.ts`:
```ts
import {
  GmailDriver,
  EmailTransport,
  decryptToken,
  verifyGooglePushJwt,
} from "@agent-mouth/transport-email";
import {
  SupabaseEmailTokenStore,
  SupabaseEmailWebhookEventsStore,
} from "@agent-mouth/storage-supabase";
import { TransportRegistry } from "../transports/registry.js";
```

- [ ] **Step 2: Pass `emailFetchDeps` to `startWorker`**

Find the `startWorker({...})` call and add:
```ts
        emailFetchDeps,
```

- [ ] **Step 3: Wire transportRegistry + channelStore into MCP server context**

Find where `buildServer({...})` is called. Add:
```ts
          transportRegistry: transportRegistry ?? undefined,
          channelStore: { findById: async (id) => { /* simple lookup, or use existing helper */
            const url = `${supabaseUrl}/rest/v1/channels?id=eq.${id}&select=id,type&limit=1`;
            const res = await fetch(url, {
              headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
            });
            if (!res.ok) return null;
            const rows = (await res.json()) as Array<{ id: string; type: string }>;
            return rows[0] ?? null;
          } },
          threadStore,
          contactStore,
          workspaceId: workspace.id,
```

- [ ] **Step 4: Replace the placeholder `emailWebhookDeps = null` line from T13 with the real assignment above**

Find:
```ts
  const emailWebhookDeps: EmailWebhookDeps | null = null; // wired in T22
```

Delete that line (the new bootstrap block handles it).

- [ ] **Step 5: Build + typecheck**

```bash
pnpm -r typecheck
pnpm -r build
```

Expected: clean.

- [ ] **Step 6: Local smoke (without prod secrets)**

```bash
ENABLE_EMAIL_TRANSPORT=false node packages/api/dist/cli/serve-http.js
# Expected: server starts, telegramTransport bootstraps, no email errors.
```

Stop with Ctrl-C.

- [ ] **Step 7: Commit**

```bash
git add packages/api/src/cli/serve-http.ts
git commit -m "feat(api): bootstrap EmailTransport + /email-webhook + cron crons (T22)"
```

---

## Sprint 6 — Runbook + Deploy + Gate 1b (T23 → T25)

### Task 23: Runbook for Phase 1b rollout

**Files:**
- Create: `docs/runbooks/2026-05-25-phase-1b-rollout.md`

- [ ] **Step 1: Create runbook**

Write to `docs/runbooks/2026-05-25-phase-1b-rollout.md`:

```markdown
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
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/2026-05-25-phase-1b-rollout.md
git commit -m "docs(runbooks): Phase 1b rollout runbook (T23)"
```

---

### Task 24: Execute deployment (follow runbook)

**Files:** none (operational task; the runbook drives the steps)

- [ ] **Step 1: Execute runbook §1 — Google Cloud setup**

Run all `gcloud` commands. Capture output for the runbook log.

- [ ] **Step 2: Execute runbook §2 — generate encryption key**

```bash
openssl rand -hex 32 | tee /tmp/email-encryption-key.txt
# IMMEDIATELY: copy into 1Password / Bitwarden, then `rm /tmp/email-encryption-key.txt`
```

- [ ] **Step 3: Execute runbook §3 — apply migration to prod**

Open Supabase SQL editor for project `deicbuvcynqontfbnboe`. Paste `packages/storage-supabase/sql/0005_email_transport.sql`. Run.

Verify tables exist (3 queries from runbook §3).

- [ ] **Step 4: Execute runbook §4 — set Fly secrets**

```bash
flyctl secrets set GOOGLE_OAUTH_CLIENT_ID="..." [...] --app agent-mouth
```

Verify with:
```bash
flyctl secrets list --app agent-mouth | grep -E "GOOGLE|EMAIL|ENCRYPTION"
```

- [ ] **Step 5: Execute runbook §5 — deploy code**

```bash
flyctl deploy --app agent-mouth
flyctl logs --app agent-mouth | tee /tmp/phase-1b-deploy.log
```

Expected log lines:
- `agent-mouth serving over HTTP { port: ... }`
- `pg-boss worker started`
- NO `email transport bootstrapped` (no token yet)
- NO crash

- [ ] **Step 6: Execute runbook §6 — run email:setup**

Following the runbook exactly. End state: 1 row in `email_oauth_tokens` with `status='active'`.

- [ ] **Step 7: Execute runbook §7 — redeploy so transport picks up token**

```bash
flyctl deploy --app agent-mouth
flyctl logs --app agent-mouth | grep "email transport bootstrapped"
```

- [ ] **Step 8: Execute runbook §8 — smoke test**

Send manual email, observe webhook within 5s, see row in `messages`.

- [ ] **Step 9: Commit deploy log**

```bash
mkdir -p docs/runbooks/logs
cp /tmp/phase-1b-deploy.log docs/runbooks/logs/2026-05-25-phase-1b-deploy.log
git add docs/runbooks/logs/2026-05-25-phase-1b-deploy.log
git commit -m "ops: Phase 1b deploy log (T24)"
```

---

### Task 25: Gate 1b — End-to-end acceptance test

**Files:** none (operational test)

- [ ] **Step 1: Flip to auto mode**

```bash
flyctl secrets set ENABLE_EMAIL_AUTO=true --app agent-mouth
flyctl deploy --app agent-mouth
```

Wait for redeploy.

- [ ] **Step 2: Send the Gate test email**

From `gavrilo.markovic@gmail.com` → `gavrilux.agent@gmail.com`:

> Subject: phase-1b gate test
> Body: phase-1b gate test, respond with 'gate ok'

- [ ] **Step 3: Verify reply within 60s (target <5s for webhook path)**

Check your personal inbox: a reply from `gavrilux.agent@gmail.com` should arrive. Body must contain `gate ok`.

- [ ] **Step 4: Verify cross-channel `read_inbox`**

From Claude Code (which has the MCP server connection), invoke:

```
mcp__agent-mouth__read_inbox limit=20
```

Expected: list contains both Telegram messages AND the gate test email + the agent's reply, ordered by timestamp.

- [ ] **Step 5: Verify audit log**

```sql
SELECT event_name, created_at, metadata->>'subject' as subject
FROM audit_log
WHERE event_name LIKE 'email.%' AND created_at > now() - interval '10 minutes'
ORDER BY created_at;
```

Expected: 3 rows for this flow (`email.received`, `agent.respond.completed`, `email.sent`).

- [ ] **Step 6: Verify identity auto-merge**

```sql
-- Add your personal email to your own Contact:
UPDATE contacts SET metadata = jsonb_set(metadata, '{email_addresses}', '["gavrilo.markovic@gmail.com"]')
WHERE display_name = 'Gavrilo';

-- Send another email from gavrilo.markovic@gmail.com.
-- Then check: same Contact, new ChannelIdentity:
SELECT c.id, c.display_name, ci.identifier, ch.type
FROM contacts c
JOIN channel_identities ci ON ci.contact_id = c.id
JOIN channels ch ON ch.id = ci.channel_id
WHERE c.display_name = 'Gavrilo';
```

Expected: 2 rows for the Contact "Gavrilo" — one Telegram identity, one email identity, **same contact_id**.

- [ ] **Step 7: Verify kill-switch works**

```bash
flyctl secrets set ENABLE_EMAIL_AUTO=false --app agent-mouth
flyctl deploy --app agent-mouth
```

Send another email. Expected: `messages` row appears, but no agent reply. Then flip back to `true`.

- [ ] **Step 8: Verify webhook JWT rejection**

```bash
curl -X POST https://agent-mouth.fly.dev/email-webhook \
  -H "Authorization: Bearer obviously.fake.jwt" \
  -H "Content-Type: application/json" \
  -d '{"message":{"data":"eyJ4Ijoid"},"subscription":"s"}'
```

Expected: HTTP 401.

- [ ] **Step 9: Verify polling fallback**

In Supabase, temporarily mark the token's last_history_id to a known-old value:

```sql
UPDATE email_oauth_tokens SET last_history_id = '1' WHERE status='active';
```

Wait up to 10 minutes. Logs should show `email.poll.fallback` firing and catching up.

- [ ] **Step 10: Verify watch-renewal cron**

Manually invoke once:

```bash
# From Fly SSH:
flyctl ssh console --app agent-mouth
# Inside:
node -e "/* trigger queue.send('email.watch.renew', {}); */"
# Or wait until the next scheduled fire (05:00 UTC every 6 days)
```

Verify `watch_expiration` in `email_oauth_tokens` advanced ~7 days.

- [ ] **Step 11: Tag and merge**

If all gate steps pass:

```bash
git checkout main
git merge --no-ff feat/phase-1b-email-transport -m "Merge branch 'feat/phase-1b-email-transport' — Phase 1b LIVE"
git push origin main
git tag v0.5.0  # adjust to follow your tagging scheme
git push --tags
```

Update `~/CerebroDigital/02-Proyectos/agent-mouth.md` and `~/CerebroDigital/00-Dashboard.md` with the new "Phase 1 closed (1a + 1b) LIVE" status.

- [ ] **Step 12: Commit gate verification log**

```bash
cat > docs/runbooks/logs/2026-05-25-phase-1b-gate.md <<'EOF'
# Phase 1b Gate Verification

Date: 2026-05-XX
Outcome: PASS ✅

Latency: <Xs from send to webhook log entry
Latency: <Ys from send to reply in personal inbox
Cost: $0.0XX per reply (from audit_log)
Auto-merge: verified
Kill switch: verified
JWT rejection: verified
Polling fallback: verified
Watch renewal: verified
EOF

git add docs/runbooks/logs/2026-05-25-phase-1b-gate.md
git commit -m "ops: Phase 1b Gate verification log (T25)"
```

---

## Final acceptance checklist (entire Phase 1b)

- [ ] All 25 tasks committed
- [ ] `pnpm -r typecheck` clean
- [ ] `pnpm -r test` ≥95% pass (~55 new tests)
- [ ] Migration 0005 applied to Supabase prod
- [ ] OAuth tokens registered + watch active for `gavrilux.agent@gmail.com`
- [ ] Gate 1b end-to-end passed (steps 1-11 above)
- [ ] `feat/phase-1b-email-transport` merged to main
- [ ] CerebroDigital updated (Dashboard + project file)
- [ ] No outstanding error rows in `email_oauth_tokens` after 24h soak

---

## Notes for the executing engineer

- **Test isolation:** every test file uses `vi.fn()` mocks. No test touches real Gmail or Supabase. Integration tests (T20+ smoke) live in the runbook, not in vitest.
- **Encryption key handling:** `AGENT_MOUTH_TOKEN_ENCRYPTION_KEY` must never be logged. The `decryptToken`/`encryptToken` functions take the key as a parameter (not from env directly) so we can stub it in tests. In `serve-http.ts` we read it from env once at boot.
- **Email lowercase:** **every** email comparison must lower-case both sides. The schemas in `core/email.ts` use `z.string().email()` which accepts mixed-case; we apply `.toLowerCase()` at write boundaries (token store, identity resolver, link tool, normalize).
- **Idempotency:** the chain is webhook → `email_webhook_events` UNIQUE → `email.fetch` job singletonKey → `messages` UNIQUE (channel_id, external_id). Triple defense — but each layer alone is sufficient.
- **Phase 2 path unchanged:** Telegram-only deployments must still work. Verify by setting `ENABLE_EMAIL_TRANSPORT=false` and running the existing Phase 2 smoke tests.

---

## Self-review summary (run by plan author)

Coverage: all 12 spec sections map to ≥1 task (§1 goals → T1-T22, §2 decisions → embedded throughout, §3 architecture → T5+T10+T13+T22, §4 flows → T9+T14+T20, §5 components → T1-T18, §6 errors → T9+T13+T15+T20+T21, §7 testing → T1-T22 unit tests + T25 E2E, §8 deploy → T23+T24, §9 cost → no code, §10 effort → 25 tasks ≈ 6-8 days matches spec, §11 out-of-scope → not in plan).

Placeholder scan: clean (no TBD/TODO; one explicit "wired in T22" comment in T13 is a deliberate forward reference, resolved in T22).

Type consistency: `EmailTokenSchema` / `NormalizedEmailSchema` field names match across T2 (defs), T9 (consumer), T14 (consumer), T15 (consumer), T19 (writer), T20 (consumer). `EmailWebhookEventsStore.recordOnce` signature `(email, historyId) → boolean` consistent in T4 (def) and T13 (consumer).

Scope check: this plan covers one cohesive feature (Phase 1b). 25 tasks, ~3 days of subagent dispatch overhead if parallelized correctly per the dependency graph at top.






