# PadCoins — penalizaciones automáticas

PadCoins es moneda de fidelización; **no es dinero** para el jugador.

## Reglas globales

Config en `padcoins_global_config`:

| Key | Default | Evento |
|-----|---------|--------|
| `cancelacion_tarde` | **-100** | Cancelación con menos de 24 h de anticipación |
| `no_show` | **-300** | Reserva marcada como no show |

Si la key está **`activo = false`** o el valor es 0, no se aplica penalización.

## Movimiento registrado

- **tipo:** `spend` (monto negativo en `padcoins_movimientos`)
- **referencia_tipo:** `penalizacion` (`PADCOINS_ORIGINS.PENALIZACION`)
- **referencia_id:** `{reservaId}:cancelacion_tarde` o `{reservaId}:no_show`
- **descripcion:** texto claro con motivo y monto configurado
- **sede_id:** sede de la reserva

No afecta `historico_total` (solo baja `disponible`, igual que un canje).

## Cancelación tardía

### Criterio (mismo que reputación)

Umbral: **24 horas** antes del inicio del turno (`PENALIZACION_UMBRAL_HORAS` en `routes/reputacion.js`).

```
horas_anticipacion = inicio_turno_AR - ahora_AR
penaliza si horas_anticipacion < 24
```

### Punto de integración

**`POST /api/cancelar-reserva`** en `server.js`, después de marcar la reserva como `cancelada` y procesar reputación.

Solo aplica cuando:

- Cancelación del jugador vía este endpoint (no admin DELETE)
- `horasHasta < 24`
- `user_id` válido
- Sede participa en Beneficios Padbol
- No existe penalización previa para esa reserva

**No penaliza:**

- Cancelaciones con ≥ 24 h de anticipación
- Cancelación admin (`DELETE /api/reservas/:id`) — otro flujo, sin check tardío
- Holds expirados (`reservasHoldCleanup`) — cancelación automática de sistema
- Sedes con `participa = false`

## No show

### Punto de integración

**`PUT /api/reservas/:id`** (admin), cuando `estado` pasa a `no_show`, `no-show` o `ausente`.

No hay otro flujo backend que marque no show hoy; si se agrega (cron, check-in), reutilizar `penalizarPadcoinsPorNoShow(supabaseAdmin, reservaId)`.

### Condiciones

- Estado final es no show
- `user_id` válido
- Sede participa
- Idempotencia por reserva + tipo `no_show`

## Saldo insuficiente

`deductPadcoins` en `padcoinsService.js`:

- Descuenta **hasta el saldo disponible** (mínimo entre penalización configurada y `disponible`)
- **No deja saldo negativo** (CHECK en DB + validación en servicio)
- Si `disponible = 0`: no crea movimiento; `reason: saldo_insuficiente`
- Si es parcial: descripción incluye `(descuento parcial: solicitado X, descontado Y)`

## Idempotencia

Antes de descontar, `yaFuePenalizadaReserva` consulta:

- `referencia_tipo = penalizacion`
- `referencia_id = {reservaId}:{cancelacion_tarde|no_show}`

Una reserva puede tener como máximo **una penalización por tipo** (cancelación tardía y no show son excluyentes en la práctica).

## Servicio

`src/padcoins/padcoinsPenaltiesService.js`

| Función | Uso |
|---------|-----|
| `penalizarPadcoinsPorCancelacionTarde(supabaseAdmin, reservaId, options)` | Hook cancelación jugador |
| `penalizarPadcoinsPorNoShow(supabaseAdmin, reservaId, options)` | Hook admin no show |
| `yaFuePenalizadaReserva(supabaseAdmin, reservaId, tipoPenalizacion)` | Idempotencia |
| `getPadcoinsPenaltyAmount(supabaseAdmin, key)` | Lee monto desde config |
| `isCancelacionTardeReserva(fecha, hora, horasPrecomputed)` | Mismo criterio que reputación |

## Relación con límites y acreditaciones

- Las penalizaciones **no cuentan** para límites diario/mensual de earn (solo movimientos `earn` positivos).
- Reservas `no_show` **no acreditan** PadCoins (ver [PADCOINS_ACREDITACION_RESERVAS.md](./PADCOINS_ACREDITACION_RESERVAS.md)).
- Reservas canceladas **no acreditan**.

## Tests

`lib/padcoinsPenalties.test.js`
