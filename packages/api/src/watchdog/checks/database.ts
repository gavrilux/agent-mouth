// packages/api/src/watchdog/checks/database.ts
import { Client as PgClient } from "pg";
import type { CheckResult } from "../types.js";

interface MinimalPgClient {
  connect(): Promise<void>;
  query(sql: string): Promise<unknown>;
  end(): Promise<void>;
}

export interface DatabaseCheckDeps {
  databaseUrl: string;
  timeoutMs?: number;
  /** Inyectable para tests; por defecto crea un Client real de `pg`. */
  clientFactory?: (cfg: { connectionString: string; connectionTimeoutMillis: number }) => MinimalPgClient;
}

const ID = "database";

export async function checkDatabase(deps: DatabaseCheckDeps): Promise<CheckResult> {
  const timeout = deps.timeoutMs ?? 5000;
  const make = deps.clientFactory ?? ((cfg) => new PgClient(cfg) as unknown as MinimalPgClient);
  const client = make({ connectionString: deps.databaseUrl, connectionTimeoutMillis: timeout });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return { id: ID, status: "ok", message: "ok" };
  } catch (err) {
    return { id: ID, status: "down", message: `DB no responde: ${String(err)}`, action: "Revisa Supabase / DATABASE_URL." };
  } finally {
    await client.end().catch(() => {});
  }
}
