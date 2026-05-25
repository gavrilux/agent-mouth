import PgBoss from "pg-boss";
import type { JobQueue } from "@agent-mouth/core";

export interface PgBossQueueOptions {
  connectionString: string;
  schema?: string;
}

export class PgBossQueue implements JobQueue {
  private boss: PgBoss;

  constructor(opts: PgBossQueueOptions) {
    this.boss = new PgBoss({
      connectionString: opts.connectionString,
      schema: opts.schema ?? "pgboss",
    });
  }

  async start(): Promise<void> {
    await this.boss.start();
  }

  async stop(): Promise<void> {
    await this.boss.stop({ graceful: true, timeout: 5000 });
  }

  async send<T>(name: string, data: T, options?: { singletonKey?: string }): Promise<string | null> {
    await this.boss.createQueue(name);
    return await this.boss.send(name, data as object, {
      singletonKey: options?.singletonKey,
    });
  }

  async work<T>(name: string, handler: (data: T) => Promise<void>): Promise<void> {
    await this.boss.createQueue(name);
    await this.boss.work<T>(name, async (jobs) => {
      const arr = Array.isArray(jobs) ? jobs : [jobs];
      for (const j of arr) {
        await handler(j.data);
      }
    });
  }

  async scheduleRecurring(
    name: string,
    cron: string,
    data: object,
    options?: { singletonKey?: string },
  ): Promise<void> {
    await this.boss.createQueue(name);
    // pg-boss: schedule(name, cron, data?, options?). singletonKey deduplicates
    // overlapping runs so a long-running tick doesn't race with the next one.
    await this.boss.schedule(name, cron, data, {
      singletonKey: options?.singletonKey,
    });
  }
}
