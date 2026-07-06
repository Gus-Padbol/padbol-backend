# PadCoins — auditoría admin de movimientos

Endpoint de lectura para que admins consulten el historial de movimientos PadCoins con filtros. Pensado para reclamos, soporte y auditoría interna.

PadCoins es moneda de fidelización; **no es dinero** para el jugador.

## Endpoint

```
GET /api/admin/padcoins-movimientos
```

Requiere JWT de admin (`super_admin` o `admin_club`).

## Permisos por rol

| Rol | Alcance |
|-----|---------|
| **Super Admin** | Todas las sedes. Puede filtrar por `sede_id` o listar globalmente. |
| **Admin Club** | Solo movimientos con `sede_id` de su sede asignada. No puede pedir otra sede. |
| **Admin Nacional / otros** | Sin acceso (`403`). |

## Filtros (query string)

| Parámetro | Descripción |
|-----------|-------------|
| `sede_id` | Filtra por sede (Super Admin). Admin Club: ignorado salvo validación de ownership. |
| `user_id` / `jugador_id` | Filtra por jugador (UUID). |
| `tipo` | `earn`, `spend`, `adjust`, `reverse`. |
| `referencia_tipo` | Ej. `reserva`, `penalizacion`, `logro`, `bonus_admin`. |
| `referencia_id` | ID de referencia exacta. |
| `fecha_desde` / `desde` | `created_at >=` (ISO o fecha parseable). |
| `fecha_hasta` / `hasta` | `created_at <=`. |
| `search` / `q` | Busca jugador por nombre/apellido/email en `jugadores_perfil` (mín. 2 caracteres). |
| `limit` | Default **25**, máximo **100**. |
| `offset` | Desplazamiento (default 0). |
| `page` | Alternativa a offset: `offset = (page - 1) * limit`. |

Orden: **`created_at` descendente** (más recientes primero).

## Respuesta

```json
{
  "ok": true,
  "movimientos": [
    {
      "id": "uuid",
      "fecha": "2026-07-06T10:00:00.000Z",
      "user_id": "uuid-jugador",
      "jugador": {
        "user_id": "uuid-jugador",
        "nombre": "Juan Pérez",
        "email": "juan@example.com"
      },
      "tipo": "earn",
      "monto": 100,
      "descripcion": "PadCoins por reserva completada…",
      "sede_id": 1,
      "sede_nombre": "La Meca",
      "referencia_tipo": "reserva",
      "referencia_id": "42",
      "saldo_resultante": 250,
      "created_by": null
    }
  ],
  "paginacion": {
    "limit": 25,
    "offset": 0,
    "page": 1,
    "total": 128
  },
  "filtros_aplicados": { }
}
```

### Campos por movimiento

| Campo | Origen |
|-------|--------|
| `fecha` | `padcoins_movimientos.created_at` |
| `jugador` | Join opcional con `jugadores_perfil` |
| `monto` | Entero con signo según convención del servicio |
| `saldo_resultante` | `saldo_despues` del movimiento |
| `sede_nombre` | Join opcional con `sedes` |

No hay columna `metadata` en el esquema actual; no se expone.

## Uso previsto

- Vista admin de movimientos en frontend moderno
- Investigar reclamos de jugadores (“¿por qué me descontaron PadCoins?”)
- Auditar acreditaciones, penalizaciones, canjes y ajustes admin por sede

## Servicio

`src/padcoins/padcoinsMovimientosAdminService.js`

- `listPadcoinsMovimientosAdmin(supabaseAdmin, { role, query })`
- `resolvePadcoinsMovimientosAdminScope(role, sedeId)`
- `parsePadcoinsMovimientosAdminFilters(query)`

## Relación con endpoint jugador

`GET /api/padcoins/historial` **no cambia**: sigue listando solo los movimientos del usuario autenticado vía `listPadcoinsMovimientos`.

## Tests

`lib/padcoinsMovimientosAdmin.test.js`
