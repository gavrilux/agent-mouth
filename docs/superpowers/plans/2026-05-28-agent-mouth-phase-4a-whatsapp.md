# Phase 4a — WhatsApp Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a Meta WhatsApp Cloud API transport so the agent receives and replies to WhatsApp text messages on its own business number, flowing through the same `processInbound` router as Telegram/Email, gated by an env allow-list and an `ENABLE_WHATSAPP_AUTO` kill switch — deployable behind `ENABLE_WHATSAPP_TRANSPORT` (503 when unset, zero impact on existing channels).

**Architecture:** New `@agent-mouth/transport-whatsapp` package implements the existing `Transport` interface: a Zod `WhatsAppWebhookSchema`, `verifyMetaSignature` (constant-time HMAC-SHA256 over the raw body vs `X-Hub-Signature-256`), `whatsappMessageToInbound` (Meta payload → `InboundMessage`), and `WhatsAppTransport.send` (POSTs to Graph API via `fetch`, with optional `context.message_id` threading). `serve-http.ts` gains `GET`+`POST /whatsapp-webhook` (GET handshake echoes the challenge; POST verifies signature → normalize → `processInbound` → enqueue `agent.respond` with `singletonKey=wamid`), bootstraps a `WhatsAppTransport` from env, registers it in `TransportRegistry` as `"whatsapp"`, and bootstraps a `whatsapp` channel row. The router applies the allow-list + kill switch (force `policy="silent"` when the kill switch is off or the sender `wa_id` is not allow-listed). `send_message` gains `"whatsapp"` in its `channel` enum. No new DB migration: inbound dedup reuses `messages` UNIQUE `(channel_id, external_message_id)`.

**Tech Stack:** TypeScript 5.5 · Node 20 · pnpm monorepo · Vitest 2.1 · Zod 3.23 · Meta WhatsApp Cloud API (Graph REST) · HMAC-SHA256 / `timingSafeEqual` (node:crypto) · pg-boss · Fly.io.

**Spec reference:** `docs/superpowers/specs/2026-05-28-agent-mouth-phase-4a-whatsapp-design.md`

---

## Branch strategy

All work happens on `feat/phase-4a-whatsapp` branched from `main` (the spec commit `ee284bb` is already on `main`). Create it before Task 1:

```bash
git checkout -b feat/phase-4a-whatsapp
```

The package and webhook are inert until `ENABLE_WHATSAPP_TRANSPORT=true`, so the branch is mergeable/deployable with zero impact on Telegram/Email. The live Gate 4a + Meta provisioning are DEFERRED (see final note) and are NOT tasks here.

---

## File Structure

### New package `packages/transport-whatsapp/`

| Path | Responsibility |
|---|---|
| `package.json` | Package manifest (`@agent-mouth/transport-whatsapp`), build/test scripts, deps (`@agent-mouth/core`, `zod`). |
| `tsconfig.json` | Extends `../../tsconfig.base.json`, `outDir ./dist`, `rootDir ./src`. |
| `vitest.config.ts` | Vitest config, `include: ["tests/**/*.test.ts"]`, node env. |
| `src/schema.ts` | Zod `WhatsAppWebhookSchema` + `WhatsAppTextMessageSchema` + `WhatsAppValueSchema` for the Meta webhook payload. |
| `src/signature.ts` | `verifyMetaSignature(rawBody, header, appSecret)` — constant-time HMAC-SHA256 vs `X-Hub-Signature-256`. |
| `src/normalize.ts` | `whatsappMessageToInbound(value, msg, channelId)` — Meta value+message → `InboundMessage`. |
| `src/whatsapp-transport.ts` | `WhatsAppTransport implements Transport` (Graph API `send`; `receive`/`waitForMessages` → `[]`). |
| `src/index.ts` | Public exports. |
| `tests/schema.test.ts` | Unit tests for the Zod schema. |
| `tests/signature.test.ts` | Unit tests for signature verification. |
| `tests/normalize.test.ts` | Unit tests for `whatsappMessageToInbound`. |
| `tests/whatsapp-transport.test.ts` | Unit tests for `WhatsAppTransport.send`. |

### Modified files in existing packages

| Path | Change |
|---|---|
| `packages/api/src/tools/messaging.ts` | Add `"whatsapp"` to the `send_message` `channel` enum (JSON schema + Zod parse) and to the inferred-channel guard. |
| `packages/api/src/router.ts` | Add WhatsApp allow-list + `ENABLE_WHATSAPP_AUTO` kill switch (force `silent`) and set `externalChatId = sender_identifier` for whatsapp. |
| `packages/api/src/cli/serve-http.ts` | Bootstrap + register `WhatsAppTransport`, bootstrap `whatsapp` channel row, add `GET`+`POST /whatsapp-webhook`. |

### New test files in existing packages

| Path | Responsibility |
|---|---|
| `packages/api/tests/router-whatsapp-allowlist.test.ts` | Unit tests for the allow-list + kill switch in `processInbound`. |
| `packages/api/tests/send-message-whatsapp.test.ts` | Unit tests for `send_message` routing to the whatsapp transport. |
| `packages/api/tests/whatsapp-flow.test.ts` | Integration (Supabase real, `describe.skipIf`): signed webhook → Contact/Thread/Message persisted + job enqueued; idempotency; non-allow-listed → no job. |

### DB

No new migration. The `whatsapp` channel row is bootstrapped at startup from env (mirroring the email channel bootstrap in `email-setup.ts`). Inbound dedup reuses `messages` UNIQUE `(channel_id, external_message_id)` (migration 0005).

---

## Reference facts (verified against the repo — do not deviate)

- **`InboundMessage` shape** (`packages/core/src/inbound.ts`): fields are `channel_type`, `external_message_id`, `external_thread_id`, `sender_identifier`, `sender_display_name`, `sender_handle` (nullable), `chat_type` (`"private"|"group"|"supergroup"|"channel"`), `content` (min length 1), `attachments` (default `[]`), `raw_payload` (`Record<string,unknown>`), `received_at` (ISO datetime string). All non-optional string fields are `.min(1)`.
- **`Transport` interface** (`packages/core/src/transport.ts`): `init(config)`, `whoami()`, `listContacts()`, `send(opts)`, `receive(opts)`, `waitForMessages(opts)`, `close()`. `listContacts` returns `Contact[]` — but the email transport imports it as `TransportContact` (the `core` index aliases `Contact as TransportContact`). Use `TransportContact`.
- **`SendOptions`**: `{ to?: string; body: string; reply_to_message_id?: string; subject?: string }`.
- **`tsconfig.base.json`** has `noUncheckedIndexedAccess: true` — array indexing yields `T | undefined`, so guard or use `?.`/`??`.
- **Test convention**: each package has a `tests/` directory with `*.test.ts`; vitest config `include: ["tests/**/*.test.ts"]`. Import implementation with the `.js` extension (Node16 module resolution), e.g. `import { x } from "../src/x.js"`.
- **Commit style** (`git log --oneline`): `feat(api): ...`, `test(...): ...`, `docs(...): ...`. Every commit ends with the `Co-Authored-By` trailer below.

The trailer used in every commit in this repo:

```
Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

---

## Task order (bottom-up, each independently testable & committable)

1. Package scaffold (`package.json`, `tsconfig.json`, `vitest.config.ts`).
2. Zod webhook schema (`schema.ts`).
3. Signature verification (`signature.ts`).
4. Normalize (`normalize.ts`).
5. `WhatsAppTransport.send` (`whatsapp-transport.ts`).
6. Package index exports + build (`index.ts`).
7. `send_message` `channel` enum adds `"whatsapp"` (`messaging.ts`).
8. Router allow-list + kill switch (`router.ts`).
9. `GET`+`POST /whatsapp-webhook` + bootstrap/register transport + channel row (`serve-http.ts`).
10. Integration tests (Supabase real, `whatsapp-flow.test.ts`).

---

### Task 1: Package scaffold

**Files:**
- Create: `packages/transport-whatsapp/package.json`
- Create: `packages/transport-whatsapp/tsconfig.json`
- Create: `packages/transport-whatsapp/vitest.config.ts`
- Create: `packages/transport-whatsapp/tests/scaffold.test.ts` (temporary smoke test, deleted in Task 6)

- [ ] **Step 1: Write the failing test**

`packages/transport-whatsapp/tests/scaffold.test.ts`:
```ts
import { describe, expect, it } from "vitest";

describe("transport-whatsapp scaffold", () => {
  it("vitest runs in this package", () => {
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: FAIL — pnpm errors with "No projects matched the filters" / "command \"test\" not found" because `packages/transport-whatsapp/package.json` does not exist yet.

- [ ] **Step 3: Write minimal implementation**

`packages/transport-whatsapp/package.json`:
```json
{
  "name": "@agent-mouth/transport-whatsapp",
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
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "typescript": "5.5.4",
    "vitest": "^2.1.0"
  }
}
```

`packages/transport-whatsapp/tsconfig.json`:
```json
{
  "extends": "../../tsconfig.base.json",
  "compilerOptions": {
    "outDir": "./dist",
    "rootDir": "./src"
  },
  "include": ["src/**/*"],
  "exclude": ["dist", "node_modules", "tests"]
}
```

`packages/transport-whatsapp/vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
  },
});
```

Then install so pnpm links the new workspace package:
```bash
pnpm install
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: PASS (1 test, `scaffold.test.ts`).

- [ ] **Step 5: Commit**
```bash
git add packages/transport-whatsapp/package.json packages/transport-whatsapp/tsconfig.json packages/transport-whatsapp/vitest.config.ts packages/transport-whatsapp/tests/scaffold.test.ts pnpm-lock.yaml && git commit -m "$(cat <<'EOF'
feat(transport-whatsapp): scaffold package (pkg/tsconfig/vitest)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Zod webhook schema

**Files:**
- Create: `packages/transport-whatsapp/src/schema.ts`
- Test: `packages/transport-whatsapp/tests/schema.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/transport-whatsapp/tests/schema.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { WhatsAppWebhookSchema, WhatsAppTextMessageSchema } from "../src/schema.js";

const textWebhook = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: "PNID", display_phone_number: "34999999999" },
            contacts: [{ profile: { name: "Marco" }, wa_id: "34611111111" }],
            messages: [
              { from: "34611111111", id: "wamid.ABC", timestamp: "1716638400", type: "text", text: { body: "hola" } },
            ],
          },
        },
      ],
    },
  ],
};

const statusWebhook = {
  object: "whatsapp_business_account",
  entry: [
    {
      id: "WABA_ID",
      changes: [
        {
          field: "messages",
          value: {
            messaging_product: "whatsapp",
            metadata: { phone_number_id: "PNID" },
            statuses: [{ id: "wamid.XYZ", status: "delivered" }],
          },
        },
      ],
    },
  ],
};

describe("WhatsAppWebhookSchema", () => {
  it("parses a valid text-message webhook", () => {
    const parsed = WhatsAppWebhookSchema.safeParse(textWebhook);
    expect(parsed.success).toBe(true);
  });

  it("parses a status-only event (no messages)", () => {
    const parsed = WhatsAppWebhookSchema.safeParse(statusWebhook);
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      const value = parsed.data.entry[0]!.changes[0]!.value;
      expect(value.messages).toBeUndefined();
      expect(value.statuses).toBeDefined();
    }
  });

  it("rejects a malformed payload (wrong object)", () => {
    const parsed = WhatsAppWebhookSchema.safeParse({ object: "page", entry: [] });
    expect(parsed.success).toBe(false);
  });
});

describe("WhatsAppTextMessageSchema", () => {
  it("recognizes a text message", () => {
    const msg = { from: "34611111111", id: "wamid.ABC", timestamp: "1716638400", type: "text", text: { body: "hi" } };
    expect(WhatsAppTextMessageSchema.safeParse(msg).success).toBe(true);
  });

  it("rejects a non-text message (image)", () => {
    const msg = { from: "34611111111", id: "wamid.IMG", timestamp: "1716638400", type: "image", image: { id: "media1" } };
    expect(WhatsAppTextMessageSchema.safeParse(msg).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: FAIL — cannot resolve `../src/schema.js` ("Failed to load url ../src/schema.js" / module not found).

- [ ] **Step 3: Write minimal implementation**

`packages/transport-whatsapp/src/schema.ts`:
```ts
// packages/transport-whatsapp/src/schema.ts
import { z } from "zod";

/** A single inbound WhatsApp text message (type === "text"). Non-text messages fail this guard. */
export const WhatsAppTextMessageSchema = z.object({
  from: z.string(), // wa_id of sender (digits)
  id: z.string(), // wamid
  timestamp: z.string(), // unix seconds as string
  type: z.literal("text"),
  text: z.object({ body: z.string() }),
});
export type WhatsAppTextMessage = z.infer<typeof WhatsAppTextMessageSchema>;

/** The `value` object inside a `changes[]` entry. */
export const WhatsAppValueSchema = z.object({
  messaging_product: z.literal("whatsapp"),
  metadata: z.object({
    phone_number_id: z.string(),
    display_phone_number: z.string().optional(),
  }),
  contacts: z
    .array(
      z.object({
        profile: z.object({ name: z.string() }).optional(),
        wa_id: z.string(),
      }),
    )
    .optional(),
  // Narrowed to text via WhatsAppTextMessageSchema in normalize.
  messages: z.array(z.unknown()).optional(),
  // Presence => delivery/read receipt event; skipped by the handler.
  statuses: z.array(z.unknown()).optional(),
});
export type WhatsAppValue = z.infer<typeof WhatsAppValueSchema>;

export const WhatsAppWebhookSchema = z.object({
  object: z.literal("whatsapp_business_account"),
  entry: z.array(
    z.object({
      id: z.string(),
      changes: z.array(z.object({ field: z.string(), value: WhatsAppValueSchema })),
    }),
  ),
});
export type WhatsAppWebhook = z.infer<typeof WhatsAppWebhookSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: PASS (scaffold test + 5 schema tests).

- [ ] **Step 5: Commit**
```bash
git add packages/transport-whatsapp/src/schema.ts packages/transport-whatsapp/tests/schema.test.ts && git commit -m "$(cat <<'EOF'
feat(transport-whatsapp): Zod schema for Meta webhook payload

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 3: Signature verification

**Files:**
- Create: `packages/transport-whatsapp/src/signature.ts`
- Test: `packages/transport-whatsapp/tests/signature.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/transport-whatsapp/tests/signature.test.ts`:
```ts
import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifyMetaSignature } from "../src/signature.js";

const APP_SECRET = "test_app_secret";
const rawBody = '{"object":"whatsapp_business_account","entry":[]}';

function sign(body: string, secret: string): string {
  return `sha256=${createHmac("sha256", secret).update(body, "utf8").digest("hex")}`;
}

describe("verifyMetaSignature", () => {
  it("accepts a valid signature", () => {
    const header = sign(rawBody, APP_SECRET);
    expect(verifyMetaSignature(rawBody, header, APP_SECRET)).toBe(true);
  });

  it("rejects a signature made with the wrong secret", () => {
    const header = sign(rawBody, "wrong_secret");
    expect(verifyMetaSignature(rawBody, header, APP_SECRET)).toBe(false);
  });

  it("rejects when the body was tampered with", () => {
    const header = sign(rawBody, APP_SECRET);
    expect(verifyMetaSignature(rawBody + "x", header, APP_SECRET)).toBe(false);
  });

  it("rejects a missing or malformed header", () => {
    expect(verifyMetaSignature(rawBody, undefined, APP_SECRET)).toBe(false);
    expect(verifyMetaSignature(rawBody, "garbage", APP_SECRET)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: FAIL — cannot resolve `../src/signature.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/transport-whatsapp/src/signature.ts`:
```ts
// packages/transport-whatsapp/src/signature.ts
import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Verify Meta's `X-Hub-Signature-256` header against the raw request body.
 * Meta sends `sha256=<hex>` where the hex is HMAC-SHA256(rawBody, appSecret).
 * Comparison is constant-time. Returns false (never throws) on any mismatch
 * or malformed/missing header so the caller can respond 403.
 */
export function verifyMetaSignature(
  rawBody: string,
  signatureHeader: string | undefined | null,
  appSecret: string,
): boolean {
  if (!signatureHeader || !signatureHeader.startsWith("sha256=")) return false;
  const provided = signatureHeader.slice("sha256=".length);
  const expected = createHmac("sha256", appSecret).update(rawBody, "utf8").digest("hex");
  const providedBuf = Buffer.from(provided, "hex");
  const expectedBuf = Buffer.from(expected, "hex");
  // timingSafeEqual throws if lengths differ; guard first.
  if (providedBuf.length !== expectedBuf.length) return false;
  return timingSafeEqual(providedBuf, expectedBuf);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: PASS (schema tests + 4 signature tests).

- [ ] **Step 5: Commit**
```bash
git add packages/transport-whatsapp/src/signature.ts packages/transport-whatsapp/tests/signature.test.ts && git commit -m "$(cat <<'EOF'
feat(transport-whatsapp): verifyMetaSignature (X-Hub-Signature-256, constant-time HMAC)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Normalize (Meta payload → InboundMessage)

**Files:**
- Create: `packages/transport-whatsapp/src/normalize.ts`
- Test: `packages/transport-whatsapp/tests/normalize.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/transport-whatsapp/tests/normalize.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { whatsappMessageToInbound } from "../src/normalize.js";

function value(overrides: Record<string, unknown> = {}) {
  return {
    messaging_product: "whatsapp",
    metadata: { phone_number_id: "PNID", display_phone_number: "34999999999" },
    contacts: [{ profile: { name: "Marco" }, wa_id: "34611111111" }],
    messages: [
      { from: "34611111111", id: "wamid.ABC", timestamp: "1716638400", type: "text", text: { body: "hola" } },
    ],
    ...overrides,
  };
}

describe("whatsappMessageToInbound", () => {
  it("normalizes a single text message into one InboundMessage", () => {
    const v = value();
    const out = whatsappMessageToInbound(v, "ch-whatsapp-uuid");
    expect(out).toHaveLength(1);
    const m = out[0]!;
    expect(m.channel_type).toBe("whatsapp");
    expect(m.external_message_id).toBe("wamid.ABC");
    expect(m.external_thread_id).toBe("34611111111");
    expect(m.sender_identifier).toBe("34611111111");
    expect(m.sender_display_name).toBe("Marco");
    expect(m.sender_handle).toBeNull();
    expect(m.chat_type).toBe("private");
    expect(m.content).toBe("hola");
    expect(m.attachments).toEqual([]);
    expect(m.received_at).toBe(new Date(1716638400 * 1000).toISOString());
  });

  it("normalizes multiple text messages in one payload", () => {
    const v = value({
      messages: [
        { from: "34611111111", id: "wamid.A", timestamp: "1716638400", type: "text", text: { body: "uno" } },
        { from: "34611111111", id: "wamid.B", timestamp: "1716638401", type: "text", text: { body: "dos" } },
      ],
    });
    const out = whatsappMessageToInbound(v, "ch");
    expect(out.map((m) => m.external_message_id)).toEqual(["wamid.A", "wamid.B"]);
    expect(out.map((m) => m.content)).toEqual(["uno", "dos"]);
  });

  it("returns [] for a status-only event (no messages)", () => {
    const v = value({ messages: undefined, statuses: [{ id: "wamid.S", status: "read" }] });
    expect(whatsappMessageToInbound(v, "ch")).toEqual([]);
  });

  it("skips non-text messages (image)", () => {
    const v = value({
      messages: [
        { from: "34611111111", id: "wamid.IMG", timestamp: "1716638400", type: "image", image: { id: "media1" } },
        { from: "34611111111", id: "wamid.TXT", timestamp: "1716638401", type: "text", text: { body: "ok" } },
      ],
    });
    const out = whatsappMessageToInbound(v, "ch");
    expect(out).toHaveLength(1);
    expect(out[0]!.external_message_id).toBe("wamid.TXT");
  });

  it("tolerates a missing contact name (falls back to wa_id)", () => {
    const v = value({ contacts: [{ wa_id: "34611111111" }] });
    const out = whatsappMessageToInbound(v, "ch");
    expect(out[0]!.sender_display_name).toBe("34611111111");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: FAIL — cannot resolve `../src/normalize.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/transport-whatsapp/src/normalize.ts`:
```ts
// packages/transport-whatsapp/src/normalize.ts
import type { InboundMessage } from "@agent-mouth/core";
import { WhatsAppTextMessageSchema, WhatsAppValueSchema } from "./schema.js";

/**
 * Convert a Meta webhook `value` object into zero or more InboundMessage rows.
 * - Returns [] for status/receipt events (value has `statuses` and/or no `messages`).
 * - Each entry in `messages[]` is validated against WhatsAppTextMessageSchema;
 *   non-text messages (image/audio/...) are skipped (out of scope v1).
 * The contact display name comes from contacts[0].profile.name, falling back to
 * the message sender's wa_id when absent.
 */
export function whatsappMessageToInbound(
  value: unknown,
  channelId: string,
): InboundMessage[] {
  const parsedValue = WhatsAppValueSchema.safeParse(value);
  if (!parsedValue.success) return [];
  const v = parsedValue.data;
  if (!v.messages || v.messages.length === 0) return [];

  const contactName = v.contacts?.[0]?.profile?.name ?? null;

  const out: InboundMessage[] = [];
  for (const raw of v.messages) {
    const msg = WhatsAppTextMessageSchema.safeParse(raw);
    if (!msg.success) continue; // skip non-text
    const m = msg.data;
    out.push({
      channel_type: "whatsapp",
      external_message_id: m.id, // wamid
      external_thread_id: m.from, // wa_id — one thread per sender
      sender_identifier: m.from, // wa_id
      sender_display_name: contactName ?? m.from,
      sender_handle: null,
      chat_type: "private",
      content: m.text.body,
      attachments: [],
      raw_payload: {
        whatsapp: raw as Record<string, unknown>,
        channel_id: channelId,
        metadata: v.metadata as unknown as Record<string, unknown>,
      },
      received_at: new Date(Number(m.timestamp) * 1000).toISOString(),
    });
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: PASS (schema + signature tests + 5 normalize tests).

- [ ] **Step 5: Commit**
```bash
git add packages/transport-whatsapp/src/normalize.ts packages/transport-whatsapp/tests/normalize.test.ts && git commit -m "$(cat <<'EOF'
feat(transport-whatsapp): whatsappMessageToInbound normalize

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 5: WhatsAppTransport.send (Graph API)

**Files:**
- Create: `packages/transport-whatsapp/src/whatsapp-transport.ts`
- Test: `packages/transport-whatsapp/tests/whatsapp-transport.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/transport-whatsapp/tests/whatsapp-transport.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { WhatsAppTransport } from "../src/whatsapp-transport.js";

const cfg = {
  phone_number_id: "PNID",
  access_token: "TOKEN",
  graph_version: "v21.0",
  display_phone_number: "34999999999",
};

function okFetch(json: unknown) {
  return vi.fn(async () => ({
    ok: true,
    status: 200,
    json: async () => json,
    text: async () => JSON.stringify(json),
  })) as unknown as typeof fetch;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("WhatsAppTransport.send", () => {
  it("POSTs a correct Graph API text body and maps the response wamid", async () => {
    const fetchMock = okFetch({ messages: [{ id: "wamid.OUT" }] });
    vi.stubGlobal("fetch", fetchMock);
    const t = new WhatsAppTransport(cfg);
    const r = await t.send({ to: "34611111111", body: "hola" });
    expect(r.message_id).toBe("wamid.OUT");
    expect(r.timestamp).toBeInstanceOf(Date);

    const [url, init] = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe("https://graph.facebook.com/v21.0/PNID/messages");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer TOKEN");
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: "34611111111",
      type: "text",
      text: { preview_url: false, body: "hola" },
    });
  });

  it("adds context.message_id when reply_to_message_id is set", async () => {
    const fetchMock = okFetch({ messages: [{ id: "wamid.OUT" }] });
    vi.stubGlobal("fetch", fetchMock);
    const t = new WhatsAppTransport(cfg);
    await t.send({ to: "34611111111", body: "re", reply_to_message_id: "wamid.IN" });
    const init = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    const sent = JSON.parse(init.body as string);
    expect(sent.context).toEqual({ message_id: "wamid.IN" });
  });

  it("omits context when reply_to_message_id is absent", async () => {
    const fetchMock = okFetch({ messages: [{ id: "wamid.OUT" }] });
    vi.stubGlobal("fetch", fetchMock);
    const t = new WhatsAppTransport(cfg);
    await t.send({ to: "34611111111", body: "no-reply" });
    const init = (fetchMock as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]![1];
    const sent = JSON.parse(init.body as string);
    expect(sent.context).toBeUndefined();
  });

  it("throws when `to` is missing", async () => {
    const t = new WhatsAppTransport(cfg);
    await expect(t.send({ body: "x" } as never)).rejects.toThrow(/to.+required/i);
  });

  it("throws on a non-200 Graph response", async () => {
    const fetchMock = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
      text: async () => "invalid token",
    })) as unknown as typeof fetch;
    vi.stubGlobal("fetch", fetchMock);
    const t = new WhatsAppTransport(cfg);
    await expect(t.send({ to: "34611111111", body: "x" })).rejects.toThrow(/401/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: FAIL — cannot resolve `../src/whatsapp-transport.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/transport-whatsapp/src/whatsapp-transport.ts`:
```ts
// packages/transport-whatsapp/src/whatsapp-transport.ts
import type {
  Identity,
  ReceiveOptions,
  ReceivedMessage,
  SendOptions,
  SentMessage,
  Transport,
  TransportConfig,
  TransportContact,
  WaitOptions,
} from "@agent-mouth/core";

export interface WhatsAppConfig {
  phone_number_id: string;
  access_token: string; // permanent System User token (Fly secret)
  graph_version?: string; // default "v21.0"
  display_phone_number?: string;
}

const DEFAULT_GRAPH_VERSION = "v21.0";

/**
 * WhatsAppTransport bridges the Phase 0 `Transport` interface to the Meta
 * WhatsApp Cloud API (Graph). Text-only, reactive.
 *
 * receive() and waitForMessages() return [] because WhatsApp ingress happens
 * via the /whatsapp-webhook handler (Meta pushes the message body); the agent
 * reads cross-channel history from MessageStore.
 */
export class WhatsAppTransport implements Transport {
  constructor(private readonly cfg: WhatsAppConfig) {}

  async init(_config: TransportConfig): Promise<void> {
    // No-op: config injected at construction.
  }

  async whoami(): Promise<Identity> {
    const handle = this.cfg.display_phone_number ?? this.cfg.phone_number_id;
    return { handle, display_name: "WhatsApp Business", chat_id: handle };
  }

  async listContacts(): Promise<TransportContact[]> {
    return [];
  }

  async send(opts: SendOptions): Promise<SentMessage> {
    if (!opts.to) throw new Error("WhatsAppTransport.send: `to` (wa_id) is required");
    const body: Record<string, unknown> = {
      messaging_product: "whatsapp",
      recipient_type: "individual",
      to: opts.to,
      type: "text",
      text: { preview_url: false, body: opts.body },
    };
    if (opts.reply_to_message_id) {
      body.context = { message_id: opts.reply_to_message_id };
    }
    const version = this.cfg.graph_version ?? DEFAULT_GRAPH_VERSION;
    const res = await fetch(
      `https://graph.facebook.com/${version}/${this.cfg.phone_number_id}/messages`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.access_token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      },
    );
    if (!res.ok) {
      throw new Error(`WhatsApp send failed ${res.status}: ${await res.text()}`);
    }
    const json = (await res.json()) as { messages?: { id: string }[] };
    return { message_id: json.messages?.[0]?.id ?? "", timestamp: new Date() };
  }

  async receive(_opts: ReceiveOptions): Promise<ReceivedMessage[]> {
    return [];
  }

  async waitForMessages(_opts: WaitOptions): Promise<ReceivedMessage[]> {
    return [];
  }

  async close(): Promise<void> {
    // No persistent state to release.
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: PASS (all prior tests + 5 transport tests).

- [ ] **Step 5: Commit**
```bash
git add packages/transport-whatsapp/src/whatsapp-transport.ts packages/transport-whatsapp/tests/whatsapp-transport.test.ts && git commit -m "$(cat <<'EOF'
feat(transport-whatsapp): WhatsAppTransport.send via Graph API

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Package index exports + build

**Files:**
- Create: `packages/transport-whatsapp/src/index.ts`
- Test: `packages/transport-whatsapp/tests/index.test.ts`
- Delete: `packages/transport-whatsapp/tests/scaffold.test.ts`

- [ ] **Step 1: Write the failing test**

`packages/transport-whatsapp/tests/index.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import * as wa from "../src/index.js";

describe("transport-whatsapp public exports", () => {
  it("exports the transport, normalize, signature and schema", () => {
    expect(typeof wa.WhatsAppTransport).toBe("function");
    expect(typeof wa.whatsappMessageToInbound).toBe("function");
    expect(typeof wa.verifyMetaSignature).toBe("function");
    expect(wa.WhatsAppWebhookSchema).toBeDefined();
    expect(wa.WhatsAppTextMessageSchema).toBeDefined();
  });
});
```

Also delete the temporary scaffold smoke test:
```bash
rm packages/transport-whatsapp/tests/scaffold.test.ts
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: FAIL — cannot resolve `../src/index.js`.

- [ ] **Step 3: Write minimal implementation**

`packages/transport-whatsapp/src/index.ts`:
```ts
export { WhatsAppTransport } from "./whatsapp-transport.js";
export type { WhatsAppConfig } from "./whatsapp-transport.js";
export { whatsappMessageToInbound } from "./normalize.js";
export { verifyMetaSignature } from "./signature.js";
export {
  WhatsAppWebhookSchema,
  WhatsAppValueSchema,
  WhatsAppTextMessageSchema,
} from "./schema.js";
export type {
  WhatsAppWebhook,
  WhatsAppValue,
  WhatsAppTextMessage,
} from "./schema.js";
```

- [ ] **Step 4: Run test to verify it passes, then typecheck/build**

Run: `pnpm --filter @agent-mouth/transport-whatsapp test`
Expected: PASS (index test + schema/signature/normalize/transport tests; scaffold test gone).

Run: `pnpm --filter @agent-mouth/transport-whatsapp build`
Expected: PASS — `tsc` emits `dist/` with no type errors.

- [ ] **Step 5: Commit**
```bash
git add packages/transport-whatsapp/src/index.ts packages/transport-whatsapp/tests/index.test.ts && git rm packages/transport-whatsapp/tests/scaffold.test.ts && git commit -m "$(cat <<'EOF'
feat(transport-whatsapp): public index exports + drop scaffold test

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: send_message — add "whatsapp" to the channel enum

**Files:**
- Modify: `packages/api/src/tools/messaging.ts:16` (JSON schema enum), `:28` (Zod enum), `:41` (inferred-channel guard)
- Test: `packages/api/tests/send-message-whatsapp.test.ts`

The current code (verbatim) to change:
- `packages/api/src/tools/messaging.ts:16`:
  ```ts
        channel: { type: "string", enum: ["telegram", "email"] },
  ```
- `packages/api/src/tools/messaging.ts:28`:
  ```ts
        channel: z.enum(["telegram", "email"]).optional(),
  ```
- `packages/api/src/tools/messaging.ts:41` (inside the inferred-channel block):
  ```ts
          if (ch && (ch.type === "telegram" || ch.type === "email")) {
  ```

- [ ] **Step 1: Write the failing test**

`packages/api/tests/send-message-whatsapp.test.ts`:
```ts
import { describe, expect, it, vi } from "vitest";
import { sendMessageTool } from "../src/tools/messaging.js";

function makeFakeTransport() {
  return { send: vi.fn(async () => ({ message_id: "x", timestamp: new Date() })) };
}

describe("send_message tool with channel='whatsapp'", () => {
  it("routes to the whatsapp transport when channel='whatsapp'", async () => {
    const tgTransport = makeFakeTransport();
    const waTransport = makeFakeTransport();
    const registry = {
      get: (type: "telegram" | "email" | "whatsapp") => (type === "whatsapp" ? waTransport : tgTransport),
    };

    await sendMessageTool.handler(
      { body: "hola", channel: "whatsapp", to: "34611111111" },
      { transport: tgTransport as never, transportRegistry: registry as never } as never,
    );
    expect(waTransport.send).toHaveBeenCalledWith(
      expect.objectContaining({ to: "34611111111", body: "hola" }),
    );
    expect(tgTransport.send).not.toHaveBeenCalled();
  });

  it("infers whatsapp from the reply_to thread's channel", async () => {
    const tgTransport = makeFakeTransport();
    const waTransport = makeFakeTransport();
    const registry = {
      get: (type: "telegram" | "email" | "whatsapp") => (type === "whatsapp" ? waTransport : tgTransport),
    };
    const threadStore = { findById: vi.fn(async () => ({ id: "th1", channel_id: "ch1" })) };
    const channelStore = { findById: vi.fn(async () => ({ id: "ch1", type: "whatsapp" as const })) };

    await sendMessageTool.handler(
      { body: "hola", to: "34611111111", reply_to_message_id: "th1" },
      {
        transport: tgTransport as never,
        transportRegistry: registry as never,
        threadStore: threadStore as never,
        channelStore: channelStore as never,
      } as never,
    );
    expect(waTransport.send).toHaveBeenCalled();
    expect(tgTransport.send).not.toHaveBeenCalled();
  });

  it("ignores `subject` for whatsapp (passes it through harmlessly)", async () => {
    const tgTransport = makeFakeTransport();
    const waTransport = makeFakeTransport();
    const registry = {
      get: (type: "telegram" | "email" | "whatsapp") => (type === "whatsapp" ? waTransport : tgTransport),
    };

    await sendMessageTool.handler(
      { body: "hola", channel: "whatsapp", to: "34611111111", subject: "ignored" },
      { transport: tgTransport as never, transportRegistry: registry as never } as never,
    );
    // The transport receives subject but WhatsAppTransport.send ignores it; the tool must still route correctly.
    expect(waTransport.send).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/api test -- send-message-whatsapp`
Expected: FAIL — the Zod `.parse` in the handler throws `ZodError` ("Invalid enum value... received 'whatsapp'") because `channel: z.enum(["telegram", "email"])` rejects `"whatsapp"`, so `waTransport.send` is never called.

- [ ] **Step 3: Write minimal implementation**

Edit `packages/api/src/tools/messaging.ts:16` from:
```ts
      channel: { type: "string", enum: ["telegram", "email"] },
```
to:
```ts
      channel: { type: "string", enum: ["telegram", "email", "whatsapp"] },
```

Edit `packages/api/src/tools/messaging.ts:28` from:
```ts
        channel: z.enum(["telegram", "email"]).optional(),
```
to:
```ts
        channel: z.enum(["telegram", "email", "whatsapp"]).optional(),
```

Edit the inferred-channel guard at `packages/api/src/tools/messaging.ts:41` from:
```ts
          if (ch && (ch.type === "telegram" || ch.type === "email")) {
```
to:
```ts
          if (ch && (ch.type === "telegram" || ch.type === "email" || ch.type === "whatsapp")) {
```

Also update the tool `description` (line 9-10) to mention WhatsApp. Change:
```ts
    "Send a message. For Telegram: `to` is a numeric chat id or handle. For Email: `to` is an email address; `subject` should be provided for new threads. If `channel` is omitted, the tool infers it from `reply_to_message_id`'s thread, falling back to the default transport.",
```
to:
```ts
    "Send a message. For Telegram: `to` is a numeric chat id or handle. For Email: `to` is an email address; `subject` should be provided for new threads. For WhatsApp: `to` is the recipient `wa_id` (digits, no '+'); `subject` is ignored. If `channel` is omitted, the tool infers it from `reply_to_message_id`'s thread, falling back to the default transport.",
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-mouth/api test -- send-message-whatsapp`
Expected: PASS (3 tests).

Then confirm the existing channel test still passes:
Run: `pnpm --filter @agent-mouth/api test -- send-message-channel`
Expected: PASS (4 tests, unchanged).

- [ ] **Step 5: Commit**
```bash
git add packages/api/src/tools/messaging.ts packages/api/tests/send-message-whatsapp.test.ts && git commit -m "$(cat <<'EOF'
feat(api): send_message accepts channel="whatsapp"

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 8: Router — WhatsApp allow-list + ENABLE_WHATSAPP_AUTO kill switch

**Files:**
- Modify: `packages/api/src/router.ts:65-71` (extend the kill-switch block), `:96` (externalChatId for whatsapp)
- Test: `packages/api/tests/router-whatsapp-allowlist.test.ts`

Current code (verbatim) at `packages/api/src/router.ts:65-71`:
```ts
  // Phase 1b kill switch: ENABLE_EMAIL_AUTO=false forces email policy to silent.
  // Read env on every call (no caching) so flipping the var is effective once
  // the env update lands in the process.
  let effectivePolicyAction = policy.policy;
  if (msg.channel_type === "email" && process.env.ENABLE_EMAIL_AUTO === "false") {
    effectivePolicyAction = "silent";
  }
```

Current code (verbatim) at `packages/api/src/router.ts:94-96`:
```ts
    // Phase 1b: for email, the reply target is the SENDER's address.
    // For Telegram, external_thread_id == chat_id (where to send).
    externalChatId: msg.channel_type === "email" ? msg.sender_identifier : msg.external_thread_id,
```

- [ ] **Step 1: Write the failing test**

`packages/api/tests/router-whatsapp-allowlist.test.ts`:
```ts
import { afterEach, describe, expect, it, vi } from "vitest";
import { processInbound, type RouterDeps } from "../src/router.js";

const inboundWhatsapp = {
  channel_type: "whatsapp" as const,
  external_message_id: "wamid.ABC",
  external_thread_id: "34611111111",
  sender_identifier: "34611111111",
  sender_display_name: "Marco",
  sender_handle: null,
  chat_type: "private" as const,
  content: "hola",
  attachments: [],
  raw_payload: {},
  received_at: "2026-05-28T10:00:00.000Z",
};

function makeDeps(): RouterDeps {
  return {
    workspaceId: "ws1",
    bridgeForwardChats: new Set(),
    bridgeForwardUrl: null,
    identityResolver: {
      resolveOrCreate: vi.fn(async () => ({
        contact: { id: "c1", workspace_id: "ws1", display_name: "Marco", notes: "", metadata: {}, created_at: "2026-05-28T00:00:00.000Z" },
        channel: { id: "ch1", workspace_id: "ws1", type: "whatsapp", config: {}, status: "active", created_at: "2026-05-28T00:00:00.000Z" },
        channel_identity: { id: "ci1", contact_id: "c1", channel_id: "ch1", identifier: "34611111111", verified: false },
        created: false,
      })),
    } as never,
    threadStore: {
      resolveOrCreate: vi.fn(async () => ({ id: "th1", workspace_id: "ws1", contact_id: "c1", channel_id: "ch1", external_thread_id: "34611111111", related_thread_ids: [], last_message_at: null, closed: false, notes_last_updated_at: null, created_at: "2026-05-28T00:00:00.000Z" })),
    } as never,
    policyEngine: {
      evaluate: vi.fn(async () => ({
        id: "p1", workspace_id: "ws1", contact_id: null, channel_type: null,
        policy: "auto", system_prompt: "", rules: {}, priority: 0,
        created_at: "2026-05-28T00:00:00.000Z", model_id: null,
        rate_limit_per_hour: 30, max_tokens_out: 8000, max_tool_calls: 10,
        forbidden_topics_regex: [], escalate_triggers_regex: [],
        allowed_tools: '["*"]',
      })),
    } as never,
    messageStore: { insert: vi.fn(async () => ({ id: "msg-uuid" })) } as never,
    forwarder: vi.fn(),
  };
}

describe("router WhatsApp allow-list + kill switch", () => {
  const origAuto = process.env.ENABLE_WHATSAPP_AUTO;
  const origList = process.env.WHATSAPP_ALLOWLIST;
  afterEach(() => {
    process.env.ENABLE_WHATSAPP_AUTO = origAuto;
    process.env.WHATSAPP_ALLOWLIST = origList;
  });

  it("allow-listed sender keeps policy=auto and externalChatId=wa_id", async () => {
    process.env.ENABLE_WHATSAPP_AUTO = "true";
    process.env.WHATSAPP_ALLOWLIST = "+34 611 111 111, 34622222222";
    const result = await processInbound(inboundWhatsapp, makeDeps());
    if (result.kind !== "persisted") throw new Error(`expected persisted, got ${result.kind}`);
    expect(result.policy).toBe("auto");
    expect(result.externalChatId).toBe("34611111111");
  });

  it("non-allow-listed sender → policy=silent", async () => {
    process.env.ENABLE_WHATSAPP_AUTO = "true";
    process.env.WHATSAPP_ALLOWLIST = "34999999999";
    const result = await processInbound(inboundWhatsapp, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("silent");
  });

  it("ENABLE_WHATSAPP_AUTO=false → policy=silent even if allow-listed", async () => {
    process.env.ENABLE_WHATSAPP_AUTO = "false";
    process.env.WHATSAPP_ALLOWLIST = "34611111111";
    const result = await processInbound(inboundWhatsapp, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("silent");
  });

  it("empty allow-list → all whatsapp senders silent", async () => {
    process.env.ENABLE_WHATSAPP_AUTO = "true";
    process.env.WHATSAPP_ALLOWLIST = "";
    const result = await processInbound(inboundWhatsapp, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("silent");
  });

  it("does not affect non-whatsapp channels", async () => {
    process.env.ENABLE_WHATSAPP_AUTO = "false";
    process.env.WHATSAPP_ALLOWLIST = "";
    const telegramInbound = { ...inboundWhatsapp, channel_type: "telegram" as const };
    const result = await processInbound(telegramInbound, makeDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("auto");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/api test -- router-whatsapp-allowlist`
Expected: FAIL — the "non-allow-listed sender → policy=silent", "ENABLE_WHATSAPP_AUTO=false → silent", and "empty allow-list" cases all assert `silent` but the router currently returns `auto` for whatsapp (no gate exists yet).

- [ ] **Step 3: Write minimal implementation**

Replace `packages/api/src/router.ts:65-71` (the existing kill-switch block) with:
```ts
  // Phase 1b kill switch: ENABLE_EMAIL_AUTO=false forces email policy to silent.
  // Read env on every call (no caching) so flipping the var is effective once
  // the env update lands in the process.
  let effectivePolicyAction = policy.policy;
  if (msg.channel_type === "email" && process.env.ENABLE_EMAIL_AUTO === "false") {
    effectivePolicyAction = "silent";
  }

  // Phase 4a WhatsApp cost/safety gate (read per-call, no caching):
  //   - ENABLE_WHATSAPP_AUTO=false                         → silent
  //   - sender wa_id NOT in WHATSAPP_ALLOWLIST (digits)    → silent
  // Both the inbound sender and each allow-list entry are normalized to
  // digits-only before comparison (so "+34 611..." matches "34611...").
  if (msg.channel_type === "whatsapp") {
    if (process.env.ENABLE_WHATSAPP_AUTO === "false") {
      effectivePolicyAction = "silent";
    } else {
      const toDigits = (s: string) => s.replace(/\D/g, "");
      const allowlist = new Set(
        (process.env.WHATSAPP_ALLOWLIST ?? "")
          .split(",")
          .map((s) => toDigits(s))
          .filter((s) => s.length > 0),
      );
      if (!allowlist.has(toDigits(msg.sender_identifier))) {
        effectivePolicyAction = "silent";
      }
    }
  }
```

Replace `packages/api/src/router.ts:94-96` (the `externalChatId` line + its comment) with:
```ts
    // Phase 1b: for email, the reply target is the SENDER's address.
    // Phase 4a: for WhatsApp, the reply target is the SENDER's wa_id.
    // For Telegram, external_thread_id == chat_id (where to send).
    externalChatId:
      msg.channel_type === "email" || msg.channel_type === "whatsapp"
        ? msg.sender_identifier
        : msg.external_thread_id,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @agent-mouth/api test -- router-whatsapp-allowlist`
Expected: PASS (5 tests).

Then confirm the email kill switch is unaffected:
Run: `pnpm --filter @agent-mouth/api test -- router-email-kill-switch`
Expected: PASS (4 tests, unchanged).

- [ ] **Step 5: Commit**
```bash
git add packages/api/src/router.ts packages/api/tests/router-whatsapp-allowlist.test.ts && git commit -m "$(cat <<'EOF'
feat(api): WhatsApp allow-list + ENABLE_WHATSAPP_AUTO kill switch at router

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 9: serve-http — GET+POST /whatsapp-webhook + bootstrap/register transport + channel row

This task wires the transport into the HTTP server. Because `serveHttp()` boots Supabase/worker and is not unit-tested directly (no `serve-http.test.ts` exists), verification is by `tsc` typecheck/build of `@agent-mouth/api`. Behavior is covered end-to-end by the integration test in Task 10.

**Files:**
- Modify: `packages/api/src/cli/serve-http.ts` — imports (`:21-25` area), bootstrap block (after the email bootstrap, before `const databaseUrl`), and the request handler (add routes after the `/email-webhook` block at `:319-326`).

- [ ] **Step 1: Write the failing test**

Add a focused unit test for the GET-handshake helper that this task introduces. Create `packages/api/tests/whatsapp-webhook-handshake.test.ts`:
```ts
import { describe, expect, it } from "vitest";
import { verifyWhatsAppHandshake } from "../src/cli/serve-http.js";

describe("verifyWhatsAppHandshake", () => {
  it("echoes the challenge when mode=subscribe and token matches", () => {
    const url = new URL(
      "http://x/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=secret&hub.challenge=12345",
    );
    expect(verifyWhatsAppHandshake(url, "secret")).toBe("12345");
  });

  it("returns null when the verify token does not match", () => {
    const url = new URL(
      "http://x/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=12345",
    );
    expect(verifyWhatsAppHandshake(url, "secret")).toBeNull();
  });

  it("returns null when mode is not subscribe", () => {
    const url = new URL(
      "http://x/whatsapp-webhook?hub.mode=unsubscribe&hub.verify_token=secret&hub.challenge=12345",
    );
    expect(verifyWhatsAppHandshake(url, "secret")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @agent-mouth/api test -- whatsapp-webhook-handshake`
Expected: FAIL — `verifyWhatsAppHandshake` is not exported from `serve-http.js` (import resolves to `undefined`, `TypeError: verifyWhatsAppHandshake is not a function`).

- [ ] **Step 3: Write minimal implementation**

**3a.** Add the imports. After the existing transport-telegram import block (`packages/api/src/cli/serve-http.ts:21-25`):
```ts
import {
  type TelegramConfig,
  TelegramTransport,
  telegramUpdateToInbound,
} from "@agent-mouth/transport-telegram";
```
insert:
```ts
import {
  WhatsAppTransport,
  verifyMetaSignature,
  whatsappMessageToInbound,
} from "@agent-mouth/transport-whatsapp";
```

**3b.** Add the exported handshake helper + a raw-body reader near the top of the file, right after the `sendJson` function (after `packages/api/src/cli/serve-http.ts:55`):
```ts
/**
 * Meta GET verification handshake. Returns the challenge string to echo (200)
 * when mode=subscribe and the verify token matches; otherwise null (caller → 403).
 */
export function verifyWhatsAppHandshake(url: URL, verifyToken: string): string | null {
  const mode = url.searchParams.get("hub.mode");
  const token = url.searchParams.get("hub.verify_token");
  const challenge = url.searchParams.get("hub.challenge");
  if (mode === "subscribe" && token === verifyToken && challenge !== null) {
    return challenge;
  }
  return null;
}

/** Read the raw request body as a UTF-8 string (needed verbatim for HMAC signature checks). */
async function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}
```

**3c.** Add the WhatsApp config holder. After the email holders (`packages/api/src/cli/serve-http.ts:110-113`):
```ts
  let emailWebhookDeps: EmailWebhookDeps | null = null;
  let transportRegistry: TransportRegistry | null = null;
  let emailFetchDeps: NonNullable<Parameters<typeof startWorker>[0]["emailFetchDeps"]> | undefined =
    undefined;
```
insert:
```ts
  // Phase 4a — WhatsApp. `whatsappTransport`/`whatsappAppSecret` stay null until
  // ENABLE_WHATSAPP_TRANSPORT=true with full config; until then /whatsapp-webhook → 503.
  let whatsappTransport: WhatsAppTransport | null = null;
  let whatsappAppSecret: string | null = null;
  let whatsappVerifyToken: string | null = null;
```

**3d.** Add the bootstrap block. Insert it immediately before `const databaseUrl = process.env.DATABASE_URL;` (`packages/api/src/cli/serve-http.ts:205`). Note: it shares the `transportRegistry` created by the email block — if email is disabled, this block creates the registry and registers telegram first (mirroring the email block's `register("telegram", ...)`).
```ts
  // Phase 4a — bootstrap WhatsAppTransport if configured
  const enableWhatsapp = process.env.ENABLE_WHATSAPP_TRANSPORT === "true";
  if (enableWhatsapp) {
    const phoneNumberId = process.env.WHATSAPP_PHONE_NUMBER_ID;
    const accessToken = process.env.WHATSAPP_ACCESS_TOKEN;
    const appSecret = process.env.WHATSAPP_APP_SECRET;
    const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN;
    const graphVersion = process.env.WHATSAPP_GRAPH_VERSION ?? "v21.0";
    const displayPhoneNumber = process.env.WHATSAPP_DISPLAY_PHONE_NUMBER;

    if (!phoneNumberId || !accessToken || !appSecret || !verifyToken) {
      logger.warn(
        "ENABLE_WHATSAPP_TRANSPORT=true but missing required env vars (WHATSAPP_PHONE_NUMBER_ID, WHATSAPP_ACCESS_TOKEN, WHATSAPP_APP_SECRET, WHATSAPP_VERIFY_TOKEN); WhatsAppTransport will not boot",
      );
    } else {
      try {
        const transport = new WhatsAppTransport({
          phone_number_id: phoneNumberId,
          access_token: accessToken,
          graph_version: graphVersion,
          display_phone_number: displayPhoneNumber,
        });
        await transport.init({});

        // Ensure a whatsapp channel row exists for this workspace (mirrors the
        // email channel bootstrap in email-setup.ts). Supabase REST over HTTPS.
        const restHeaders = {
          apikey: supabaseKey,
          Authorization: `Bearer ${supabaseKey}`,
          "Content-Type": "application/json",
        };
        const lookupUrl = `${supabaseUrl}/rest/v1/channels?workspace_id=eq.${workspace.id}&type=eq.whatsapp&select=id&limit=1`;
        const lookupRes = await fetch(lookupUrl, { headers: restHeaders });
        if (!lookupRes.ok) {
          throw new Error(`whatsapp channel lookup failed: ${lookupRes.status} ${await lookupRes.text()}`);
        }
        const lookupRows = (await lookupRes.json()) as Array<{ id: string }>;
        if (lookupRows.length === 0) {
          const insertRes = await fetch(`${supabaseUrl}/rest/v1/channels`, {
            method: "POST",
            headers: { ...restHeaders, Prefer: "return=representation" },
            body: JSON.stringify({
              workspace_id: workspace.id,
              type: "whatsapp",
              config: { phone_number_id: phoneNumberId, display_phone_number: displayPhoneNumber ?? null },
              status: "active",
            }),
          });
          if (!insertRes.ok) {
            throw new Error(`whatsapp channel insert failed: ${insertRes.status} ${await insertRes.text()}`);
          }
        }

        // Reuse the registry the email block may have created; else create it
        // and register telegram first.
        if (!transportRegistry) {
          transportRegistry = new TransportRegistry();
          transportRegistry.register("telegram", telegramTransport);
        }
        transportRegistry.register("whatsapp", transport);

        whatsappTransport = transport;
        whatsappAppSecret = appSecret;
        whatsappVerifyToken = verifyToken;
        logger.info({ phoneNumberId }, "whatsapp transport bootstrapped");
      } catch (err) {
        logger.error(
          { err: String(err) },
          "whatsapp transport bootstrap failed; continuing without whatsapp",
        );
      }
    }
  }
```

**3e.** Add the routes. Insert the GET+POST `/whatsapp-webhook` handlers immediately after the `/email-webhook` block (`packages/api/src/cli/serve-http.ts:319-326`):
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
insert:
```ts
      if (url.pathname === "/whatsapp-webhook" && req.method === "GET") {
        if (!whatsappVerifyToken) {
          sendJson(res, 503, { error: "whatsapp transport not configured" });
          return;
        }
        const challenge = verifyWhatsAppHandshake(url, whatsappVerifyToken);
        if (challenge === null) {
          sendJson(res, 403, { error: "verification failed" });
          return;
        }
        res.writeHead(200, { "Content-Type": "text/plain" });
        res.end(challenge);
        return;
      }

      if (url.pathname === "/whatsapp-webhook" && req.method === "POST") {
        if (!whatsappTransport || !whatsappAppSecret) {
          sendJson(res, 503, { error: "whatsapp transport not configured" });
          return;
        }
        const rawBody = await readRawBody(req);
        const sigHeader = req.headers["x-hub-signature-256"];
        const sig = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
        if (!verifyMetaSignature(rawBody, sig ?? undefined, whatsappAppSecret)) {
          logger.warn("whatsapp-webhook signature verification failed");
          sendJson(res, 403, { error: "invalid signature" });
          return;
        }
        let body: unknown;
        try {
          body = rawBody ? JSON.parse(rawBody) : undefined;
        } catch {
          logger.warn("whatsapp-webhook body not JSON");
          sendJson(res, 200, { ok: true, skipped: "malformed" });
          return;
        }
        // Resolve the whatsapp channel id once (for raw_payload provenance).
        let whatsappChannelId = "";
        try {
          const chUrl = `${supabaseUrl}/rest/v1/channels?workspace_id=eq.${workspace.id}&type=eq.whatsapp&select=id&limit=1`;
          const chRes = await fetch(chUrl, {
            headers: { apikey: supabaseKey, Authorization: `Bearer ${supabaseKey}` },
          });
          if (chRes.ok) {
            const rows = (await chRes.json()) as Array<{ id: string }>;
            whatsappChannelId = rows[0]?.id ?? "";
          }
        } catch {
          // non-fatal — provenance only
        }
        const parsedBody = body as {
          entry?: { changes?: { field: string; value: unknown }[] }[];
        };
        const inbounds = (parsedBody.entry ?? [])
          .flatMap((e) => e.changes ?? [])
          .filter((c) => c.field === "messages")
          .flatMap((c) => whatsappMessageToInbound(c.value, whatsappChannelId));
        // Respond 200 immediately so Meta does not retry; process inline.
        sendJson(res, 200, { ok: true, count: inbounds.length });
        for (const inbound of inbounds) {
          const parsed = InboundMessageSchema.safeParse(inbound);
          if (!parsed.success) {
            logger.warn({ issues: parsed.error.issues }, "whatsapp inbound schema mismatch");
            continue;
          }
          processInbound(parsed.data, routerDeps)
            .then((result) => {
              logger.info({ result }, "whatsapp webhook processed");
              if (result.kind === "persisted" && result.policy !== "silent" && workerCtl) {
                workerCtl.queue
                  .send(
                    "agent.respond",
                    {
                      workspaceId: routerDeps.workspaceId,
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
                  )
                  .catch((err) => logger.error({ err }, "enqueue agent.respond (whatsapp) failed"));
              }
            })
            .catch((err) => logger.error({ err }, "whatsapp processInbound failed"));
        }
        return;
      }
```

Note on idempotency (spec decision #7): two layers protect against Meta's at-least-once retries. (1) The DB layer — `messages_channel_external_uniq` UNIQUE `(channel_id, external_message_id)` (migration 0005) — rejects a duplicate `wamid` insert, so `SupabaseMessageStore.insert` throws on the second delivery; that rejection propagates out of `processInbound` and is swallowed by the `.catch` on the `processInbound(...)` promise here (no crash, no second persisted row), exactly as the email path does (`email-fetch.ts` wraps `processInbound` in try/catch and continues). (2) The job layer — `singletonKey: result.messageId` — means that even if a duplicate ever did enqueue, pg-boss dedups the `agent.respond` job so the agent never double-replies. `result.messageId` is the persisted message row id (created from `external_message_id = wamid`).

- [ ] **Step 4: Run test to verify it passes, then typecheck/build the package**

Run: `pnpm --filter @agent-mouth/api test -- whatsapp-webhook-handshake`
Expected: PASS (3 tests).

Run: `pnpm --filter @agent-mouth/api build`
Expected: PASS — `tsc` compiles `serve-http.ts` (and the rest of `@agent-mouth/api`) with no type errors. (This is the primary verification for the wiring code.)

- [ ] **Step 5: Commit**
```bash
git add packages/api/src/cli/serve-http.ts packages/api/tests/whatsapp-webhook-handshake.test.ts && git commit -m "$(cat <<'EOF'
feat(api): /whatsapp-webhook GET+POST, bootstrap+register WhatsAppTransport, channel row

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

### Task 10: Integration tests (Supabase real)

These exercise the full inbound path against a real Supabase (skipped automatically when `SUPABASE_URL`/`SUPABASE_ANON_KEY` are unset, matching the repo's `describe.skipIf` convention in `packages/storage-supabase/tests/audit-log-store.test.ts`). They drive `processInbound` directly with a signed-and-normalized WhatsApp payload (the same call chain the webhook uses), plus a real `SupabaseMessageStore` to prove idempotency.

**Files:**
- Test: `packages/api/tests/whatsapp-flow.test.ts`

**Prereqs (documented, not a code task):** a `whatsapp` channel row must exist for the test workspace `00000000-0000-0000-0000-000000000001` (the same fixture workspace the other Supabase tests use). The test creates it via Supabase REST in `beforeAll` if missing (mirrors `email-setup.ts`).

- [ ] **Step 1: Write the failing test**

`packages/api/tests/whatsapp-flow.test.ts`:
```ts
import { beforeAll, describe, expect, it, vi } from "vitest";
import { createHmac } from "node:crypto";
import {
  SupabaseIdentityResolver,
  SupabaseMessageStore,
  SupabasePolicyEngine,
  SupabaseThreadStore,
} from "@agent-mouth/storage-supabase";
import { verifyMetaSignature, whatsappMessageToInbound } from "@agent-mouth/transport-whatsapp";
import { InboundMessageSchema } from "@agent-mouth/core";
import { processInbound, type RouterDeps } from "../src/router.js";

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY!;
const SKIP = !SUPABASE_URL || !SUPABASE_ANON_KEY;
const WORKSPACE_ID = "00000000-0000-0000-0000-000000000001";
const APP_SECRET = "integration_app_secret";

function restHeaders() {
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
  };
}

async function ensureWhatsappChannel(): Promise<string> {
  const lookup = await fetch(
    `${SUPABASE_URL}/rest/v1/channels?workspace_id=eq.${WORKSPACE_ID}&type=eq.whatsapp&select=id&limit=1`,
    { headers: restHeaders() },
  );
  const rows = (await lookup.json()) as Array<{ id: string }>;
  if (rows.length > 0) return rows[0]!.id;
  const ins = await fetch(`${SUPABASE_URL}/rest/v1/channels`, {
    method: "POST",
    headers: { ...restHeaders(), Prefer: "return=representation" },
    body: JSON.stringify({ workspace_id: WORKSPACE_ID, type: "whatsapp", config: {}, status: "active" }),
  });
  const insRows = (await ins.json()) as Array<{ id: string }>;
  return insRows[0]!.id;
}

function buildWebhook(wamid: string, from: string, body: string) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: "WABA",
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: { phone_number_id: "PNID" },
              contacts: [{ profile: { name: "Marco" }, wa_id: from }],
              messages: [{ from, id: wamid, timestamp: "1716638400", type: "text", text: { body } }],
            },
          },
        ],
      },
    ],
  };
}

function makeRouterDeps(): RouterDeps {
  return {
    workspaceId: WORKSPACE_ID,
    bridgeForwardChats: new Set(),
    bridgeForwardUrl: null,
    identityResolver: new SupabaseIdentityResolver(SUPABASE_URL, SUPABASE_ANON_KEY),
    threadStore: new SupabaseThreadStore(SUPABASE_URL, SUPABASE_ANON_KEY),
    policyEngine: new SupabasePolicyEngine(SUPABASE_URL, SUPABASE_ANON_KEY),
    messageStore: new SupabaseMessageStore(SUPABASE_URL, SUPABASE_ANON_KEY),
    forwarder: vi.fn(),
  };
}

describe.skipIf(SKIP)("whatsapp inbound flow (Supabase real)", () => {
  let channelId: string;

  beforeAll(async () => {
    channelId = await ensureWhatsappChannel();
    process.env.ENABLE_WHATSAPP_AUTO = "true";
  });

  it("verified+normalized signed webhook persists a Contact/Thread/Message", async () => {
    const wamid = `wamid.IT_${Date.now()}`;
    const from = "34611111111";
    const webhook = buildWebhook(wamid, from, "hola integration");
    const rawBody = JSON.stringify(webhook);
    const sig = `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;

    // Mirror the webhook handler: verify → normalize → schema → processInbound.
    expect(verifyMetaSignature(rawBody, sig, APP_SECRET)).toBe(true);
    process.env.WHATSAPP_ALLOWLIST = from;
    const inbounds = webhook.entry
      .flatMap((e) => e.changes)
      .filter((c) => c.field === "messages")
      .flatMap((c) => whatsappMessageToInbound(c.value, channelId));
    expect(inbounds).toHaveLength(1);

    const parsed = InboundMessageSchema.safeParse(inbounds[0]);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    const result = await processInbound(parsed.data, makeRouterDeps());
    expect(result.kind).toBe("persisted");
    if (result.kind !== "persisted") return;
    expect(result.policy).toBe("auto");
    expect(result.channelType).toBe("whatsapp");
    expect(result.externalChatId).toBe(from);
    expect(result.messageId).toBeTruthy();
  });

  it("dedups on wamid: 2nd insert of same external_message_id is rejected by the DB, leaving exactly one row", async () => {
    const wamid = `wamid.DUP_${Date.now()}`;
    const from = "34611111111";
    process.env.WHATSAPP_ALLOWLIST = from;
    const webhook = buildWebhook(wamid, from, "dup test");
    const inbound = whatsappMessageToInbound(webhook.entry[0]!.changes[0]!.value, channelId)[0]!;
    const parsed = InboundMessageSchema.parse(inbound);

    // First delivery persists. (channel_id, external_message_id) is now taken.
    const r1 = await processInbound(parsed, makeRouterDeps());
    if (r1.kind !== "persisted") throw new Error("expected persisted");

    // Second (duplicate) delivery: the UNIQUE index `messages_channel_external_uniq`
    // (migration 0005) rejects the insert, so SupabaseMessageStore.insert throws.
    // The webhook handler catches this in its `.catch` and the duplicate never
    // double-replies (the worker also dedups via singletonKey=messageId). The
    // invariant we assert here is "exactly one row exists for this wamid".
    await expect(processInbound(parsed, makeRouterDeps())).rejects.toThrow(/message insert failed/i);

    const countRes = await fetch(
      `${SUPABASE_URL}/rest/v1/messages?channel_id=eq.${channelId}&external_message_id=eq.${wamid}&select=id`,
      { headers: { ...restHeaders(), Prefer: "count=exact" } },
    );
    const rows = (await countRes.json()) as Array<{ id: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(r1.messageId);
  });

  it("non-allow-listed sender is persisted but policy=silent (no job)", async () => {
    const wamid = `wamid.SILENT_${Date.now()}`;
    const from = "34699999999";
    process.env.WHATSAPP_ALLOWLIST = "34600000000"; // does NOT include `from`
    const webhook = buildWebhook(wamid, from, "no reply");
    const inbound = whatsappMessageToInbound(webhook.entry[0]!.changes[0]!.value, channelId)[0]!;
    const parsed = InboundMessageSchema.parse(inbound);

    const result = await processInbound(parsed, makeRouterDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("silent");
    expect(result.messageId).toBeTruthy(); // persisted even though silent
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or skips locally)**

Run: `pnpm --filter @agent-mouth/api test -- whatsapp-flow`
Expected:
- Locally without Supabase env: the suite is SKIPPED (`describe.skipIf` true) — that is an acceptable green run; the assertions cannot fail.
- With `SUPABASE_URL` + `SUPABASE_ANON_KEY` set but before Tasks 8 ran: FAIL — the allow-list assertion `expect(result.policy).toBe("auto")` would be `silent` (gate not present). Since Tasks 8/9 are already done by this point, the run should instead exercise the real path and pass in Step 4.

> If iterating with a real Supabase, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` in the environment before running. The 0005 UNIQUE index on `messages (channel_id, external_id)` must already be applied (it is — Phase 1b).

- [ ] **Step 3: (No new implementation)**

The integration tests only consume code shipped in Tasks 2-9. No production code changes here.

- [ ] **Step 4: Run test to verify it passes**

Run (with Supabase env set): `SUPABASE_URL=$SUPABASE_URL SUPABASE_ANON_KEY=$SUPABASE_ANON_KEY pnpm --filter @agent-mouth/api test -- whatsapp-flow`
Expected: PASS (3 tests) — (1) Contact/Thread/Message persisted with policy=auto for an allow-listed sender; (2) a duplicate wamid insert is rejected by the UNIQUE index so exactly one `messages` row remains; (3) a non-allow-listed sender is persisted with policy=silent.

Run the whole API + new package suite to confirm nothing regressed:
Run: `pnpm --filter @agent-mouth/transport-whatsapp test && pnpm --filter @agent-mouth/api test`
Expected: PASS (all suites).

- [ ] **Step 5: Commit**
```bash
git add packages/api/tests/whatsapp-flow.test.ts && git commit -m "$(cat <<'EOF'
test(api): WhatsApp inbound flow integration (persist, idempotency, allow-list)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Final verification (whole tree)

- [ ] Run the full build and test suites:
```bash
pnpm -r build && pnpm -r test
```
Expected: PASS across all packages (the new `@agent-mouth/transport-whatsapp` plus unchanged Telegram/Email).

- [ ] Lint:
```bash
pnpm lint
```
Expected: no errors introduced (biome).

---

## Spec §7 test → task coverage map

| Spec §7 test group | Covered by |
|---|---|
| §7.1 `transport-whatsapp/signature` (~4) | Task 3 (`signature.test.ts`) |
| §7.1 `transport-whatsapp/schema` (~4) | Task 2 (`schema.test.ts`) |
| §7.1 `transport-whatsapp/normalize` (~5) | Task 4 (`normalize.test.ts`) |
| §7.1 `transport-whatsapp/whatsapp-transport.send` (~5) | Task 5 (`whatsapp-transport.test.ts`) |
| §7.1 `api/send-message` (~3) | Task 7 (`send-message-whatsapp.test.ts`) |
| §7.1 `api/whatsapp-webhook` handler (~5) | GET handshake → Task 9 (`whatsapp-webhook-handshake.test.ts`); POST verify/normalize/process/skip behaviors are exercised by the real path in Task 10 (`whatsapp-flow.test.ts`) + unit-covered upstream (signature Task 3, schema/normalize Tasks 2/4). |
| §7.1 `router/allowlist` (~4) | Task 8 (`router-whatsapp-allowlist.test.ts`) |
| §7.2 integration: flow / idempotency / allowlist | Task 10 (`whatsapp-flow.test.ts`) — three `it` blocks (persist+auto; duplicate-wamid rejected → one row; non-allow-listed → silent) |
| §7.3 E2E Gate 4a | DEFERRED (see note below) — not a task |

> Note on §7.1 `api/whatsapp-webhook` POST cases: `serveHttp()` is a large bootstrap function with no existing unit harness in the repo (there is no `serve-http.test.ts`), so the POST handler is verified by `tsc` (Task 9 Step 4) and the real end-to-end path (Task 10), rather than by mocking `IncomingMessage`/`ServerResponse`. If a future refactor extracts the POST body into a standalone `handleWhatsAppWebhook(req,res,deps)` (as email did in `email-webhook.ts`), add a `whatsapp-webhook.test.ts` mirroring `email-webhook.test.ts`. This is intentionally NOT done here to avoid restructuring `serve-http.ts` beyond the spec's scope.

---

## Deferred / out of scope (NOT tasks)

The following are explicitly **out of scope** for this plan (spec §3 decision D, §7.3, §8.2) and must NOT be implemented as part of it:

- **Meta provisioning:** creating the Meta Business account, WhatsApp Business Account (WABA), the dedicated phone number, the Meta App (Business type) with the WhatsApp product, and obtaining `phone_number_id` / `app_secret` / the permanent System User access token.
- **Live webhook configuration** in the Meta App dashboard (callback `https://agent-mouth.fly.dev/whatsapp-webhook`, `verify_token`, subscribe to the `messages` field).
- **Setting the `WHATSAPP_*` Fly secrets** and `flyctl deploy` to go live.
- **Gate 4a (§7.3):** the live acceptance test (real WhatsApp message → reply within 60s, cross-channel `read_inbox`, audit-log checks, non-allow-listed silence, kill-switch verification). It can only run after the provisioning above.

The code from this plan is config-driven and ships **inert**: with `ENABLE_WHATSAPP_TRANSPORT` unset, `/whatsapp-webhook` returns 503 and no WhatsApp behavior is active, so the branch is safe to merge and deploy independently of the deferred live activation.
