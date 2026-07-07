# PadCoins — digest WhatsApp para Super Admin

> **Estado:** canal **opcional / no recomendado** en esta etapa.  
> **Canal recomendado:** push Expo — ver `docs/PADCOINS_ALERTAS_PUSH_DIGEST.md`.  
> **Email:** fase futura (no hay proveedor transaccional implementado en backend).

PadCoins es moneda de fidelización; **no es dinero** para el jugador.

## Objetivo

Notificar al **Super Admin** por WhatsApp cuando hay **alertas críticas** de uso anormal o abusivo de PadCoins, sin reemplazar el panel web ni convertir al Super Admin en operador de reclamos diarios de sede.

El digest complementa `GET /api/admin/padcoins-alertas` (commit `5424e02`) y el panel Super Admin (frontend `cb48ea4`).

## Qué envía

| Criterio | Comportamiento |
|----------|----------------|
| Severidad | Solo **alta** |
| Baja / media | **No** se envían por WhatsApp |
| `campania_identificada` | **No** (severidad baja por diseño; informativa en panel) |
| Formato | **Un digest** por corrida, no un mensaje por movimiento |
| Máximo en mensaje | **5 alertas** + contador si hay más |
| Sin alertas altas | **No envía nada** |

## Variables de entorno

| Variable | Requerida | Default | Descripción |
|----------|-----------|---------|-------------|
| `PADCOINS_ALERTAS_WHATSAPP_ENABLED` | Sí (para enviar) | **`false`** | `true` / `1` / `yes` activa envío |
| `PADCOINS_ALERTAS_WHATSAPP_TO` | Sí (para enviar) | — | Destinatario(s), separados por coma. Ej: `whatsapp:+54911…` o `+54911…` |
| `PADCOINS_ALERTAS_DIGEST_CRON` | No | `0 */12 * * *` | Expresión cron (cada 12 h) |
| `PADCOINS_ALERTAS_PANEL_URL` | No | URL admin genérica | Link al panel de alertas |
| `PADCOINS_ALERTAS_DEDUPE_HOURS` | No | `24` | Ventana anti-spam por alerta |
| `TWILIO_ACCOUNT_SID` | Sí (Twilio) | — | Ya usado por reservas |
| `TWILIO_AUTH_TOKEN` | Sí (Twilio) | — | Ya usado por reservas |
| `TWILIO_WHATSAPP_FROM` | No | sandbox Twilio | Remitente WhatsApp |

Si faltan `ENABLED=true` o destinatarios, el cron **se registra igual** pero **no envía** y no falla el backend.

**Por defecto dejar desactivado.** Usar push (`PADCOINS_ALERTAS_PUSH_ENABLED=true`) como canal principal.

## Frecuencia

Default: **cada 12 horas** (`0 */12 * * *`, timezone `America/Argentina/Buenos_Aires`).

Configurable vía `PADCOINS_ALERTAS_DIGEST_CRON`.

## Dedupe (Fase 1)

- Hash estable: `{sede_id}:{tipo_alerta}`.
- Memoria en proceso durante `PADCOINS_ALERTAS_DEDUPE_HOURS` (default 24 h).
- Evita reenviar la misma alerta en corridas consecutivas del cron.
- **Limitación:** tras restart del servidor se pierde el estado en memoria.

### Fase 2 (recomendada)

Tabla persistente `padcoins_alertas_envios` (o similar) con:

- `alerta_hash`, `enviado_en`, `canal`, `destinatario`
- Sobrevive restarts y permite auditoría de entregas

## Ejemplo de mensaje

```
Padbol Match — Alertas PadCoins
3 alertas críticas detectadas.
1) La Meca — Ajustes manuales excesivos
Motivo: Detectados 15 ajustes positivos sin marcador de campaña.
Recomendación: Revisar ajustes admin de la sede. No bloquea automáticamente.
2) …
Ver panel: https://…
```

- Sin JSON crudo ni datos sensibles extensos.
- Lenguaje: revisar, uso anormal, actividad poco habitual (no acusatorio).

## Por qué no reemplaza al panel web

- El panel permite filtrar, paginar y ver movimientos relacionados.
- WhatsApp es **aviso digest** para supervisión oportuna.
- Los reclamos diarios de jugadores siguen en **Admin Club** por sede.

## Implementación

| Archivo | Rol |
|---------|-----|
| `src/padcoins/padcoinsAlertasDigestService.js` | Evaluación, filtro, mensaje, dedupe, envío |
| `src/cron/padcoinsAlertasCron.js` | Orquestación cron (push + WhatsApp) |
| `server.js` | `initPadcoinsAlertasCron(...)` |

### Funciones principales

- `buildPadcoinsAlertasDigestMessage(alertas, options)`
- `getPadcoinsAlertasDigestRecipients()`
- `shouldSendPadcoinsAlertDigest()`
- `sendPadcoinsAlertasWhatsAppDigest(options)`
- `buildPadcoinsAlertHash(alerta)`
- `filterPadcoinsAlertasForDigest(alertas)`

## Tests

`lib/padcoinsAlertasDigest.test.js` — sin envío real de WhatsApp.

## Relacionado

- `docs/PADCOINS_ALERTAS_PUSH_DIGEST.md` — **canal recomendado**
- `docs/PADCOINS_ALERTAS_SUPERADMIN.md` — tipos de alerta y umbrales
- `src/padcoins/padcoinsAlertsService.js` — evaluación on-the-fly
