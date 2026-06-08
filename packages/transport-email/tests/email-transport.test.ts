import { describe, expect, it, vi } from "vitest";
import type { EmailDriver } from "../src/drivers/driver.js";
import { EmailTransport } from "../src/email-transport.js";

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
    expect(driver.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ subject: "Re: hello", body_text: "Hi" }),
      }),
    );
  });

  it("send defaults subject to '(no subject)' when missing", async () => {
    const driver = makeFakeDriver();
    const t = new EmailTransport({
      driver,
      auth: { refresh_token: "x", email_address: "gavrilux.agent@gmail.com" },
    });
    await t.send({ to: "marco@thecuina.com", body: "Hi" });
    expect(driver.send).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({ subject: "(no subject)" }),
      }),
    );
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
