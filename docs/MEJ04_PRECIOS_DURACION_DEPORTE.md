# MEJ-04 Fase 1 — Precios por duración y disciplina (Backend)

## Problema actual

La tabla `sedes_duraciones` existe en Supabase y contiene precios configurables por sede y duración, pero el backend **no la consultaba**. La cotización de reservas (Mercado Pago / `quoteReservaPrice`) usaba columnas legacy en `sedes`:

- `precio_60min`, `precio_90min`, `precio_120min`
- `precio_turno` / `precio_por_reserva` (fallback 90 min)

En **La Meca** (sede_id = 1) hay desincronización activa:

| Duración | `sedes_duraciones` | `sedes.precio_*` (lo que cobraba el backend) |
|----------|-------------------|-----------------------------------------------|
| 60 min   | 22.000            | 25.000 (`precio_60min`)                       |
| 120 min  | 40.000            | 35.000 (`precio_120min`)                      |

El admin probablemente edita `sedes_duraciones` en Supabase, pero el checkout seguía cobrando los valores legacy.

## Fuente de verdad nueva (Fase 1)

Tras esta fase, el precio base de reserva se resuelve en:

`src/pricing/resolveReservaBasePrice.js`

Integrado vía `calculateSurgePrice` (`src/surge.js`) → `quoteReservaPrice` → `POST /api/crear-preferencia`.

## Prioridad de precios

1. **`franjas_precio`** — franja activa para sede + deporte + día/hora + duración (60/90/120).
2. **`sedes_duraciones`** con `deporte` específico + duración + `activo = true`.
3. **`sedes_duraciones`** con `deporte IS NULL` (precio base) + duración + `activo = true`.
4. **Legacy `sedes`** — `precio_60min`, `precio_90min`, `precio_120min`; para 90 min también `precio_turno` / `precio_por_reserva`.
5. **Sin precio** — error HTTP 400 en checkout (`PRECIO_NO_CONFIGURADO`), no se cobra 0 silenciosamente.

### Columna `deporte` en `sedes_duraciones`

Migración documentada en `docs/sql/sedes_duraciones_deporte_mej04.sql`:

- `deporte NULL` → precio base de la sede para esa duración.
- `deporte` con valor → override por disciplina (`padbol`, `padel`, `pickleball`, `tenis`).
- Filas existentes (La Meca) quedan con `deporte NULL`.

## Compatibilidad legacy

- No se eliminan columnas `sedes.precio_*`.
- No se tocan `precios_por_deporte` ni `franjas_precio`.
- Si no hay fila en `sedes_duraciones`, el backend sigue usando legacy.
- Duraciones distintas de 60/90/120 solo tienen precio si están en `sedes_duraciones` (o franja para 60/90/120).

## Endpoints nuevos

| Método | Ruta | Auth | Descripción |
|--------|------|------|-------------|
| GET | `/api/sedes/:id/duraciones` | Admin sede / super admin | Lista todas (activas e inactivas). Query `deporte` opcional. |
| GET | `/api/sedes/:id/duraciones-disponibles` | Público | Solo activas; agrupadas por deporte o filtradas con `?deporte=`. |
| POST | `/api/sedes/:id/duraciones` | Admin | Crea duración (15–480 min, precio ≥ 0). |
| PATCH | `/api/sedes/:id/duraciones/:rowId` | Admin | Edita precio, activo, deporte, duración. |
| DELETE | `/api/sedes/:id/duraciones/:rowId` | Admin | Soft delete (`activo = false`). |

## Qué falta para frontend (Fase 2+)

- UI admin para CRUD de duraciones por deporte.
- Selector de duración en flujo de reserva consumiendo `duraciones-disponibles`.
- Sincronización visual entre precios legacy en `sedes` y `sedes_duraciones` (o deprecar columnas legacy en UI).
- Ejecutar SQL en Supabase staging/prod.
- Posible backfill / alertas si legacy y `sedes_duraciones` divergen.

## Riesgos

| Riesgo | Mitigación |
|--------|------------|
| Checkout pasa a cobrar precio de `sedes_duraciones` (p. ej. La Meca 60 min baja de 25k a 22k) | Comportamiento deseado; validar con admin antes de deploy. |
| SQL no ejecutado: columna `deporte` ausente | Resolver consulta sin filtro por deporte; filas existentes se tratan como base. |
| UNIQUE viejo `(sede_id, duracion_minutos)` bloquea overrides por deporte | SQL idempotente elimina constraint legacy antes del índice nuevo. |
| Duración sin precio en ninguna fuente | 400 en checkout; antes devolvía 0. |
| `POST /api/reservas` sin pago aún puede confiar en precio del cliente | Fuera de alcance Fase 1; checkout MP ya recalcula server-side. |

## Cómo validar en staging

1. Ejecutar `docs/sql/sedes_duraciones_deporte_mej04.sql` en Supabase staging.
2. Verificar La Meca:
   - `GET /api/surge/1/padbol/60` → precio base **22.000** (desde `sedes_duraciones`).
   - `GET /api/sedes/1/duraciones-disponibles` → lista activas.
3. Checkout:
   - `POST /api/crear-preferencia` con duración 60 → total basado en 22.000 (+ fee/extras), no 25.000.
4. Duración 75 sin fila → 400 claro.
5. Admin:
   - `POST /api/sedes/1/duraciones` con token admin → crea fila.
   - `DELETE` → `activo = false`.
6. Tests: `npm test` — `lib/sedesDuracionesPricing.test.js`.

## Archivos principales

- `docs/sql/sedes_duraciones_deporte_mej04.sql`
- `src/pricing/resolveReservaBasePrice.js`
- `src/surge.js` (refactor mínimo)
- `routes/sedesDuraciones.js`
- `lib/sedesDuracionesPricing.test.js`
