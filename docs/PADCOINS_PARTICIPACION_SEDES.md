# PadCoins — participación por sede

## Resumen

Beneficios Padbol / PadCoins es **opt-in por sede**. Ninguna sede está obligada a participar ni a dar descuentos.

- **Admin Club** activa o desactiva Beneficios Padbol para **su propia sede** (`PUT /api/admin/padcoins-sedes-config/:sedeId`).
- **Super Admin** audita todas las sedes, puede intervenir en cualquiera y conserva control excepcional para bloquear o corregir abusos. No es el operador habitual de activación.
- Cada sede define sus **propios premios** y costos en PadCoins (`premios_canjeables`).

## Permisos API

| Endpoint | Super Admin | Admin Club | Admin Nacional / otros |
|----------|-------------|------------|------------------------|
| `GET /api/admin/padcoins-sedes-config` | ✓ lista todas | ✗ | ✗ |
| `GET /api/admin/padcoins-sedes-config/:sedeId` | ✓ cualquier sede | ✓ solo su sede | ✗ (sin scope claro) |
| `PUT /api/admin/padcoins-sedes-config/:sedeId` | ✓ cualquier sede | ✓ solo su sede | ✗ |

Admin Club sin `sede_id` asignada → **403**.

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

Si una sede se desactiva (por Admin Club o Super Admin), los canjes ya creados en estado pendiente/aprobado **siguen gestionables** (entregar/cancelar). No se permiten **nuevos** canjes.

Futuro: política de cierre con plazo y comunicación al jugador.

## Ventana de fechas

- `fecha_inicio` futura → aún no participa.
- `fecha_fin` pasada → ya no participa (canjes pendientes se respetan).

## La Meca (sede_id = 1)

La migración SQL incluye insert idempotente con `activo = true` para la sede piloto. Otras sedes se activan por el Admin Club de la sede o por Super Admin.

## Reservas automáticas

Todavía **no cableadas**. Cuando se implemente, consultar `isPadcoinsActiveForSede(sedeId)` antes de acreditar.
