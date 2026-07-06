# PadCoins — lógica proporcional por valor pagado

## Resumen

PadCoins **no son dinero** para el jugador. Son una moneda de fidelización interna con equivalencia promocional (100 PadCoins ≈ 1 USD equivalente) que **nunca se muestra como valor monetario** en la app.

- **Super Admin** define el porcentaje global de devolución y la conversión PadCoins/USD equivalente.
- **Cada sede** define sus propios premios canjeables y costos en PadCoins (`premios_canjeables`).
- Un premio de una sede no aplica en otra.

## Cómo se ganan PadCoins en reservas pagas

Cuando el modo global es `porcentaje_valor_pagado`:

```
padcoins = round(monto_usd_equivalente × porcentaje_devolucion / 100 × padcoins_por_usd_equivalente)
```

**Lanzamiento:** 5% de devolución, 100 PadCoins por 1 USD equivalente.

**Futuro estándar:** 2%–3%.  
**Campañas especiales:** 8%–10%, doble PadCoins, franjas horarias (config global futura).

## Por qué sedes distintas entregan distinto

El turno en una sede premium cuesta más → el jugador gana más PadCoins por el mismo porcentaje. Los premios y su costo en PadCoins los fija cada sede; no hay un “premio global” compartido entre sedes (salvo futura cadena Padbol Points).

## Ejemplos (5%, 100 PadCoins/USD)

| Valor pagado (USD equiv.) | Cálculo | PadCoins |
|---------------------------|---------|----------|
| USD 10 | 10 × 5% × 100 | **50** |
| USD 50 | 50 × 5% × 100 | **250** |
| USD 80 | 80 × 5% × 100 | **400** |

## Keys globales relacionadas

| Key | Tipo | Default | Rol |
|-----|------|---------|-----|
| `porcentaje_devolucion_reserva` | integer | 5 | % sobre valor pagado |
| `padcoins_por_usd_equivalente` | integer | 100 | Conversión promocional interna |
| `modo_calculo_reserva` | text | `porcentaje_valor_pagado` | Modo de acreditación |
| `reserva_confirmada` | integer | 30 | **Fallback** si no hay monto pagado o moneda sin conversión |
| `partido_jugado` | integer | 50 | Bonus/fallback fijo futuro (partidos sin pago proporcional) |

## Moneda y conversión

- Si la reserva está en **USD**, se usa el monto pagado directo.
- Si está en **ARS u otra moneda**, el backend **no inventa tipo de cambio**. Hasta cablear FX explícito, no se aplica el cálculo proporcional automático; puede usarse `reserva_confirmada` como fallback cuando corresponda.

## Estado de implementación

- Config global y helper `calculatePadcoinsForPaidAmount` en `src/padcoins/padcoinsGlobalConfigService.js`.
- **No cableado** aún al flujo de confirmación/jugada de reservas (pendiente definir punto único de acreditación y moneda en webhook/cron).
