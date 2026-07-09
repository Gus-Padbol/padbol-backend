# PadCoins — Idempotencia y anti-abuso

## Principio

PadCoins **no se crean desde la app**. El backend valida eventos reales, calcula montos y registra movimientos con trazabilidad.

## Mitigaciones implementadas (backend)

| Riesgo | Mitigación |
|--------|------------|
| Doble acreditación por reserva | `yaFueAcreditadaReserva` + `ensurePadcoinsNotAlreadyApplied` + índice único `(reserva, earn)` |
| Doble penalización | `yaFuePenalizadaReserva` + índice único `penalizacion` |
| Doble aplicación de campaña | `hasApplicationForReserva` + unique `(campaign_id, reserva_id)` |
| Doble canje (doble submit) | Canje pendiente por premio+jugador + `referencia_id = canjeId` en spend |
| Monto manipulado desde jugador | Canje ignora `amount` en body; costo sale del premio en DB |
| Admin club fuera de sede | `POST /api/admin/padcoins/ajuste` exige `sede_id` = sede del admin |
| Movimientos sin trazabilidad | `metadata` JSONB + `source_key` en descripción/metadata |

## Helpers

- `buildPadcoinsSourceKey(user_id, source_type, source_id, action)`
- `ensurePadcoinsNotAlreadyApplied(...)`
- `registerPadcoinsApplication(...)` — campañas

Archivo: `src/padcoins/padcoinsIdempotencyService.js`

## Migración SQL

Ejecutar: `docs/sql/padcoins_movimientos_idempotency_migration.sql`

## Pendiente futuro (documentado, no bloqueante)

1. **RPC transaccional** `apply_padcoins_change()` — atomicidad saldo + movimiento en una sola transacción Postgres.
2. **Reversión de earn** si una reserva acreditada pasa después a `cancelada`/`no_show` (hoy solo penalización adicional).
3. **Idempotency-Key HTTP** opcional en canje para retries del cliente.
4. **Fuentes múltiples** (torneos, partidos, reseñas) — cada una con `source_type` + unique parcial al implementarse.

## Puntos de acreditación (audit)

| Origen | Servicio | Idempotencia |
|--------|----------|--------------|
| Reserva completada | `acreditarPadcoinsPorReservaCompletada` | `reserva` + reserva_id |
| Campaña | `recordCampaignApplication` | campaign_id + reserva_id |
| Logro Arena | `sumarPadcoinsLogroDesbloqueado` | logro + slug |
| Penalización | `penalizarPadcoinsPor*` | penalizacion + reserva:tipo |
| Canje | `canjearPremioPadcoins` | canje_premio + canjeId |
| Ajuste admin | `adjustPadcoins` | Sin idempotencia (manual, auditado por created_by) |

## Endpoints jugador (solo lectura + canje)

- `GET /api/padcoins/mi-saldo`
- `GET /api/padcoins/historial`
- `GET /api/padcoins/mis-canjes`
- `POST /api/premios-canjeables/:id/canjear` — sin amount en body

No existe endpoint jugador para acreditar PadCoins libremente.
