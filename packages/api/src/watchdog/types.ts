// packages/api/src/watchdog/types.ts

export type CheckStatus = "ok" | "warn" | "down";

/** Resultado de un check individual del watchdog. */
export interface CheckResult {
  id: string;
  status: CheckStatus;
  message: string;
  /** Acción sugerida para el humano (link, instrucción). Opcional. */
  action?: string;
}

/** Estado persistido por check, para anti-spam. Fechas en ISO 8601 o null. */
export interface WatchdogStateRow {
  check_id: string;
  status: CheckStatus;
  first_seen_at: string | null;
  last_alerted_at: string | null;
}

/** Almacén del estado anti-spam. La impl real (Postgres) vive en state.ts. */
export interface WatchdogStateStore {
  load(): Promise<WatchdogStateRow[]>;
  upsert(row: WatchdogStateRow): Promise<void>;
}
