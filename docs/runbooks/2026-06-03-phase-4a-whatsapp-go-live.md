# Runbook — Phase 4a WhatsApp go-live (Meta Cloud API)

**When to use:** Activar el transport de WhatsApp (Phase 4a). El **código ya está vivo en
producción** (Fly `agent-mouth`, deploy 2026-06-03) pero **inerte**: `/whatsapp-webhook`
devuelve `503 "whatsapp transport not configured"` hasta que se setean los secrets.
Esto cubre el provisioning manual en Meta (decision D del spec, diferido) + la activación.

Spec: `docs/superpowers/specs/2026-05-28-agent-mouth-phase-4a-whatsapp-design.md` (§8.2).

---

## Estado de partida (ya hecho)
- ✅ Paquete `@agent-mouth/transport-whatsapp` + webhook GET/POST + allow-list + kill switch.
- ✅ Dockerfile incluye el paquete (fix `a2f09fd`) → la imagen de prod ya lo trae.
- ✅ Desplegado e inerte detrás de `ENABLE_WHATSAPP_TRANSPORT` (503 hasta configurar).
- ✅ Cero impacto en Telegram/Email.

---

## Parte A — Provisioning en Meta (lo hace Gavrilo, ~30-45 min, una vez)

> Objetivo: conseguir 4 valores → `WHATSAPP_PHONE_NUMBER_ID`, `WHATSAPP_ACCESS_TOKEN`
> (permanente), `WHATSAPP_APP_SECRET`, y elegir un `WHATSAPP_VERIFY_TOKEN` (string a tu gusto).

1. **Business Portfolio** — <https://business.facebook.com> → si no tienes, crea uno
   (puede ser el de AGENTIKO). Es el contenedor de la WABA.

2. **Crear App** — <https://developers.facebook.com> → *My Apps* → *Create App* →
   tipo **Business** → nombre (p.ej. `agent-mouth-whatsapp`) → vincula al Business Portfolio.

3. **Añadir producto WhatsApp** — en la App → *Add product* → **WhatsApp** → *Set up*.
   Esto crea/enlaza una **WhatsApp Business Account (WABA)** y te da un **número de test gratis**.

4. **API Setup** (App → WhatsApp → *API Setup*):
   - Copia el **`Phone number ID`** → `WHATSAPP_PHONE_NUMBER_ID`.
   - Hay un **token temporal (24h)** para probar; para producción usa el permanente (paso 6).

5. **App Secret** — App → *Settings* → *Basic* → **App Secret** → *Show* →
   `WHATSAPP_APP_SECRET` (se usa para verificar la firma `X-Hub-Signature-256`).

6. **Token permanente (System User)** — *Business Settings* → *Users* → *System Users* →
   *Add* (rol Admin) → *Generate new token* → selecciona la App → permisos
   **`whatsapp_business_messaging`** + **`whatsapp_business_management`** → genera.
   Ese es `WHATSAPP_ACCESS_TOKEN` (permanente, sin caducidad de 24h). **Guárdalo, solo se ve una vez.**

7. **Número dedicado** (para producción, no el de test):
   - App → WhatsApp → *API Setup* → *Add phone number* → un número que **NO esté en una
     app de WhatsApp personal** (móvil nuevo, fijo que reciba SMS/llamada, o VoIP verificable).
   - Para el **Gate** inicial puedes usar el número de test (solo puede escribir a destinatarios
     pre-verificados que añadas en API Setup → "To").

8. **Verify token** — un string aleatorio que **eliges tú** (p.ej. `am-wa-7f3k...`). No te lo da
   Meta; lo pones igual en Fly (paso B) y en el webhook de Meta (paso C). → `WHATSAPP_VERIFY_TOKEN`.

---

## Parte B — Setear secrets en Fly (lo hace Claude, cuando Gavrilo dé los valores)

> ⚠️ Orden importante: los secrets (incl. verify token + `ENABLE_WHATSAPP_TRANSPORT=true`)
> van **antes** de configurar el webhook en Meta, porque el handshake GET de Meta solo
> responde el challenge si el verify token ya está vivo en el server (`serve-http.ts:445`).

```bash
flyctl secrets set \
  WHATSAPP_PHONE_NUMBER_ID="<phone_number_id>" \
  WHATSAPP_ACCESS_TOKEN="<system_user_token>" \
  WHATSAPP_APP_SECRET="<app_secret>" \
  WHATSAPP_VERIFY_TOKEN="<el_string_elegido>" \
  WHATSAPP_GRAPH_VERSION="v21.0" \
  ENABLE_WHATSAPP_TRANSPORT="true" \
  ENABLE_WHATSAPP_AUTO="false" \
  WHATSAPP_ALLOWLIST="<tu_numero_en_digitos_sin_+>" \
  --app agent-mouth
# setear secrets dispara redeploy automático
```

Verificar tras el redeploy:
```bash
# El handshake ahora debe devolver el challenge (no 503):
curl -s "https://agent-mouth.fly.dev/whatsapp-webhook?hub.mode=subscribe&hub.verify_token=<verify>&hub.challenge=hello123"
# → hello123
flyctl logs --app agent-mouth | grep -i "whatsapp transport bootstrapped"
```

---

## Parte C — Configurar el webhook en Meta (lo hace Gavrilo)

App → WhatsApp → *Configuration* → *Webhook* → *Edit*:
- **Callback URL:** `https://agent-mouth.fly.dev/whatsapp-webhook`
- **Verify token:** el mismo `WHATSAPP_VERIFY_TOKEN` de la Parte B.
- *Verify and save* → Meta hace el GET handshake → debe pasar (✓ verde).
- **Subscribe** al campo **`messages`** (Webhook fields → `messages` → Subscribe).

---

## Parte D — Gate 4a (end-to-end)

1. Desde un número **allow-listed**, escribe al número de WhatsApp del agente:
   `"phase-4a gate test, responde 'gate ok'"`.
2. En ≤60s debe llegar la respuesta del agente con "gate ok".
   - Logs: `flyctl logs --app agent-mouth | grep -i whatsapp` → "whatsapp message received".
3. `read_inbox` desde Claude Code muestra Telegram + Email + WhatsApp mezclados por timestamp.
4. Un número **NO** allow-listed que escriba → se persiste, **sin** respuesta (silent).
5. Activar auto-reply para todos los allow-listed (ya estaba en `false` para el Gate):
   ```bash
   flyctl secrets set ENABLE_WHATSAPP_AUTO="true" --app agent-mouth
   ```

---

## Rollback
| Síntoma | Acción |
|---|---|
| El agente responde mal en WhatsApp | `flyctl secrets set ENABLE_WHATSAPP_AUTO=false --app agent-mouth` (silent) |
| Cualquier problema con WhatsApp | `flyctl secrets set ENABLE_WHATSAPP_TRANSPORT=false --app agent-mouth` (webhook → 503) |

Ambos disparan redeploy y dejan Telegram/Email intactos.

---

## Notas
- **Coste:** hosting Meta gratis; mensajería = pricing por conversación 24h (varía por país;
  las *service conversations* tienen tier mensual gratis). Reactivo + allow-list ⇒ volumen bajo.
- **Reactivo only:** el agente solo responde dentro de la ventana de 24h; no inicia conversaciones
  ni usa plantillas (fuera de alcance de Phase 4a).
- **Solo texto** en v1 (sin media).
- El token de WhatsApp es independiente del de Telegram — no se comparten.
