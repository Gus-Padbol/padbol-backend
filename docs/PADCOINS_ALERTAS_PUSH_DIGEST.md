# PadCoins — digest push para Super Admin

PadCoins es moneda de fidelización; **no es dinero** para el jugador.

## Objetivo

Notificar al **Super Admin** por **push (Expo)** cuando hay alertas **críticas** de uso anormal o abusivo de PadCoins.

Este es el **canal recomendado** en esta etapa. Complementa:

- `GET /api/admin/padcoins-alertas` (backend, commit `5424e02`)
- Panel Super Admin “Alertas de uso anormal” (frontend, commit `cb48ea4`)

## Qué envía

| Criterio | Comportamiento |
|----------|----------------|
| Severidad | Solo **alta** (`PADCOINS_ALERTAS_PUSH_MIN_SEVERITY=alta`) |
| Baja / media | **No** se envían |
| `campania_identificada` | **No** (severidad baja; informativa en panel) |
| Formato | **Un digest** por corrida cron |
| Máximo resumido | **5 tipos** en metadata; body indica total |
| Sin alertas altas | **No envía nada** |
| Sin tokens push | Log + skip; **no rompe** backend |

## Variables de entorno

| Variable | Requerida | Default | Descripción |
|----------|-----------|---------|-------------|
| `PADCOINS_ALERTAS_PUSH_ENABLED` | Sí (para enviar) | `false` | `true` / `1` / `yes` |
| `PADCOINS_ALERTAS_PUSH_MIN_SEVERITY` | No | `alta` | Mínimo a enviar (v1: solo `alta`) |
| `PADCOINS_ALERTAS_PUSH_DEDUPE_HOURS` | No | `24` | Anti-spam por alerta |
| `PADCOINS_ALERTAS_PANEL_URL` | No | URL admin genérica | Deep link / web panel |
| `PADCOINS_ALERTAS_DIGEST_CRON` | No | `0 */12 * * *` | Compartido con WhatsApp digest |

Sin `PADCOINS_ALERTAS_PUSH_ENABLED=true`, el cron corre pero **no envía push**.

## Destinatarios

1. Usuarios con `role = super_admin` en `user_roles`.
2. Emails legacy de Super Admin (`LEGACY_SUPER_ADMIN_EMAILS_API` en `server.js`) resueltos vía `jugadores_perfil`.
3. Tokens desde `push_tokens` + fallback `jugadores_perfil.expo_push_token`.

Si ningún Super Admin tiene token registrado:

```
⚠️ PadCoins alertas push digest — sin tokens push Super Admin
```

## Payload push

**Título:** `PadCoins: alerta crítica`

**Body (ejemplo):**  
`3 alertas críticas detectadas en Beneficios Padbol. Revisá el panel Super Admin.`

**Data:**

```json
{
  "type": "padcoins_alertas",
  "severity": "alta",
  "screen": "admin_padcoins_alertas",
  "url": "https://…",
  "alert_count": "3",
  "alert_types": "ajustes_manuales_excesivos,canjes_sospechosos"
}
```

La app nativa puede usar `screen` / `url` para deep link (implementación en app — fuera de scope backend).

## Dedupe (Fase 1)

- Hash: `{sede_id}:{tipo_alerta}`
- Memoria en proceso durante `PADCOINS_ALERTAS_PUSH_DEDUPE_HOURS`
- Independiente del dedupe WhatsApp

**Fase 2:** tabla persistente `padcoins_alertas_envios`.

## Cron

`src/cron/padcoinsAlertasCron.js` evalúa alertas **una sola vez** y despacha:

- **Push** si `PADCOINS_ALERTAS_PUSH_ENABLED=true`
- **WhatsApp** si `PADCOINS_ALERTAS_WHATSAPP_ENABLED=true` (opcional, ver doc WhatsApp)

Log activo:

```
⏰ Cron PadCoins alertas digest registrado (0 */12 * * *) — canales: push
```

Log desactivado:

```
⏰ Cron PadCoins alertas digest registrado (0 */12 * * *) — desactivado (push/WhatsApp off)
```

## Implementación

| Archivo | Rol |
|---------|-----|
| `src/padcoins/padcoinsAlertasPushDigestService.js` | Push digest |
| `src/cron/padcoinsAlertasCron.js` | Orquestación cron |
| `utils/push.js` | Expo send |

## Tests

`lib/padcoinsAlertasPushDigest.test.js`

## Canales

| Canal | Estado |
|-------|--------|
| **Push Expo** | **Recomendado** — activar con env |
| WhatsApp Twilio | Opcional / no recomendado — ver `docs/PADCOINS_ALERTAS_WHATSAPP_DIGEST.md` |
| Email | **Fase futura** — no hay proveedor transaccional en backend |

## Relacionado

- `docs/PADCOINS_ALERTAS_SUPERADMIN.md`
- `docs/PADCOINS_ALERTAS_WHATSAPP_DIGEST.md`
