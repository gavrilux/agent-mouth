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
