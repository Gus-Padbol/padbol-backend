# PadCoins — límites diario y mensual por jugador

## Resumen

Los topes **`limite_diario_jugador`** y **`limite_mensual_jugador`** (config global Super Admin en `padcoins_global_config`) limitan cuántos PadCoins puede **ganar** un jugador por día y por mes calendario (Argentina).

PadCoins es moneda de fidelización; **no es dinero** para el jugador.

## Qué movimientos cuentan para el límite

Solo entran en el cómputo del periodo:

| Criterio | Valor |
|----------|--------|
| `tipo` | `earn` |
| `monto` | `> 0` |
| `created_at` | Dentro del día o mes calendario AR |

**No cuentan:**

- `spend` (canjes)
- `adjust` (ajustes manuales admin)
- `reverse` (reversas por cancelación de canje)
- Penalizaciones u otros tipos
- Movimientos `earn` con monto ≤ 0

## Periodos de cálculo

Zona horaria: **`America/Argentina/Buenos_Aires`**.

| Periodo | Desde | Hasta |
|---------|-------|-------|
| Día | 00:00:00.000 del día actual AR | 23:59:59.999 del día actual AR |
| Mes | 00:00:00.000 del día 1 del mes AR | 23:59:59.999 del último día del mes AR |

## Configuración

Keys en `padcoins_global_config`:

- `limite_diario_jugador` (default **1000**)
- `limite_mensual_jugador` (default **10000**)

Si una key está **`activo = false`** o el valor es **≤ 0**, ese tope no se aplica (ilimitado en esa dimensión).

## Dónde se aplican los límites

Automáticamente en **`addPadcoins`** cuando `tipo = earn` y no se pasa `skipEarnCaps: true`.

Flujos conectados:

1. **Reserva completada** — `acreditarPadcoinsPorReservaCompletada`
2. **Logro desbloqueado** — `sumarPadcoinsLogroDesbloqueado` en `logrosSyncService`
3. **Futuras acreditaciones automáticas** que usen `addPadcoins` con `earn`

**Excluidos explícitamente:**

- `adjustPadcoins` (admin)
- `reversePadcoins` (canje cancelado)
- `spendPadcoins` (canjes)

## Acreditación parcial

Si la acreditación calculada supera el remanente del tope, se acredita **solo lo permitido**.

Ejemplo:

- Límite diario: **1000**
- Ya ganó hoy: **900**
- Nueva acreditación calculada: **250**
- **Resultado:** se acreditan **100** PadCoins
- La descripción del movimiento incluye: `(límite aplicado: solicitado 250, acreditado 100)`

Si el remanente es **0**, no se crea movimiento (no hay montos 0) y la respuesta incluye `reason`:

- `limite_diario_alcanzado`
- `limite_mensual_alcanzado`

En reservas bloqueadas por límite, el cron puede reintentar en un periodo posterior (nuevo día/mes) porque no se registra movimiento idempotente hasta acreditar algo > 0.

## Servicio helper

`src/padcoins/padcoinsEarnLimitsService.js`

| Función | Uso |
|---------|-----|
| `getPadcoinsEarnLimits(supabaseAdmin)` | Lee topes activos desde config global |
| `getPadcoinsEarnedInPeriod(supabaseAdmin, userId, desde, hasta)` | Suma earn positivos en rango |
| `applyPadcoinsEarnCaps(supabaseAdmin, userId, montoSolicitado, options)` | Calcula monto final tras topes |
| `getEarnPeriodBounds('day' \| 'month', now)` | Límites de periodo en AR |
| `appendPadcoinsEarnCapToDescripcion(descripcion, capResult)` | Texto de límite en movimiento |

## Relación con reservas

Ver también [PADCOINS_ACREDITACION_RESERVAS.md](./PADCOINS_ACREDITACION_RESERVAS.md).

- Idempotencia por reserva: un movimiento `earn` con `referencia_tipo = reserva` y `referencia_id = {reservaId}`.
- Si la acreditación fue **parcial**, la segunda ejecución responde `ya_acreditada` (no intenta completar el remanente de la reserva).
- Campos de respuesta extra: `padcoins_solicitados`, `capped`, `cap`.

## Relación con logros

- Misma lógica vía `addPadcoins`.
- Idempotencia del logro sigue siendo por `referencia_tipo = logro` + slug.
- Si el límite bloquea por completo (`skipped`), no se marca como acreditado y puede reintentarse en otro periodo.

## Tests

`lib/padcoinsLimits.test.js` — casos de tope completo, parcial, bloqueo, exclusión de adjust, idempotencia de reserva y logros.
