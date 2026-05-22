import { describe, it, expect } from "vitest";
import { PgBossQueue } from "../src/pgboss-queue.js";

const SKIP = !process.env.DATABASE_URL;

describe.skipIf(SKIP)("PgBossQueue", () => {
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
