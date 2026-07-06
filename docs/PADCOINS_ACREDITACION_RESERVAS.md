# PadCoins — acreditación por reservas completadas

## Cuándo acredita

PadCoins se acreditan **automáticamente** cuando el cron de reservas marca una reserva como `completada` (`src/cron/reservasCron.js` → `procesarReservasCompletadas`).

Condiciones:

1. Reserva en estado **`completada`**
2. `user_id` válido
3. `sede_id` válido
4. Sede con **`participa = true`** en Beneficios Padbol (`padcoins_sede_config`)
5. **No** acreditada previamente (idempotencia)
6. Monto calculado **> 0**

## Cuándo NO acredita

| Caso | Resultado |
|------|-----------|
| Sede no participa | Skip (`sede_no_participa`) |
| Estado `cancelada` | Skip |
| Estado `no_show` / `ausente` | Skip |
| Estado distinto de `completada` | Skip |
| Ya existe movimiento earn para la reserva | Skip (`ya_acreditada`) |
| Monto calculado ≤ 0 | Skip |

## Fórmula (config global)

Modo `porcentaje_valor_pagado`:

```
padcoins = round(monto_usd × porcentaje_devolucion / 100 × padcoins_por_usd_equivalente)
```

**Lanzamiento:** 5%, 100 PadCoins por USD equivalente promocional (interno; no mostrar al jugador).

## Moneda y fallback

| Situación | Cálculo |
|-----------|---------|
| USD + monto pagado confiable (`pago_estado = pagado`) | Proporcional |
| ARS u otra moneda sin FX | Fallback `reserva_confirmada` (default 30) |
| Sin monto confiable | Fallback `reserva_confirmada` |

No se inventa tipo de cambio. El motivo del fallback se incluye en la descripción del movimiento.

## Idempotencia

Antes de acreditar se consulta `padcoins_movimientos`:

- `tipo = earn`
- `referencia_tipo = reserva`
- `referencia_id = {reservaId}`

Si existe → OK sin duplicar.

## Movimiento registrado

- **tipo:** `earn`
- **referencia_tipo:** `reserva`
- **referencia_id:** id de la reserva
- **sede_id:** sede de la reserva
- **descripcion:** "PadCoins por reserva completada en {sede} …"
- Actualiza `padcoins_saldo` vía `addPadcoins`

## Punto de integración

**Único hook actual:** `procesarReservasCompletadas` en `src/cron/reservasCron.js`, después de actualizar estado a `completada` y acreditar XP.

No hay otro flujo que marque reservas como completadas hoy. Si en el futuro se agrega completado manual o por check-in, reutilizar `acreditarPadcoinsPorReservaCompletada(supabaseAdmin, reservaId)`.

## Servicio

`src/padcoins/padcoinsReservasService.js`

- `acreditarPadcoinsPorReservaCompletada(reservaId, options)`
- `buildPadcoinsReservaMovimientoReferencia(reservaId)`
- `getReservaPaidAmountInfo(reserva)`
- `computePadcoinsAmountForReserva(reserva, config)`
- `yaFueAcreditadaReserva(reservaId)`
- `isPadcoinsActiveForSede` (desde `padcoinsSedeConfigService`)

## Pendientes / decisiones

- Penalización PadCoins por no-show (config global `no_show`) **no cableada** en este bloque; solo se evita acreditar si `estado = no_show`.
- Reservas completadas sin check-in siguen acreditando (mismo criterio que XP hoy).
- Límites diarios/mensuales globales (`limite_diario_jugador`) **no aplicados** aún en este hook.
