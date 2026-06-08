// packages/api/src/watchdog/checks/whatsapp-inbound.ts
import type { CheckResult } from "../types.js";

export interface WhatsAppInboundCheckDeps {
  enabled: boolean;
  graphVersion: string;
  phoneNumberId: string;
  accessToken: string;
  fetchFn?: typeof fetch;
}

const ID = "whatsapp-inbound";

export async function checkWhatsAppInbound(deps: WhatsAppInboundCheckDeps): Promise<CheckResult> {
  if (!deps.enabled) {
    return { id: ID, status: "ok", message: "deshabilitado (omitido)" };
  }
  const f = deps.fetchFn ?? fetch;
  const url = `https://graph.facebook.com/${deps.graphVersion}/${deps.phoneNumberId}?fields=id`;
  try {
    const res = await f(url, { headers: { Authorization: `Bearer ${deps.accessToken}` } });
    if (!res.ok) {
      return { id: ID, status: "down", message: `whatsapp Graph API HTTP ${res.status}`, action: "Revisa WHATSAPP_ACCESS_TOKEN / número." };
    }
    return { id: ID, status: "ok", message: "ok" };
  } catch (err) {
    return { id: ID, status: "down", message: `whatsapp Graph API falló: ${String(err)}`, action: "Revisa WHATSAPP_ACCESS_TOKEN / número." };
  }
}
