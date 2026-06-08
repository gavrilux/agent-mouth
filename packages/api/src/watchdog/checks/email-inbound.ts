// packages/api/src/watchdog/checks/email-inbound.ts
import type { SupabaseEmailTokenStore } from "@agent-mouth/storage-supabase";
import type { CheckResult } from "../types.js";

export interface EmailInboundCheckDeps {
  tokenStore: Pick<SupabaseEmailTokenStore, "list">;
  workspaceId: string;
  /** {PUBLIC_BASE_URL}/email-oauth-start?token=<AGENT_MOUTH_AUTH_TOKEN> */
  reauthUrl: string;
  /** Margen proactivo en ms (WATCHDOG_EMAIL_EXPIRY_MARGIN_HOURS * 3_600_000). */
  expiryMarginMs: number;
  now: () => Date;
}

const ID = "email-inbound";

export async function checkEmailInbound(deps: EmailInboundCheckDeps): Promise<CheckResult> {
  const tokens = await deps.tokenStore.list(deps.workspaceId);
  if (tokens.length === 0) {
    return { id: ID, status: "down", message: "email sin token configurado", action: deps.reauthUrl };
  }
  const tok = tokens[0] as {
    status: string;
    watch_expiration: string | null;
    consecutive_renewal_failures: number;
    last_error: string | null;
  };
  if (tok.status !== "active") {
    const suffix = tok.last_error ? ` (${tok.last_error})` : "";
    return { id: ID, status: "down", message: `email status=${tok.status}${suffix}`, action: deps.reauthUrl };
  }
  if (tok.consecutive_renewal_failures >= 1) {
    return { id: ID, status: "down", message: `email: ${tok.consecutive_renewal_failures} fallo(s) de renovación del watch`, action: deps.reauthUrl };
  }
  if (tok.watch_expiration) {
    const expMs = new Date(tok.watch_expiration).getTime();
    const nowMs = deps.now().getTime();
    if (expMs < nowMs + deps.expiryMarginMs) {
      const hours = Math.max(0, Math.round((expMs - nowMs) / 3_600_000));
      return { id: ID, status: "down", message: `email: watch expira en ~${hours}h`, action: deps.reauthUrl };
    }
  }
  return { id: ID, status: "ok", message: "ok" };
}
