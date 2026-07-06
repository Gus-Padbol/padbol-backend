# PadCoins — participación por sede

## Resumen

Beneficios Padbol / PadCoins es **opt-in por sede**. Ninguna sede está obligada a participar ni a dar descuentos.

- **Super Admin** activa o desactiva la participación (`padcoins_sede_config`).
- **Admin Club** puede ver el estado de su sede; por ahora **no puede editarlo**.
- Cada sede define sus **propios premios** y costos en PadCoins (`premios_canjeables`).

## Si la sede participa (`participa = true`)

- Puede otorgar PadCoins (cuando se cablee acreditación por reservas/actividad).
- Muestra catálogo de beneficios al jugador.
- Permite canjes nuevos.
- Admin club puede crear/editar premios.

## Si la sede NO participa

- No otorga PadCoins por actividad en esa sede.
- GET público de premios: `{ ok: true, premios: [], padcoins_activo: false }`.
- POST canjear: bloqueado — *"La sede no participa en Beneficios Padbol"*.
- Admin club: no puede crear/editar/desactivar premios.
- Reservar y jugar sigue funcionando con normalidad.

## Super Admin vs Admin Club en premios

| Acción | Sede inactiva — Admin Club | Sede inactiva — Super Admin |
|--------|---------------------------|-----------------------------|
| Crear/editar premio | Bloqueado | Permitido (preparar catálogo antes de activar) |
| Canjear (jugador) | Bloqueado | Bloqueado |
| Entregar/cancelar canjes pendientes | Permitido | Permitido |

## Canjes pendientes al desactivar

Si una sede se desactiva, los canjes ya creados en estado pendiente/aprobado **siguen gestionables** (entregar/cancelar). No se permiten **nuevos** canjes.

Futuro: política de cierre con plazo y comunicación al jugador.

## Ventana de fechas

- `fecha_inicio` futura → aún no participa.
- `fecha_fin` pasada → ya no participa (canjes pendientes se respetan).

## La Meca (sede_id = 1)

La migración SQL incluye insert opcional idempotente con `activo = true` para la sede piloto. Otras sedes se activan vía API Super Admin o INSERT manual.

## Reservas automáticas

Todavía **no cableadas**. Cuando se implemente, consultar `isPadcoinsActiveForSede(sedeId)` antes de acreditar.
