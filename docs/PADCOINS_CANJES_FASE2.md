# PadCoins — Canjes Fase 2 (beneficios visuales, QR, límites, aprobación)

PadCoins es moneda de fidelización; **no es dinero** para el jugador.

## Alcance

- Imagen opcional por beneficio (`imagen_url` + fallback visual)
- Flujo `pendiente → aprobado → entregado` (compatible con entrega directa `pendiente → entregado` V1)
- Código `PC-...` + payload QR verificable (`qr_payload`, `qr_data`)
- Límites por beneficio (usuario y global; día/semana/mes/total)
- Vencimiento (`expires_at`) con devolución idempotente de PadCoins
- Notificaciones: pendiente, **aprobado**, entregado, cancelado, **vencido**

## Estados y transiciones

| Desde | Hacia | Acción |
|-------|-------|--------|
| pendiente | aprobado | POST `.../aprobar` |
| pendiente | cancelado | POST `.../cancelar` |
| pendiente | entregado | POST `.../entregar` (**compat V1**) |
| pendiente | vencido | cron / lazy expiry |
| aprobado | entregado | POST `.../entregar` |
| aprobado | cancelado | POST `.../cancelar` |
| aprobado | vencido | cron / lazy expiry |
| entregado / cancelado / vencido | — | finales |

## Endpoints nuevos/ampliados

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/premios-canjeables/:id` | Detalle público del beneficio |
| GET | `/api/padcoins/canjes/:id` | Detalle del canje (dueño) + QR |
| GET | `/api/admin/padcoins-canjes/:id` | Detalle admin + flags operativos |
| GET | `/api/admin/padcoins-canjes/validar?codigo=` | Validar canje por código |
| POST | `/api/admin/padcoins-canjes/:id/aprobar` | Aprobar antes de entrega |

Rutas V1 mantenidas: listados, canjear, entregar, cancelar.

## QR / verificación

- Se conserva `codigo` (`PC-HEX12`)
- `qr_payload`: JSON con `canje_id`, `codigo`, `sede_id`, `premio_id`, `premio_nombre`, `user_id`
- `qr_data`: base64url del payload (Nativa genera la imagen QR)
- `verify_path`: `/api/admin/padcoins-canjes/validar?codigo=...`

## Límites por beneficio

Campos en `premios_canjeables`:

- `limite_usuario_cantidad` + `limite_usuario_periodo`
- `limite_global_cantidad` + `limite_global_periodo`
- Períodos: `dia | semana | mes | total`
- `null` / `0` = sin límite
- Validación **antes** de descontar saldo; cuenta canjes `pendiente`, `aprobado`, `entregado`

## Vencimiento

- `expires_at` en `padcoins_canjes` (default 30 días o `canje_validez_dias` del beneficio)
- Lazy expiry al leer/operar + cron horario (`padcoinsCanjesExpiryCron.js`)
- Vencido → devolución única vía `reversePadcoins` + restock

## Compatibilidad Nativa

- Respuestas V1 intactas (`canje`, `codigo`, `saldo`)
- Campos nuevos opcionales: `qr_payload`, `qr_data`, `verify_path`, `expires_at`, `premio_imagen_url`
- Entrega directa desde `pendiente` sigue funcionando

## SQL pendiente

Ejecutar en staging primero:

1. `docs/sql/padcoins_v1_migration.sql` (si no aplicado)
2. **`docs/sql/padcoins_canjes_phase2_migration.sql`**

El backend tolera columnas ausentes con defaults en código, pero producción debe aplicar la migración Fase 2 para persistir imagen, límites y vencimiento.
