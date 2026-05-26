import { afterEach, describe, expect, it, vi } from "vitest";
import { GmailDriver } from "../src/drivers/gmail-driver.js";

const origFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = origFetch; });

const refresh = "1//abc_refresh";
const accessToken = "ya29.fresh";

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
