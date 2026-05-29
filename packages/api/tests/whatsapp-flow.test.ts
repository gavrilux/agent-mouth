import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
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
  const origAuto = process.env.ENABLE_WHATSAPP_AUTO;
  const origList = process.env.WHATSAPP_ALLOWLIST;

  beforeAll(async () => {
    channelId = await ensureWhatsappChannel();
    process.env.ENABLE_WHATSAPP_AUTO = "true";
  });

  afterEach(() => {
    process.env.ENABLE_WHATSAPP_AUTO = origAuto;
    process.env.WHATSAPP_ALLOWLIST = origList;
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
    const rawBody = JSON.stringify(webhook);
    const sig = `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
    expect(verifyMetaSignature(rawBody, sig, APP_SECRET)).toBe(true);
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
    const rawBody = JSON.stringify(webhook);
    const sig = `sha256=${createHmac("sha256", APP_SECRET).update(rawBody, "utf8").digest("hex")}`;
    expect(verifyMetaSignature(rawBody, sig, APP_SECRET)).toBe(true);
    const inbound = whatsappMessageToInbound(webhook.entry[0]!.changes[0]!.value, channelId)[0]!;
    const parsed = InboundMessageSchema.parse(inbound);

    const result = await processInbound(parsed, makeRouterDeps());
    if (result.kind !== "persisted") throw new Error("expected persisted");
    expect(result.policy).toBe("silent");
    expect(result.messageId).toBeTruthy(); // persisted even though silent
  });
});
