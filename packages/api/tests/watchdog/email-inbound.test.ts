// packages/api/tests/watchdog/email-inbound.test.ts
import { describe, expect, it, vi } from "vitest";
import { checkEmailInbound } from "../../src/watchdog/checks/email-inbound.js";

const REAUTH = "https://agent-mouth.fly.dev/email-oauth-start?token=t";
const MARGIN = 24 * 3_600_000;
const now = () => new Date("2026-06-05T00:00:00.000Z");
const baseTok = {
  id: "1",
  email_address: "a@b.com",
  status: "active",
  watch_expiration: "2026-12-01T00:00:00.000Z",
  consecutive_renewal_failures: 0,
  last_error: null,
};
const store = (toks: unknown[]) => ({ list: vi.fn(async () => toks) }) as never;

describe("checkEmailInbound", () => {
  it("ok cuando activo, lejos de expirar y sin fallos", async () => {
    const r = await checkEmailInbound({
      tokenStore: store([baseTok]),
      workspaceId: "w",
      reauthUrl: REAUTH,
      expiryMarginMs: MARGIN,
      now,
    });
    expect(r.status).toBe("ok");
  });

  it("down sin token, con el link de re-auth", async () => {
    const r = await checkEmailInbound({
      tokenStore: store([]),
      workspaceId: "w",
      reauthUrl: REAUTH,
      expiryMarginMs: MARGIN,
      now,
    });
    expect(r.status).toBe("down");
    expect(r.action).toBe(REAUTH);
  });

  it("down cuando status != active", async () => {
    const r = await checkEmailInbound({
      tokenStore: store([{ ...baseTok, status: "error", last_error: "revoked" }]),
      workspaceId: "w",
      reauthUrl: REAUTH,
      expiryMarginMs: MARGIN,
      now,
    });
    expect(r.status).toBe("down");
    expect(r.action).toBe(REAUTH);
  });

  it("down con fallos de renovación", async () => {
    const r = await checkEmailInbound({
      tokenStore: store([{ ...baseTok, consecutive_renewal_failures: 2 }]),
      workspaceId: "w",
      reauthUrl: REAUTH,
      expiryMarginMs: MARGIN,
      now,
    });
    expect(r.status).toBe("down");
  });

  it("down (proactivo) cuando el watch expira dentro del margen", async () => {
    const r = await checkEmailInbound({
      tokenStore: store([{ ...baseTok, watch_expiration: "2026-06-05T18:00:00.000Z" }]),
      workspaceId: "w",
      reauthUrl: REAUTH,
      expiryMarginMs: MARGIN,
      now,
    });
    expect(r.status).toBe("down");
  });
});
