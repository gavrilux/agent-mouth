// packages/api/tests/watchdog/whatsapp-inbound.test.ts
import { describe, expect, it, vi } from "vitest";
import { checkWhatsAppInbound } from "../../src/watchdog/checks/whatsapp-inbound.js";

const base = { graphVersion: "v21.0", phoneNumberId: "123", accessToken: "tok" };

describe("checkWhatsAppInbound", () => {
  it("ok (omitido) cuando está deshabilitado, sin llamar a fetch", async () => {
    const fetchFn = vi.fn() as never;
    const r = await checkWhatsAppInbound({ enabled: false, ...base, fetchFn });
    expect(r.status).toBe("ok");
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("ok cuando Graph API responde 200", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ id: "123" }),
    })) as never;
    const r = await checkWhatsAppInbound({ enabled: true, ...base, fetchFn });
    expect(r.status).toBe("ok");
  });

  it("down cuando Graph API no es 200", async () => {
    const fetchFn = vi.fn(async () => ({
      ok: false,
      status: 401,
      json: async () => ({}),
    })) as never;
    const r = await checkWhatsAppInbound({ enabled: true, ...base, fetchFn });
    expect(r.status).toBe("down");
  });
});
