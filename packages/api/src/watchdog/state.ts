// packages/api/src/watchdog/state.ts
import { Client as PgClient } from "pg";
import type { WatchdogStateRow, WatchdogStateStore } from "./types.js";

export class PgWatchdogStateStore implements WatchdogStateStore {
  constructor(private readonly connectionString: string) {}

  async load(): Promise<WatchdogStateRow[]> {
    const pg = new PgClient({
      connectionString: this.connectionString,
      connectionTimeoutMillis: 10_000,
    });
    try {
      await pg.connect();
      const res = await pg.query(
        "SELECT check_id, status, first_seen_at, last_alerted_at FROM watchdog_alerts",
      );
      return res.rows.map((r: Record<string, unknown>) => ({
        check_id: String(r.check_id),
        status: r.status as WatchdogStateRow["status"],
        first_seen_at: r.first_seen_at ? new Date(r.first_seen_at as string).toISOString() : null,
        last_alerted_at: r.last_alerted_at
          ? new Date(r.last_alerted_at as string).toISOString()
          : null,
      }));
    } finally {
      await pg.end().catch(() => {});
    }
  }

  async upsert(row: WatchdogStateRow): Promise<void> {
    const pg = new PgClient({
      connectionString: this.connectionString,
      connectionTimeoutMillis: 10_000,
    });
    try {
      await pg.connect();
      await pg.query(
        `INSERT INTO watchdog_alerts (check_id, status, first_seen_at, last_alerted_at, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (check_id) DO UPDATE SET
           status = EXCLUDED.status,
           first_seen_at = EXCLUDED.first_seen_at,
           last_alerted_at = EXCLUDED.last_alerted_at,
           updated_at = now()`,
        [row.check_id, row.status, row.first_seen_at, row.last_alerted_at],
      );
    } finally {
      await pg.end().catch(() => {});
    }
  }
}
