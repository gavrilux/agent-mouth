// packages/api/tests/watchdog/reporter.test.ts
import { describe, expect, it, vi } from "vitest";
import { reportSweep } from "../../src/watchdog/reporter.js";
import type { CheckResult, WatchdogStateRow } from "../../src/watchdog/types.js";

const T0 = "2026-06-05T00:00:00.000Z";
const at = (iso: string) => () => new Date(iso);

function makeDeps(prev: WatchdogStateRow[], nowIso: string) {
  const upsert = vi.fn(async () => {});
  const send = vi.fn(async () => ({ message_id: "1", timestamp: new Date(nowIso) }));
  return {
    deps: {
      stateStore: { load: vi.fn(async () => prev), upsert },
      transport: { send },
      alertChatId: "618021852",
      now: at(nowIso),
    },
    upsert,
    send,
  };
}

const down = (id: string): CheckResult => ({
  id,
  status: "down",
  message: `${id} caído`,
  action: "fix",
});
const ok = (id: string): CheckResult => ({ id, status: "ok", message: "ok" });

describe("reportSweep", () => {
  it("no envía nada cuando todo ok y no había estado malo", async () => {
    const { deps, send, upsert } = makeDeps([], T0);
    const body = await reportSweep([ok("email-inbound")], deps as never);
    expect(body).toBeNull();
    expect(send).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith({
      check_id: "email-inbound",
      status: "ok",
      first_seen_at: null,
      last_alerted_at: null,
    });
  });

  it("alerta en la transición ok→down y guarda first_seen + last_alerted", async () => {
    const { deps, send, upsert } = makeDeps([], T0);
    const body = await reportSweep([down("email-inbound")], deps as never);
    expect(send).toHaveBeenCalledTimes(1);
    expect(body).toContain("email-inbound caído");
    expect(upsert).toHaveBeenCalledWith({
      check_id: "email-inbound",
      status: "down",
      first_seen_at: T0,
      last_alerted_at: T0,
    });
  });

  it("NO re-alerta si sigue down dentro de 24h", async () => {
    const prev: WatchdogStateRow[] = [
      { check_id: "email-inbound", status: "down", first_seen_at: T0, last_alerted_at: T0 },
    ];
    const { deps, send } = makeDeps(prev, "2026-06-05T06:00:00.000Z"); // +6h
    const body = await reportSweep([down("email-inbound")], deps as never);
    expect(send).not.toHaveBeenCalled();
    expect(body).toBeNull();
  });

  it("recuerda si sigue down pasadas 24h", async () => {
    const prev: WatchdogStateRow[] = [
      { check_id: "email-inbound", status: "down", first_seen_at: T0, last_alerted_at: T0 },
    ];
    const { deps, send } = makeDeps(prev, "2026-06-06T01:00:00.000Z"); // +25h
    await reportSweep([down("email-inbound")], deps as never);
    expect(send).toHaveBeenCalledTimes(1);
  });

  it("avisa de recuperación en down→ok una sola vez", async () => {
    const prev: WatchdogStateRow[] = [
      { check_id: "email-inbound", status: "down", first_seen_at: T0, last_alerted_at: T0 },
    ];
    const { deps, send, upsert } = makeDeps(prev, "2026-06-05T06:00:00.000Z");
    const body = await reportSweep([ok("email-inbound")], deps as never);
    expect(send).toHaveBeenCalledTimes(1);
    expect(body).toContain("Recuperado");
    expect(upsert).toHaveBeenCalledWith({
      check_id: "email-inbound",
      status: "ok",
      first_seen_at: null,
      last_alerted_at: null,
    });
  });

  it("alerta en escalación warn→down dentro de la ventana de 24h", async () => {
    const prev: WatchdogStateRow[] = [
      { check_id: "daily-spend", status: "warn", first_seen_at: T0, last_alerted_at: T0 },
    ];
    const { deps, send } = makeDeps(prev, "2026-06-05T06:00:00.000Z"); // +6h, < 24h
    await reportSweep(
      [{ id: "daily-spend", status: "down", message: "gasto al 120%" }],
      deps as never,
    );
    expect(send).toHaveBeenCalledTimes(1);
  });
});
