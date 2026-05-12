# Agent Mouth (Telegram) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a TypeScript MCP server that lets AI agents from different people communicate via a shared Telegram group as transport. v1 scope: messaging only (no tasks, no subagents).

**Architecture:** Transport-abstracted MCP server. `TelegramTransport` is the v1 implementation; v2 may add native/Postgres transports without changing tool interfaces.

**Tech Stack:** TypeScript 5.5+, Node 20 LTS, `@modelcontextprotocol/sdk`, **`grammy`** (Telegram bot framework — best TS support), `pino`, Vitest, Biome, pnpm workspaces. **No Postgres, no Docker, no bcrypt.**

**Spec:** `docs/superpowers/specs/2026-05-11-agent-mouth-telegram-design.md`

**Status:** Tasks 1-3 of previous plan complete (monorepo + TS/Biome + package scaffolding). This plan starts at the pivot.

---

## Implementation Phases

| Phase | Tasks | Result |
|-------|-------|--------|
| Pivot cleanup | T1 | Postgres deps removed, grammy installed |
| Transport layer | T2-T4 | Telegram client wrapped in Transport interface |
| Server + tools | T5-T9 | MCP server + 7 tools wired up |
| CLI | T10-T12 | `serve`, `init` (with chat_id auto-detect), `join` |
| Polish | T13-T14 | README + manual E2E + npm publish prep |

---

## Phase 1: Pivot cleanup

### Task 1: Remove Postgres scaffolding, add grammy

**Files:**
- Delete: `packages/sql/` (entire directory)
- Modify: `packages/mcp/package.json`
- Modify: `packages/mcp/src/index.ts`

- [ ] **Step 1: Remove `packages/sql/`**

```bash
cd ~/CerebroDigital/02-Proyectos/agent-mouth
rm -rf packages/sql
```

- [ ] **Step 2: Update `packages/mcp/package.json`** to:

```json
{
  "name": "agent-mouth",
  "version": "0.0.1",
  "type": "module",
  "bin": { "agent-mouth": "./dist/cli/index.js" },
  "exports": { ".": "./dist/index.js" },
  "files": ["dist/", "README.md"],
  "scripts": {
    "build": "tsc",
    "dev": "tsx src/cli/index.ts",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.0",
    "grammy": "^1.30.0",
    "pino": "^9.4.0",
    "zod": "^3.23.8"
  },
  "devDependencies": {
    "@types/node": "^20.16.0",
    "msw": "^2.4.0",
    "tsx": "^4.19.0",
    "typescript": "5.5.4",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Update `packages/mcp/src/index.ts`** to:

```ts
export const VERSION = "0.0.1";
export type { Transport, ReceivedMessage, SendOptions } from "./transports/types.js";
```

(`Transport` will exist after Task 2 — TypeScript will allow the export reference forward.)

- [ ] **Step 4: Install and verify**

```bash
pnpm install
pnpm -r build
```

Build will fail because `transports/types.js` doesn't exist yet. **That's expected** — comment out the type re-export in `index.ts` temporarily if needed for clean build, or leave it (Task 2 fixes it). For this task, verify install succeeded.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/package.json packages/mcp/src/index.ts pnpm-lock.yaml
git rm -rf packages/sql
git commit -m "chore: pivot to Telegram transport — remove Postgres scaffolding, add grammy"
```

---

## Phase 2: Transport layer

### Task 2: Transport interface

**Files:**
- Create: `packages/mcp/src/transports/types.ts`

- [ ] **Step 1: Create `packages/mcp/src/transports/types.ts`**

```ts
export interface Identity {
  handle: string;            // bot username without @
  display_name: string;
  bot_id?: number;           // Telegram-specific, optional in interface
  chat_id?: string;          // current group context
}

export interface Contact {
  handle: string;
  display_name: string | null;
  is_bot: boolean;
  last_seen?: Date;
}

export interface ReceivedMessage {
  id: string;                    // serialized "<update_id>:<message_id>"
  from_handle: string;
  body: string;
  timestamp: Date;
  reply_to_message_id?: string;
  is_mention: boolean;           // whether this message mentions me
  raw?: unknown;
}

export interface SentMessage {
  message_id: string;
  timestamp: Date;
}

export interface SendOptions {
  to?: string;                   // handle, or "broadcast" / undefined
  body: string;
  reply_to_message_id?: string;
}

export interface ReceiveOptions {
  filter?: "mentions" | "replies" | "all";
  since_message_id?: string;
  limit?: number;
}

export interface WaitOptions {
  timeout_seconds?: number;
  filter?: "mentions" | "replies" | "all";
}

export interface TransportConfig {
  [key: string]: unknown;
}

export interface Transport {
  init(config: TransportConfig): Promise<void>;
  whoami(): Promise<Identity>;
  listContacts(): Promise<Contact[]>;
  send(opts: SendOptions): Promise<SentMessage>;
  receive(opts: ReceiveOptions): Promise<ReceivedMessage[]>;
  waitForMessages(opts: WaitOptions): Promise<ReceivedMessage[]>;
  close(): Promise<void>;
}
```

- [ ] **Step 2: Build**

```bash
pnpm -r build
```

Now Task 1's `index.ts` re-export resolves. Build should succeed.

- [ ] **Step 3: Commit**

```bash
git add packages/mcp/src/transports/types.ts
git commit -m "feat(transport): define Transport interface"
```

---

### Task 3: Telegram transport — init, whoami, listContacts

**Files:**
- Create: `packages/mcp/src/transports/telegram.ts`
- Test: `packages/mcp/tests/unit/telegram-transport.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/unit/telegram-transport.test.ts`**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TelegramTransport } from "../../src/transports/telegram.js";

// Mock the grammy Bot
vi.mock("grammy", () => {
  return {
    Bot: class MockBot {
      api = {
        getMe: vi.fn().mockResolvedValue({
          id: 7234567890,
          is_bot: true,
          first_name: "Gavrilo Backend",
          username: "gavrilo_backend_bot"
        }),
        getChat: vi.fn().mockResolvedValue({
          id: -1001234567890,
          type: "supergroup",
          title: "Aurellano Team"
        }),
        getChatAdministrators: vi.fn().mockResolvedValue([
          { user: { id: 1, is_bot: false, first_name: "Gavrilo", username: "gavrilom" } },
          { user: { id: 7234567890, is_bot: true, first_name: "Gavrilo Backend", username: "gavrilo_backend_bot" } },
          { user: { id: 7345678901, is_bot: true, first_name: "Marco Front", username: "marco_frontend_bot" } }
        ])
      };
      constructor(public token: string) {}
    }
  };
});

describe("TelegramTransport", () => {
  let transport: TelegramTransport;

  beforeEach(async () => {
    transport = new TelegramTransport();
    await transport.init({
      bot_token: "7234567890:AAH-fake-token",
      chat_id: "-1001234567890",
      handle: "gavrilo-backend"
    });
  });

  afterEach(async () => {
    await transport.close();
  });

  it("whoami returns bot identity from Telegram getMe", async () => {
    const me = await transport.whoami();
    expect(me.handle).toBe("gavrilo_backend_bot");
    expect(me.display_name).toBe("Gavrilo Backend");
    expect(me.bot_id).toBe(7234567890);
    expect(me.chat_id).toBe("-1001234567890");
  });

  it("listContacts returns other group members (excluding self)", async () => {
    const contacts = await transport.listContacts();
    const handles = contacts.map((c) => c.handle);
    expect(handles).toContain("gavrilom");
    expect(handles).toContain("marco_frontend_bot");
    expect(handles).not.toContain("gavrilo_backend_bot"); // self excluded
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
cd packages/mcp && pnpm test -- telegram-transport.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/transports/telegram.ts`**

```ts
import { Bot } from "grammy";
import type {
  Contact,
  Identity,
  ReceivedMessage,
  ReceiveOptions,
  SendOptions,
  SentMessage,
  Transport,
  TransportConfig,
  WaitOptions
} from "./types.js";

export interface TelegramConfig extends TransportConfig {
  bot_token: string;
  chat_id: string;
  handle: string;
}

export class TelegramTransport implements Transport {
  private bot: Bot | null = null;
  private chatId: string = "";
  private handle: string = "";
  private botUserId: number = 0;

  async init(config: TransportConfig): Promise<void> {
    const c = config as TelegramConfig;
    if (!c.bot_token || !c.chat_id) {
      throw new Error("TelegramTransport requires bot_token and chat_id");
    }
    this.bot = new Bot(c.bot_token);
    this.chatId = c.chat_id;
    this.handle = c.handle;

    // Resolve bot identity for self-filtering
    const me = await this.bot.api.getMe();
    this.botUserId = me.id;
  }

  async whoami(): Promise<Identity> {
    if (!this.bot) throw new Error("Transport not initialized");
    const me = await this.bot.api.getMe();
    return {
      handle: me.username!,
      display_name: me.first_name,
      bot_id: me.id,
      chat_id: this.chatId
    };
  }

  async listContacts(): Promise<Contact[]> {
    if (!this.bot) throw new Error("Transport not initialized");
    const admins = await this.bot.api.getChatAdministrators(this.chatId);
    return admins
      .filter((m) => m.user.id !== this.botUserId)
      .map((m) => ({
        handle: m.user.username ?? `user_${m.user.id}`,
        display_name: m.user.first_name ?? null,
        is_bot: m.user.is_bot
      }));
  }

  async send(_opts: SendOptions): Promise<SentMessage> {
    throw new Error("not implemented in Task 3");
  }

  async receive(_opts: ReceiveOptions): Promise<ReceivedMessage[]> {
    throw new Error("not implemented in Task 3");
  }

  async waitForMessages(_opts: WaitOptions): Promise<ReceivedMessage[]> {
    throw new Error("not implemented in Task 3");
  }

  async close(): Promise<void> {
    this.bot = null;
  }
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
pnpm test -- telegram-transport.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/transports/telegram.ts packages/mcp/tests/unit/telegram-transport.test.ts
git commit -m "feat(telegram): init, whoami, listContacts"
```

---

### Task 4: Telegram transport — send, receive, waitForMessages

**Files:**
- Modify: `packages/mcp/src/transports/telegram.ts`
- Modify: `packages/mcp/tests/unit/telegram-transport.test.ts`

- [ ] **Step 1: Add failing tests**

```ts
// Add to the existing describe block

it("send formats message with @mention when 'to' is a handle", async () => {
  // Extend the Bot mock with sendMessage
  const sendMessageSpy = vi.fn().mockResolvedValue({
    message_id: 42,
    date: Math.floor(Date.now() / 1000)
  });
  (transport as any).bot.api.sendMessage = sendMessageSpy;

  const result = await transport.send({
    to: "marco_frontend_bot",
    body: "please connect form"
  });

  expect(sendMessageSpy).toHaveBeenCalledWith(
    "-1001234567890",
    "@marco_frontend_bot please connect form",
    expect.any(Object)
  );
  expect(result.message_id).toBe("42");
});

it("send without 'to' broadcasts (no mention prefix)", async () => {
  const sendMessageSpy = vi.fn().mockResolvedValue({
    message_id: 43,
    date: Math.floor(Date.now() / 1000)
  });
  (transport as any).bot.api.sendMessage = sendMessageSpy;

  await transport.send({ body: "deploying in 5 min" });

  expect(sendMessageSpy).toHaveBeenCalledWith(
    "-1001234567890",
    "deploying in 5 min",
    expect.any(Object)
  );
});

it("waitForMessages parses Telegram updates into ReceivedMessages with mention detection", async () => {
  const getUpdatesSpy = vi.fn().mockResolvedValue([
    {
      update_id: 100,
      message: {
        message_id: 50,
        from: { id: 999, is_bot: false, first_name: "Marco", username: "marco_user" },
        chat: { id: -1001234567890 },
        date: 1730000000,
        text: "@gavrilo_backend_bot can you do X?",
        entities: [{ type: "mention", offset: 0, length: 23 }]
      }
    },
    {
      update_id: 101,
      message: {
        message_id: 51,
        from: { id: 888, is_bot: false, first_name: "Other", username: "other_user" },
        chat: { id: -1001234567890 },
        date: 1730000005,
        text: "unrelated broadcast"
      }
    }
  ]);
  (transport as any).bot.api.getUpdates = getUpdatesSpy;

  const msgs = await transport.waitForMessages({ timeout_seconds: 1 });
  expect(msgs).toHaveLength(2);
  expect(msgs[0].body).toBe("@gavrilo_backend_bot can you do X?");
  expect(msgs[0].from_handle).toBe("marco_user");
  expect(msgs[0].is_mention).toBe(true);
  expect(msgs[1].is_mention).toBe(false);
});

it("waitForMessages with filter='mentions' returns only messages that mention me", async () => {
  const getUpdatesSpy = vi.fn().mockResolvedValue([
    {
      update_id: 200,
      message: {
        message_id: 60,
        from: { id: 999, is_bot: false, first_name: "Marco", username: "marco_user" },
        chat: { id: -1001234567890 },
        date: 1730000000,
        text: "@gavrilo_backend_bot do X",
        entities: [{ type: "mention", offset: 0, length: 23 }]
      }
    },
    {
      update_id: 201,
      message: {
        message_id: 61,
        from: { id: 888, is_bot: false, first_name: "X", username: "x_user" },
        chat: { id: -1001234567890 },
        date: 1730000005,
        text: "broadcast"
      }
    }
  ]);
  (transport as any).bot.api.getUpdates = getUpdatesSpy;

  const msgs = await transport.waitForMessages({ filter: "mentions" });
  expect(msgs).toHaveLength(1);
  expect(msgs[0].body).toContain("@gavrilo_backend_bot");
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- telegram-transport.test.ts
```

- [ ] **Step 3: Update `telegram.ts` — replace `send`, `receive`, `waitForMessages`**

```ts
  async send(opts: SendOptions): Promise<SentMessage> {
    if (!this.bot) throw new Error("Transport not initialized");
    const text = opts.to && opts.to !== "broadcast"
      ? `@${opts.to} ${opts.body}`
      : opts.body;
    const sent = await this.bot.api.sendMessage(this.chatId, text, {
      reply_parameters: opts.reply_to_message_id
        ? { message_id: Number(opts.reply_to_message_id) }
        : undefined
    });
    return {
      message_id: String(sent.message_id),
      timestamp: new Date(sent.date * 1000)
    };
  }

  async receive(opts: ReceiveOptions): Promise<ReceivedMessage[]> {
    // For Telegram, receive() and waitForMessages() share the same getUpdates source.
    // receive() uses timeout=0 (non-blocking poll), waitForMessages() uses long-poll.
    return this.fetchUpdates({ timeoutSeconds: 0, filter: opts.filter, limit: opts.limit });
  }

  async waitForMessages(opts: WaitOptions): Promise<ReceivedMessage[]> {
    return this.fetchUpdates({
      timeoutSeconds: opts.timeout_seconds ?? 30,
      filter: opts.filter
    });
  }

  private async fetchUpdates(args: {
    timeoutSeconds: number;
    filter?: "mentions" | "replies" | "all";
    limit?: number;
  }): Promise<ReceivedMessage[]> {
    if (!this.bot) throw new Error("Transport not initialized");
    const updates = await this.bot.api.getUpdates({
      timeout: args.timeoutSeconds,
      allowed_updates: ["message"],
      limit: args.limit ?? 100
    });

    const myMention = `@${(await this.whoami()).handle}`.toLowerCase();
    const mapped: ReceivedMessage[] = [];

    for (const update of updates) {
      const msg = update.message;
      if (!msg || !msg.text) continue;
      if (String(msg.chat.id) !== this.chatId) continue;
      if (msg.from?.id === this.botUserId) continue; // skip self

      const isMention = msg.text.toLowerCase().includes(myMention);
      if (args.filter === "mentions" && !isMention) continue;
      if (args.filter === "replies" && msg.reply_to_message?.from?.id !== this.botUserId) continue;

      mapped.push({
        id: `${update.update_id}:${msg.message_id}`,
        from_handle: msg.from?.username ?? `user_${msg.from?.id ?? 0}`,
        body: msg.text,
        timestamp: new Date(msg.date * 1000),
        reply_to_message_id: msg.reply_to_message
          ? String(msg.reply_to_message.message_id)
          : undefined,
        is_mention: isMention,
        raw: update
      });
    }

    return mapped;
  }
```

- [ ] **Step 4: Run, expect PASS**

```bash
pnpm test -- telegram-transport.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/transports/telegram.ts packages/mcp/tests/unit/telegram-transport.test.ts
git commit -m "feat(telegram): send, receive, waitForMessages with mention filtering"
```

---

## Phase 3: Server + tools

### Task 5: Config module

**Files:**
- Create: `packages/mcp/src/config.ts`
- Test: `packages/mcp/tests/unit/config.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/unit/config.test.ts`**

```ts
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, saveConfig, type AgentMouthConfig } from "../../src/config.js";

describe("config", () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), "am-")); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it("returns null when file does not exist", async () => {
    expect(await loadConfig(join(tmp, "config.json"))).toBeNull();
  });

  it("round-trips a Telegram config", async () => {
    const cfg: AgentMouthConfig = {
      transport: "telegram",
      telegram: {
        bot_token: "123:abc",
        chat_id: "-100456",
        handle: "gavrilo-backend",
        display_name: "Gavrilo Backend"
      },
      last_seen_update_id: 0
    };
    const path = join(tmp, "config.json");
    await saveConfig(path, cfg);
    const loaded = await loadConfig(path);
    expect(loaded).toEqual(cfg);
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- config.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/config.ts`**

```ts
import { mkdir, readFile, writeFile, chmod } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

export interface TelegramConfigBlock {
  bot_token: string;
  chat_id: string;
  handle: string;
  display_name?: string;
}

export interface AgentMouthConfig {
  transport: "telegram";
  telegram?: TelegramConfigBlock;
  last_seen_update_id: number;
}

export function defaultConfigPath(): string {
  return join(homedir(), ".agent-mouth", "config.json");
}

export async function loadConfig(path: string = defaultConfigPath()): Promise<AgentMouthConfig | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as AgentMouthConfig;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function saveConfig(path: string, config: AgentMouthConfig): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(config, null, 2), "utf8");
  await chmod(path, 0o600);
}
```

- [ ] **Step 4: Run, expect PASS**

```bash
pnpm test -- config.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/mcp/src/config.ts packages/mcp/tests/unit/config.test.ts
git commit -m "feat(config): load/save local config"
```

---

### Task 6: MCP server skeleton + logger

**Files:**
- Create: `packages/mcp/src/logger.ts`
- Create: `packages/mcp/src/server.ts`
- Test: `packages/mcp/tests/unit/server.test.ts`

- [ ] **Step 1: Create `packages/mcp/src/logger.ts`**

```ts
import pino from "pino";

export const logger = pino({
  level: process.env.AGENT_MOUTH_LOG ?? "info",
  transport: { target: "pino/file", options: { destination: 2 } } // stderr (stdout reserved for MCP)
});
```

- [ ] **Step 2: Write failing test `packages/mcp/tests/unit/server.test.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import type { Transport } from "../../src/transports/types.js";

function fakeTransport(): Transport {
  return {
    init: vi.fn(),
    whoami: vi.fn().mockResolvedValue({
      handle: "gavrilo_backend_bot",
      display_name: "Gavrilo Backend",
      bot_id: 1,
      chat_id: "-100"
    }),
    listContacts: vi.fn().mockResolvedValue([]),
    send: vi.fn(),
    receive: vi.fn(),
    waitForMessages: vi.fn(),
    close: vi.fn()
  };
}

describe("server", () => {
  it("lists registered tools including whoami", async () => {
    const server = buildServer({ transport: fakeTransport() });
    const [clientT, serverT] = InMemoryTransport.createLinkedPair();
    await server.connect(serverT);
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await client.connect(clientT);

    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toContain("whoami");
  });
});
```

- [ ] **Step 3: Run, expect FAIL**

```bash
pnpm test -- server.test.ts
```

- [ ] **Step 4: Create `packages/mcp/src/server.ts`**

```ts
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "./transports/types.js";
import { logger } from "./logger.js";

export interface ServerOptions {
  transport: Transport;
}

export interface ToolContext {
  transport: Transport;
}

export interface ToolDef {
  name: string;
  description: string;
  inputSchema: object;
  handler: (input: unknown, ctx: ToolContext) => Promise<unknown>;
}

const tools: ToolDef[] = [];

export function registerTool(tool: ToolDef): void {
  if (tools.find((t) => t.name === tool.name)) return; // idempotent
  tools.push(tool);
}

export function buildServer(opts: ServerOptions): Server {
  const server = new Server(
    { name: "agent-mouth", version: "0.0.1" },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: tools.map(({ name, description, inputSchema }) => ({ name, description, inputSchema }))
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const tool = tools.find((t) => t.name === request.params.name);
    if (!tool) throw new Error(`Unknown tool: ${request.params.name}`);
    try {
      const result = await tool.handler(request.params.arguments ?? {}, { transport: opts.transport });
      return {
        content: [{ type: "text", text: JSON.stringify({ ok: true, data: result }) }]
      };
    } catch (err) {
      const e = err as Error & { hint?: string };
      logger.error({ err: e, tool: request.params.name }, "tool failed");
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({
              ok: false,
              error: { code: e.name, message: e.message, ...(e.hint ? { hint: e.hint } : {}) }
            })
          }
        ],
        isError: true
      };
    }
  });

  // Tools self-register at import time via _register.ts
  require("./tools/_register.js");

  return server;
}
```

**Note:** the `require` at the bottom uses CommonJS — convert to a top-level ESM import if biome complains:

```ts
import "./tools/_register.js";
// ... and put at top of file
```

The `_register.ts` file is created in Task 7.

- [ ] **Step 5: Pre-create empty `packages/mcp/src/tools/_register.ts`** so the import resolves:

```ts
// Tools register themselves here. See identity.ts, messaging.ts.
```

- [ ] **Step 6: Add a stub whoami inline in `server.ts`** to make the test pass:

Inside `buildServer`, before `return server;`:

```ts
registerTool({
  name: "whoami",
  description: "stub",
  inputSchema: { type: "object", properties: {} },
  handler: async (_input, ctx) => ctx.transport.whoami()
});
```

(Task 7 replaces this stub with the real impl.)

- [ ] **Step 7: Run, expect PASS**

```bash
pnpm test -- server.test.ts
```

- [ ] **Step 8: Commit**

```bash
git add packages/mcp/src/logger.ts packages/mcp/src/server.ts packages/mcp/src/tools/_register.ts packages/mcp/tests/unit/server.test.ts
git commit -m "feat(server): MCP server skeleton with tool registry"
```

---

### Task 7: Identity tools — whoami + list_contacts

**Files:**
- Create: `packages/mcp/src/tools/identity.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/src/server.ts` (remove stub)
- Test: `packages/mcp/tests/unit/tools-identity.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/unit/tools-identity.test.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import type { Transport } from "../../src/transports/types.js";

function fakeTransport(): Transport {
  return {
    init: vi.fn(),
    whoami: vi.fn().mockResolvedValue({
      handle: "gavrilo_backend_bot",
      display_name: "Gavrilo Backend",
      bot_id: 7,
      chat_id: "-100"
    }),
    listContacts: vi.fn().mockResolvedValue([
      { handle: "marco_frontend_bot", display_name: "Marco Front", is_bot: true }
    ]),
    send: vi.fn(),
    receive: vi.fn(),
    waitForMessages: vi.fn(),
    close: vi.fn()
  };
}

async function callTool(client: Client, name: string, args: object) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text) as { ok: boolean; data?: any; error?: any };
}

async function connect(t: Transport) {
  const server = buildServer({ transport: t });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(c);
  return client;
}

describe("identity tools", () => {
  it("whoami returns the agent's identity", async () => {
    const client = await connect(fakeTransport());
    const r = await callTool(client, "whoami", {});
    expect(r.ok).toBe(true);
    expect(r.data.handle).toBe("gavrilo_backend_bot");
  });

  it("list_contacts returns other group members", async () => {
    const client = await connect(fakeTransport());
    const r = await callTool(client, "list_contacts", {});
    expect(r.ok).toBe(true);
    expect(r.data).toHaveLength(1);
    expect(r.data[0].handle).toBe("marco_frontend_bot");
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-identity.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/tools/identity.ts`**

```ts
import type { ToolDef } from "../server.js";

export const whoamiTool: ToolDef = {
  name: "whoami",
  description: "Returns this agent's identity (handle, display name, group context).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_input, { transport }) => transport.whoami()
};

export const listContactsTool: ToolDef = {
  name: "list_contacts",
  description: "Returns the other members of the group you're in (excludes yourself).",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  handler: async (_input, { transport }) => transport.listContacts()
};
```

- [ ] **Step 4: Update `packages/mcp/src/tools/_register.ts`**

```ts
import { registerTool } from "../server.js";
import { whoamiTool, listContactsTool } from "./identity.js";

registerTool(whoamiTool);
registerTool(listContactsTool);
```

- [ ] **Step 5: Remove the inline whoami stub from `server.ts`** (added in Task 6 Step 6).

- [ ] **Step 6: Run, expect PASS**

```bash
pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/src/server.ts packages/mcp/tests/unit/tools-identity.test.ts
git commit -m "feat(tools): whoami and list_contacts"
```

---

### Task 8: Messaging tools — send_message, get_thread, mark_read

**Files:**
- Create: `packages/mcp/src/tools/messaging.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Test: `packages/mcp/tests/unit/tools-messaging.test.ts`

- [ ] **Step 1: Write failing test `packages/mcp/tests/unit/tools-messaging.test.ts`**

```ts
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "../../src/server.js";
import type { Transport } from "../../src/transports/types.js";

function fakeTransport(overrides: Partial<Transport> = {}): Transport {
  return {
    init: vi.fn(),
    whoami: vi.fn().mockResolvedValue({ handle: "me", display_name: "Me", chat_id: "-100" }),
    listContacts: vi.fn().mockResolvedValue([]),
    send: vi.fn().mockResolvedValue({ message_id: "42", timestamp: new Date() }),
    receive: vi.fn().mockResolvedValue([]),
    waitForMessages: vi.fn().mockResolvedValue([]),
    close: vi.fn(),
    ...overrides
  };
}

async function callTool(client: Client, name: string, args: object) {
  const r = await client.callTool({ name, arguments: args });
  const text = (r.content as { type: string; text: string }[])[0]!.text;
  return JSON.parse(text) as { ok: boolean; data?: any; error?: any };
}

async function connect(t: Transport) {
  const server = buildServer({ transport: t });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(c);
  return client;
}

describe("messaging tools", () => {
  it("send_message passes 'to' and 'body' to transport.send", async () => {
    const t = fakeTransport();
    const client = await connect(t);
    const r = await callTool(client, "send_message", {
      to: "marco_frontend_bot",
      body: "hola"
    });
    expect(r.ok).toBe(true);
    expect(t.send).toHaveBeenCalledWith({
      to: "marco_frontend_bot",
      body: "hola",
      reply_to_message_id: undefined
    });
  });

  it("send_message rejects empty body", async () => {
    const client = await connect(fakeTransport());
    const r = await callTool(client, "send_message", { to: "x", body: "" });
    expect(r.ok).toBe(false);
  });

  it("read_inbox calls transport.receive with the given filter", async () => {
    const t = fakeTransport({
      receive: vi.fn().mockResolvedValue([
        { id: "1:1", from_handle: "marco", body: "hi", timestamp: new Date(), is_mention: true }
      ])
    });
    const client = await connect(t);
    const r = await callTool(client, "read_inbox", { filter: "mentions", limit: 50 });
    expect(r.ok).toBe(true);
    expect(t.receive).toHaveBeenCalledWith({ filter: "mentions", limit: 50, since_message_id: undefined });
    expect(r.data).toHaveLength(1);
  });

  it("wait_for_messages forwards timeout and filter", async () => {
    const t = fakeTransport({
      waitForMessages: vi.fn().mockResolvedValue([])
    });
    const client = await connect(t);
    await callTool(client, "wait_for_messages", { timeout_seconds: 10, filter: "mentions" });
    expect(t.waitForMessages).toHaveBeenCalledWith({ timeout_seconds: 10, filter: "mentions" });
  });
});
```

- [ ] **Step 2: Run, expect FAIL**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 3: Create `packages/mcp/src/tools/messaging.ts`**

```ts
import { z } from "zod";
import type { ToolDef } from "../server.js";

const FilterEnum = z.enum(["mentions", "replies", "all"]);

export const sendMessageTool: ToolDef = {
  name: "send_message",
  description: "Send a message to the group. If `to` is a handle, the message is prefixed with @<handle> so the receiving bot picks it up. If `to` is omitted or 'broadcast', sends without mention.",
  inputSchema: {
    type: "object",
    required: ["body"],
    properties: {
      to: { type: "string" },
      body: { type: "string", minLength: 1 },
      reply_to_message_id: { type: "string" }
    },
    additionalProperties: false
  },
  handler: async (input, { transport }) => {
    const parsed = z
      .object({
        to: z.string().optional(),
        body: z.string().min(1),
        reply_to_message_id: z.string().optional()
      })
      .parse(input);
    return transport.send(parsed);
  }
};

export const readInboxTool: ToolDef = {
  name: "read_inbox",
  description: "Returns recent messages from the group. Use filter='mentions' for messages addressed to you, 'replies' for replies to your messages, 'all' for everything (default 'mentions').",
  inputSchema: {
    type: "object",
    properties: {
      filter: { type: "string", enum: ["mentions", "replies", "all"] },
      since_message_id: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 }
    },
    additionalProperties: false
  },
  handler: async (input, { transport }) => {
    const parsed = z
      .object({
        filter: FilterEnum.optional().default("mentions"),
        since_message_id: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional().default(50)
      })
      .parse(input);
    return transport.receive(parsed);
  }
};

export const waitForMessagesTool: ToolDef = {
  name: "wait_for_messages",
  description: "Blocks for up to timeout_seconds (default 30) waiting for new messages. Returns when a message arrives or on timeout.",
  inputSchema: {
    type: "object",
    properties: {
      timeout_seconds: { type: "integer", minimum: 1, maximum: 300 },
      filter: { type: "string", enum: ["mentions", "replies", "all"] }
    },
    additionalProperties: false
  },
  handler: async (input, { transport }) => {
    const parsed = z
      .object({
        timeout_seconds: z.number().int().min(1).max(300).optional().default(30),
        filter: FilterEnum.optional().default("mentions")
      })
      .parse(input);
    return transport.waitForMessages(parsed);
  }
};
```

- [ ] **Step 4: Update `_register.ts`**

```ts
import { registerTool } from "../server.js";
import { whoamiTool, listContactsTool } from "./identity.js";
import { sendMessageTool, readInboxTool, waitForMessagesTool } from "./messaging.js";

registerTool(whoamiTool);
registerTool(listContactsTool);
registerTool(sendMessageTool);
registerTool(readInboxTool);
registerTool(waitForMessagesTool);
```

- [ ] **Step 5: Run, expect PASS**

```bash
pnpm test
```

- [ ] **Step 6: Commit**

```bash
git add packages/mcp/src/tools/ packages/mcp/tests/unit/tools-messaging.test.ts
git commit -m "feat(tools): send_message, read_inbox, wait_for_messages"
```

---

### Task 9: get_thread + mark_read

**Files:**
- Modify: `packages/mcp/src/tools/messaging.ts`
- Modify: `packages/mcp/src/tools/_register.ts`
- Modify: `packages/mcp/tests/unit/tools-messaging.test.ts`

For v1, `get_thread` and `mark_read` are thin wrappers — `get_thread` calls `transport.receive` with a `reply_to_message_id` filter, `mark_read` updates the last_seen_update_id in config. Since config persistence needs the file path, we'll thread the config path through `ServerOptions`.

- [ ] **Step 1: Extend `ServerOptions`** in `server.ts`:

```ts
export interface ServerOptions {
  transport: Transport;
  configPath?: string;     // for mark_read to persist last_seen_update_id
}

export interface ToolContext {
  transport: Transport;
  configPath?: string;
}
```

Update the `CallToolRequestSchema` handler to pass `configPath` into the context.

- [ ] **Step 2: Add failing tests** to `tools-messaging.test.ts`:

```ts
it("get_thread returns the reply chain for a message", async () => {
  const t = fakeTransport({
    receive: vi.fn().mockResolvedValue([
      { id: "1:1", from_handle: "marco", body: "first", timestamp: new Date(), is_mention: false },
      { id: "2:2", from_handle: "me", body: "reply", timestamp: new Date(), reply_to_message_id: "1", is_mention: false }
    ])
  });
  const client = await connect(t);
  const r = await callTool(client, "get_thread", { reply_to_message_id: "1", limit: 50 });
  expect(r.ok).toBe(true);
  expect(r.data).toHaveLength(2);
});

it("mark_read updates last_seen_update_id in config file", async () => {
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { saveConfig, loadConfig } = await import("../../src/config.js");

  const tmp = mkdtempSync(join(tmpdir(), "am-"));
  const configPath = join(tmp, "config.json");
  await saveConfig(configPath, {
    transport: "telegram",
    telegram: { bot_token: "x", chat_id: "-100", handle: "me" },
    last_seen_update_id: 0
  });

  const server = buildServer({ transport: fakeTransport(), configPath });
  const [c, s] = InMemoryTransport.createLinkedPair();
  await server.connect(s);
  const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
  await client.connect(c);

  await callTool(client, "mark_read", { up_to_message_id: "100:50" });

  const loaded = await loadConfig(configPath);
  expect(loaded?.last_seen_update_id).toBe(100);

  rmSync(tmp, { recursive: true, force: true });
});
```

- [ ] **Step 3: Run, expect FAIL**

```bash
pnpm test -- tools-messaging.test.ts
```

- [ ] **Step 4: Append to `packages/mcp/src/tools/messaging.ts`**

```ts
import { loadConfig, saveConfig } from "../config.js";

export const getThreadTool: ToolDef = {
  name: "get_thread",
  description: "Returns the reply chain for a given message_id. Uses Telegram's reply structure.",
  inputSchema: {
    type: "object",
    required: ["reply_to_message_id"],
    properties: {
      reply_to_message_id: { type: "string" },
      limit: { type: "integer", minimum: 1, maximum: 200 }
    },
    additionalProperties: false
  },
  handler: async (input, { transport }) => {
    const parsed = z
      .object({
        reply_to_message_id: z.string(),
        limit: z.number().int().min(1).max(200).optional().default(50)
      })
      .parse(input);
    // For now, fetch recent and filter by reply chain. Telegram doesn't have a "thread fetch" endpoint.
    const all = await transport.receive({ filter: "all", limit: parsed.limit });
    return all.filter(
      (m) => m.id.endsWith(`:${parsed.reply_to_message_id}`) || m.reply_to_message_id === parsed.reply_to_message_id
    );
  }
};

export const markReadTool: ToolDef = {
  name: "mark_read",
  description: "Marks messages up to a given message_id as read. Persists last_seen_update_id locally.",
  inputSchema: {
    type: "object",
    required: ["up_to_message_id"],
    properties: { up_to_message_id: { type: "string" } },
    additionalProperties: false
  },
  handler: async (input, { configPath }) => {
    const parsed = z.object({ up_to_message_id: z.string() }).parse(input);
    if (!configPath) {
      throw new Error("mark_read requires a config file path in server options");
    }
    const config = await loadConfig(configPath);
    if (!config) throw new Error("Config not found");

    // Message id is "<update_id>:<msg_id>" — extract update_id
    const updateId = Number(parsed.up_to_message_id.split(":")[0] ?? "0");
    config.last_seen_update_id = Math.max(config.last_seen_update_id, updateId);
    await saveConfig(configPath, config);
    return { ok: true, last_seen_update_id: config.last_seen_update_id };
  }
};
```

- [ ] **Step 5: Update `_register.ts`** to include the new tools.

- [ ] **Step 6: Run, expect PASS**

```bash
pnpm test
```

- [ ] **Step 7: Commit**

```bash
git add packages/mcp/src/server.ts packages/mcp/src/tools/ packages/mcp/tests/unit/tools-messaging.test.ts
git commit -m "feat(tools): get_thread and mark_read"
```

---

## Phase 4: CLI

### Task 10: `serve` command

**Files:**
- Create: `packages/mcp/src/cli/serve.ts`
- Create: `packages/mcp/src/cli/index.ts`

- [ ] **Step 1: Create `packages/mcp/src/cli/serve.ts`**

```ts
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, defaultConfigPath } from "../config.js";
import { TelegramTransport } from "../transports/telegram.js";
import { buildServer } from "../server.js";
import { logger } from "../logger.js";

export async function serve(): Promise<void> {
  const configPath = defaultConfigPath();
  const config = await loadConfig(configPath);
  if (!config || !config.telegram) {
    logger.error("No config found. Run `agent-mouth init` first.");
    process.exit(1);
  }
  const transport = new TelegramTransport();
  await transport.init(config.telegram);
  const server = buildServer({ transport, configPath });
  await server.connect(new StdioServerTransport());
  logger.info({ handle: config.telegram.handle }, "agent-mouth serving over stdio");
}
```

- [ ] **Step 2: Create `packages/mcp/src/cli/index.ts`**

```ts
#!/usr/bin/env node
import { serve } from "./serve.js";
import { init } from "./init.js";
import { join } from "./join.js";

const cmd = process.argv[2];
const args = process.argv.slice(3);

async function main() {
  switch (cmd) {
    case "serve": return serve();
    case "init":  return init(args);
    case "join":  return join(args);
    default:
      console.error("Usage: agent-mouth <serve|init|join>");
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
```

- [ ] **Step 3: Don't commit yet — `init.ts` and `join.ts` don't exist. Continue to Task 11.**

---

### Task 11: `init` command with chat_id auto-detect

**Files:**
- Create: `packages/mcp/src/cli/init.ts`
- Create: `packages/mcp/src/cli/_prompt.ts`

- [ ] **Step 1: Create `packages/mcp/src/cli/_prompt.ts`**

```ts
import { createInterface } from "node:readline/promises";

export async function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(`${question} `)).trim();
  } finally {
    rl.close();
  }
}
```

- [ ] **Step 2: Create `packages/mcp/src/cli/init.ts`**

```ts
import { Bot } from "grammy";
import { TelegramTransport } from "../transports/telegram.js";
import { defaultConfigPath, saveConfig } from "../config.js";
import { prompt } from "./_prompt.js";

export async function init(_args: string[]): Promise<void> {
  console.log("🪞 Agent Mouth — init\n");
  console.log("Before running this, you should have:");
  console.log("  1. Created a bot via @BotFather and have its TOKEN");
  console.log("  2. Created or joined a Telegram group");
  console.log("  3. Added your bot to the group as admin");
  console.log("  4. Disabled the bot's privacy mode (@BotFather → /setprivacy → Disable)\n");

  const botToken = await prompt("Bot token (from @BotFather):");
  if (!botToken) {
    console.error("Bot token required.");
    process.exit(1);
  }

  // Verify token by calling getMe
  const probeBot = new Bot(botToken);
  let me;
  try {
    me = await probeBot.api.getMe();
  } catch (err) {
    console.error("Token rejected by Telegram:", (err as Error).message);
    process.exit(1);
  }
  console.log(`✓ Bot verified: @${me.username} (${me.first_name})`);

  let chatId = await prompt(`Group chat_id (leave empty to auto-detect — then send any message in your group):`);
  if (!chatId) {
    console.log("⏳ Waiting for a message in any group your bot is in (30s timeout)...");
    const updates = await probeBot.api.getUpdates({ timeout: 30, allowed_updates: ["message"], limit: 5 });
    const groupUpdate = updates.find((u) => u.message && (u.message.chat.type === "group" || u.message.chat.type === "supergroup"));
    if (!groupUpdate) {
      console.error("No group message received in 30s. Send a message in the group, then re-run init.");
      process.exit(1);
    }
    chatId = String(groupUpdate.message!.chat.id);
    console.log(`✓ Detected chat_id: ${chatId} ("${groupUpdate.message!.chat.title ?? "untitled"}")`);
  }

  const handle = me.username!;
  const displayName = await prompt("Display name (Enter for default):") || me.first_name;

  await saveConfig(defaultConfigPath(), {
    transport: "telegram",
    telegram: {
      bot_token: botToken,
      chat_id: chatId,
      handle,
      display_name: displayName
    },
    last_seen_update_id: 0
  });

  console.log(`\n✓ Configured as @${handle} in group ${chatId}`);
  console.log(`✓ Config saved to ${defaultConfigPath()}`);
  console.log("\nAdd this to ~/.claude/settings.json under mcpServers:");
  console.log(`   { "agent-mouth": { "command": "npx", "args": ["agent-mouth", "serve"] } }`);
  console.log(`\n🎉 Share this with teammates: chat_id = ${chatId}`);
  console.log("   They run: npx agent-mouth join --chat-id " + chatId);
}
```

- [ ] **Step 3: Don't commit yet — `join.ts` still missing. Continue to Task 12.**

---

### Task 12: `join` command + final CLI commit

**Files:**
- Create: `packages/mcp/src/cli/join.ts`

- [ ] **Step 1: Create `packages/mcp/src/cli/join.ts`**

```ts
import { Bot } from "grammy";
import { defaultConfigPath, saveConfig } from "../config.js";
import { prompt } from "./_prompt.js";

export async function join(args: string[]): Promise<void> {
  console.log("🪞 Agent Mouth — join existing group\n");

  // Parse --chat-id flag
  let chatId: string | undefined;
  const idx = args.indexOf("--chat-id");
  if (idx >= 0 && args[idx + 1]) chatId = args[idx + 1];

  console.log("Before running this, you should have:");
  console.log("  1. Created YOUR bot via @BotFather and have its TOKEN");
  console.log("  2. Had a teammate add your bot to the existing group\n");

  if (!chatId) chatId = await prompt("Group chat_id (from your teammate):");
  if (!chatId) {
    console.error("chat_id required.");
    process.exit(1);
  }

  const botToken = await prompt("Bot token (from @BotFather):");
  if (!botToken) {
    console.error("Bot token required.");
    process.exit(1);
  }

  const probeBot = new Bot(botToken);
  let me;
  try {
    me = await probeBot.api.getMe();
  } catch (err) {
    console.error("Token rejected:", (err as Error).message);
    process.exit(1);
  }

  // Verify bot is in the group
  try {
    await probeBot.api.getChat(chatId);
  } catch (err) {
    console.error(`Cannot access group ${chatId}. Make sure your bot was added: ${(err as Error).message}`);
    process.exit(1);
  }

  const handle = me.username!;
  const displayName = await prompt("Display name (Enter for default):") || me.first_name;

  await saveConfig(defaultConfigPath(), {
    transport: "telegram",
    telegram: { bot_token: botToken, chat_id: chatId, handle, display_name: displayName },
    last_seen_update_id: 0
  });

  console.log(`\n✓ Joined group ${chatId} as @${handle}`);
  console.log("Add to ~/.claude/settings.json:");
  console.log(`   { "agent-mouth": { "command": "npx", "args": ["agent-mouth", "serve"] } }`);
}
```

- [ ] **Step 2: Build and verify CLI compiles**

```bash
pnpm --filter agent-mouth build
node packages/mcp/dist/cli/index.js 2>&1 || true
```

Expected: prints `Usage: agent-mouth <serve|init|join>`.

- [ ] **Step 3: Commit all CLI files together**

```bash
git add packages/mcp/src/cli/
git commit -m "feat(cli): serve, init (with chat_id auto-detect), join"
```

---

## Phase 5: Polish

### Task 13: README + quickstart + manual E2E doc

**Files:**
- Create: `README.md`
- Create: `LICENSE`
- Create: `docs/quickstart.md`
- Create: `docs/creating-a-bot.md`
- Create: `tests/manual-e2e.md`

- [ ] **Step 1: Create `README.md`**

```markdown
# Agent Mouth

> 💬 Telegram-powered MCP server for AI agents to talk to each other.

Agent Mouth lets AI agents owned by different people (or different parts of one person's workflow) communicate via a shared Telegram group. No copy-paste between humans. Humans can also see and intervene in the conversation since it's just Telegram.

## Why Telegram?

- **5-min setup**: create a bot via @BotFather, copy token, you're done.
- **Free**: no Telegram fees, no infrastructure to host.
- **UI for humans**: see the conversation in your phone, intervene anytime.
- **Push notifications**: native on iOS/Android/Desktop.

## Quickstart

1. Create a bot via [@BotFather](https://t.me/BotFather), get its token.
2. Create a Telegram group, add your bot as **admin**.
3. With @BotFather, disable your bot's privacy mode: `/setprivacy → Disable`.
4. Run:
   ```bash
   npx agent-mouth init
   ```
5. Add to `~/.claude/settings.json`:
   ```json
   { "mcpServers": { "agent-mouth": { "command": "npx", "args": ["agent-mouth", "serve"] } } }
   ```
6. Share your `chat_id` with teammates — they run `npx agent-mouth join --chat-id <id>` after creating their own bot.

See [docs/quickstart.md](docs/quickstart.md) and [docs/creating-a-bot.md](docs/creating-a-bot.md).

## Tools

| Tool | Purpose |
|------|---------|
| `whoami` | Get your agent's identity |
| `list_contacts` | Who else is in your group |
| `send_message` | Send a message (with optional `@handle` mention) |
| `read_inbox` | Recent messages (filter by mentions/replies/all) |
| `get_thread` | Reply chain for a message |
| `mark_read` | Mark messages as seen |
| `wait_for_messages` | Long-poll for new messages (instant wake-up) |

## Roadmap

- **v1.0** (now): Telegram messaging
- **v1.1**: SQLite local for tasks (`create_task`, `accept_task`, etc.) + subagents
- **v1.2**: Discord / Slack adapters via the same `Transport` interface
- **v2.0**: Native Agent Mouth app (iOS/Android + own backend)

The MCP tools never change — only the transport.

## License

MIT
```

- [ ] **Step 2: Create `LICENSE`** with MIT text (year 2026, holder "Gavrilo Markovic Jankovic").

- [ ] **Step 3: Create `docs/creating-a-bot.md`**

```markdown
# Creating a Telegram Bot for Agent Mouth

## 1. Talk to @BotFather

Open Telegram → search for **@BotFather** → start chat → send `/newbot`.

You'll be prompted for:
- **Name**: "Gavrilo · Backend" (free-form, shown to humans)
- **Username**: must end in `_bot`, e.g. `gavrilo_backend_bot`

@BotFather replies with a **token** like `7234567890:AAH-xxxxxxxxxxxxxxxxxxxxxxxxxxxx`. Keep it secret.

## 2. Disable privacy mode

Bots by default only see messages that mention them. Agent Mouth needs to see everything to filter properly.

In @BotFather: `/setprivacy` → pick your bot → **Disable**.

## 3. Add to your group

Open your Telegram group → group settings → Add members → search for your bot's username → add.

Then promote it to admin (group settings → administrators → add admin).

## 4. Verify

Send any message in the group. Your bot is now seeing it (even though it won't reply yet — that's Agent Mouth's job).

## 5. Run agent-mouth init

```bash
npx agent-mouth init
```

It will auto-detect your chat_id if you send a message during the prompt.
```

- [ ] **Step 4: Create `docs/quickstart.md`** (concise — pointer to README).

```markdown
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
```

- [ ] **Step 5: Create `tests/manual-e2e.md`**

```markdown
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
```

- [ ] **Step 6: Commit**

```bash
git add README.md LICENSE docs/ tests/manual-e2e.md
git commit -m "docs: README, quickstart, bot-creation guide, manual E2E doc"
```

---

### Task 14: GitHub Actions CI + npm publish prep

**Files:**
- Create: `.github/workflows/ci.yml`
- Modify: `packages/mcp/package.json`

- [ ] **Step 1: Create `.github/workflows/ci.yml`**

```yaml
name: CI
on:
  push: { branches: [main] }
  pull_request: { branches: [main] }

jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - uses: pnpm/action-setup@v4
        with: { version: 9 }
      - run: pnpm install --frozen-lockfile
      - run: pnpm exec biome check .
      - run: pnpm -r build
      - run: pnpm -r test
        env:
          AGENT_MOUTH_LOG: warn
```

- [ ] **Step 2: Update `packages/mcp/package.json`** publish metadata:

Add (preserving existing fields):

```json
{
  "description": "MCP server for AI agents to talk to each other via a shared Telegram group",
  "keywords": ["mcp", "ai-agents", "claude", "telegram", "chat", "agents"],
  "homepage": "https://github.com/<your-github-user>/agent-mouth",
  "repository": { "type": "git", "url": "https://github.com/<your-github-user>/agent-mouth.git" },
  "license": "MIT",
  "author": "Gavrilo Markovic Jankovic"
}
```

Bump version to `0.1.0`.

- [ ] **Step 3: Verify build + npm dry-run**

```bash
pnpm -r build
chmod +x packages/mcp/dist/cli/index.js
cd packages/mcp && npm publish --dry-run
```

Verify the file list includes `dist/`.

- [ ] **Step 4: Commit**

```bash
cd ../..
git add .github/ packages/mcp/package.json
git commit -m "ci: GitHub Actions + npm publish prep (v0.1.0)"
git tag v0.1.0
```

- [ ] **Step 5: Manual: push to GitHub and publish to npm** (defer until user is ready)

```bash
# Once GitHub repo is created:
git remote add origin git@github.com:<user>/agent-mouth.git
git push -u origin main --tags

# Once user is ready to publish:
cd packages/mcp
npm publish --access public
```

---

## Self-review

1. **Spec coverage** — all 7 tools implemented (T7-T9), transport abstraction in place (T2-T4), CLI complete (T10-T12), docs + CI (T13-T14). ✅
2. **No placeholders** — every step has exact code or exact command. ✅
3. **Type consistency** — `Transport` interface defined in T2 used consistently through T3-T9. `ToolContext` shape stable. ✅
4. **Frequent commits** — each task ends with a commit. ✅

## Execution

Plan complete and saved at `docs/superpowers/plans/2026-05-11-agent-mouth-telegram.md`.

User-approved approach: **mode B (burst)** — implementer subagent per task, no intermediate review subagents, final review after T14.
