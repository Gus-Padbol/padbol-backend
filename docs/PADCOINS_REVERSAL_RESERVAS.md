# PadCoins — Reversa por cancelación tardía y no-show

## Objetivo

Si un jugador recibió PadCoins por una reserva (incl. bonus de campaña en el mismo movimiento `earn`) y luego incumple (cancelación tardía o no-show), el backend revierte el beneficio indebido **sin borrar historial**.

## Flujo

1. **Sin acreditación previa** → no se crea reversa (solo penalización fija si aplica).
2. **Con movimiento `earn` existente** (`referencia_tipo=reserva`, `referencia_id=reservaId`) → clawback vía movimiento `reverse` (`credit=false`).
3. **Penalización adicional** (`cancelacion_tarde` / `no_show`) sigue aplicándose después de la reversa (comportamiento previo).

## Idempotencia

| Evento | `referencia_id` | `source_key` |
|--------|-----------------|--------------|
| Cancelación tardía | `{reservaId}:reversal_cancelacion_tardia` | `{userId}\|reserva\|{reservaId}\|reversal_cancelacion_tardia` |
| No-show | `{reservaId}:reversal_no_show` | `{userId}\|reserva\|{reservaId}\|reversal_no_show` |

Servicio: `src/padcoins/padcoinsReservaReversalService.js`  
Integración: `padcoinsPenaltiesService.applyReservaPadcoinsPenalty` (reversa antes de penalizar).

## Metadata del movimiento `reverse`

- `source_type`: `reserva`
- `source_id`: id de reserva
- `action`: `reversal_cancelacion_tardia` | `reversal_no_show`
- `calculation_detail.original_movement_id`: id del `earn` revertido
- `calculation_detail.clawback_pendiente`: PadCoins no recuperados (saldo insuficiente)
- Datos de campaña si existió application: `campaign_id`, `campaign_bonus_padcoins`, etc.

## Saldo insuficiente

No existe tabla de deuda. Si el jugador ya gastó PadCoins:

- Se revierte hasta `min(earn, disponible)`.
- El resto queda en `metadata.calculation_detail.clawback_pendiente`.
- **Pendiente futuro:** job o cola para cobrar deuda al acreditar nuevos PadCoins.

## Campaña

El bonus de campaña está incluido en el único movimiento `earn`; revertir el monto completo del `earn` neutraliza base + extra. La fila en `padcoins_campaign_applications` se conserva para auditoría.

## SQL

No requiere migración nueva (usa tipos y columnas existentes: `reverse`, `metadata`, `referencia_*`).

## Hooks existentes (sin cambio de ruta)

- `POST /api/cancelar-reserva` → `penalizarPadcoinsPorCancelacionTarde`
- `PUT /api/reservas/:id` (admin, no_show) → `penalizarPadcoinsPorNoShow`
