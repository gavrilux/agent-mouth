import { describe, it, expect, vi } from "vitest";
import PgBoss from "pg-boss";
import { PgBossQueue } from "../src/pgboss-queue.js";

const SKIP = !process.env.DATABASE_URL;

describe.skipIf(SKIP)("PgBossQueue — integration", () => {
  it("starts, sends a job, processes it, and stops", async () => {
    const q = new PgBossQueue({ connectionString: process.env.DATABASE_URL! });
    await q.start();

    let received: { x: number } | null = null;
    await q.work<{ x: number }>("test.echo", async (data) => {
      received = data;
    });

    await q.send("test.echo", { x: 42 });

    for (let i = 0; i < 50 && received === null; i++) {
      await new Promise((r) => setTimeout(r, 100));
    }
    expect(received).toEqual({ x: 42 });

    await q.stop();
  }, 15_000);
});

describe("PgBossQueue.scheduleRecurring — unit", () => {
  it("calls createQueue then schedule on the underlying boss instance", async () => {
    const createQueue = vi.fn().mockResolvedValue(undefined);
    const schedule = vi.fn().mockResolvedValue(undefined);

    const q = new PgBossQueue({ connectionString: "postgres://test:test@localhost/test" });
    // Patch the private boss instance directly to avoid a live DB connection
    const boss = (q as unknown as { boss: Record<string, unknown> }).boss;
    boss.createQueue = createQueue;
    boss.schedule = schedule;

    await q.scheduleRecurring("knowledge.sync", "*/15 * * * *", {});

    expect(createQueue).toHaveBeenCalledWith("knowledge.sync");
    expect(schedule).toHaveBeenCalledWith("knowledge.sync", "*/15 * * * *", {});
  });
});
