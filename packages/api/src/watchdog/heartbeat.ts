// packages/api/src/watchdog/heartbeat.ts
import { logger } from "../logger.js";

export interface HeartbeatDeps {
  url?: string;
  fetchFn?: typeof fetch;
}

/** Liveness ping. true si se envió, false si se omitió o falló (nunca lanza). */
export async function sendHeartbeat(deps: HeartbeatDeps): Promise<boolean> {
  if (!deps.url) {
    logger.debug("watchdog: HEALTHCHECKS_URL no configurado — heartbeat omitido");
    return false;
  }
  const f = deps.fetchFn ?? fetch;
  try {
    await f(deps.url);
    return true;
  } catch (err) {
    logger.error({ err: String(err) }, "watchdog: heartbeat falló");
    return false;
  }
}
