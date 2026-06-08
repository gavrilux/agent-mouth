import type { IncomingMessage, ServerResponse } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
    writeHead(s: number) {
      status = s;
      return r;
    },
    end(b?: string) {
      if (b) body = b;
    },
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
    const data = Buffer.from(
      JSON.stringify({ emailAddress: "gavrilux.agent@gmail.com", historyId: "100" }),
      "utf8",
    ).toString("base64");
    const { res, status } = mockRes();
    await handleEmailWebhook(
      mockReq(
        { message: { data, messageId: "1" }, subscription: "s" },
        { authorization: "Bearer fake.jwt.token" },
      ),
      res,
      {
        verifyJwt: verifyJwt as never,
        webhookEventsStore: { recordOnce } as never,
        queueEnqueue: enqueue as never,
        config: {
          audience: "https://agent-mouth.fly.dev/email-webhook",
          serviceAccountEmail: "sa@p.iam.gserviceaccount.com",
        },
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
    const data = Buffer.from(
      JSON.stringify({ emailAddress: "x@x.com", historyId: "100" }),
      "utf8",
    ).toString("base64");
    const { res, status } = mockRes();
    await handleEmailWebhook(
      mockReq({ message: { data, messageId: "1" } }, { authorization: "Bearer fake.jwt" }),
      res,
      {
        verifyJwt: verifyJwt as never,
        webhookEventsStore: { recordOnce } as never,
        queueEnqueue: enqueue as never,
        config: {
          audience: "https://agent-mouth.fly.dev/email-webhook",
          serviceAccountEmail: "sa@p.iam.gserviceaccount.com",
        },
      },
    );
    expect(status()).toBe(200);
    expect(enqueue).not.toHaveBeenCalled();
  });

  it("returns 401 on invalid JWT", async () => {
    verifyJwt = vi.fn(async () => {
      throw new Error("bad jwt");
    });
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
      mockReq({ message: { data: "x", messageId: "1" } }), // no authorization
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
