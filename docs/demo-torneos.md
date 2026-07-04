# Torneos demo (staging)

Script idempotente para crear torneos de prueba con prefijo **`DEMO |`** en entornos controlados (staging).  
**No ejecutar en producción** sin confirmación explícita.

## Qué crea

| Nombre | `tipo_torneo` | Equipos | Partidos | Notas |
|--------|---------------|---------|----------|-------|
| `DEMO \| Liga Round Robin` | `round_robin` | 8 | 28 | Tabla general, sin llave. Un partido con `define_campeon: true` (Argentina vs Francia). |
| `DEMO \| Eliminación Directa` | `knockout` | 8 | 7 | Cuartos + semifinales + final. `ronda`: `cuartos`, `semifinal`, `final`. Campeón: Argentina. |
| `DEMO \| Solo Grupos` | `grupos` | 8 | 12 | Grupos A/B (4 equipos c/u). Sin llave. |
| `DEMO \| Grupos + Eliminatoria` | `grupos_knockout` | 8 | 15 | 12 de grupos + 2 semifinales + final. Campeón: Argentina. |
| `DEMO \| Liga + Playoff` | `liga_playoff` | 8 | 31 | 28 de liga + 2 semifinales + final. Campeón: España. |

Equipos: Argentina, España, Francia, Italia, Brasil, Uruguay, Portugal, Alemania (2 jugadores demo c/u, emails `*.demo@padbol.com`).

**No se modifica** el torneo real **#23** (`Demo Padbol Pro Cup Completo`).

## Variables de entorno

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `ALLOW_DEMO_SEED` | **Sí** | Debe ser `true` o el script aborta. |
| `SUPABASE_URL` | Sí | URL del proyecto Supabase (staging recomendado). |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí | Service role para inserts (nunca commitear). |
| `DEMO_SEED_SEDE_ID` | No | `sede_id` destino (default: `1`). |
| `FINALIZE_DEMOS` | No | `true` → marca torneos `finalizado` y escribe `tabla_puntos`. Default: no finaliza. |
| `CREATE_ONLY` | No | Documentación: equivalente a no definir `FINALIZE_DEMOS`. |
| `DEMO_RESEED` | No | `true` → borra y recrea solo torneos cuyo nombre empieza con `DEMO \|`. |
| `ALLOW_PRODUCTION_DEMO_SEED` | Solo prod | Obligatoria si `NODE_ENV=production` o URL de producción. |

## Cómo ejecutar en staging

Desde la raíz del backend, con `.env` apuntando a **staging**:

```bash
export ALLOW_DEMO_SEED=true
export DEMO_SEED_SEDE_ID=1

# Solo crear (sin finalizar):
node scripts/seed-demo-torneos.mjs

# Crear y finalizar (tabla_puntos + podio):
export FINALIZE_DEMOS=true
node scripts/seed-demo-torneos.mjs

# Recrear demos existentes:
export DEMO_RESEED=true
export ALLOW_DEMO_SEED=true
node scripts/seed-demo-torneos.mjs
```

## Verificación en app nativa

1. Apuntar la app a staging / backend de prueba.
2. **Competir → Torneos** → buscar nombres `DEMO | …`.
3. Por torneo, revisar pestañas:
   - **Equipos** / **Grupos** / **Fixture** / **Llave** / **Podio**
4. Abrir un partido de eliminatoria y confirmar copy (semifinalista / finalista / campeón).
5. En **Liga Round Robin**, abrir el partido Argentina vs Francia y ver badge/resumen de campeón de liga (requiere `define_campeon` en DB + DTO).

Endpoints útiles:

```bash
curl "$API/api/torneos/{id}"
curl "$API/api/torneos/{id}/equipos"
curl "$API/api/torneos/{id}/partidos"
curl "$API/api/torneos/{id}/tabla-puntos"
```

## Columnas opcionales en `partidos`

El script puede setear `define_campeon`, `consagra_campeon`, `es_final`, etc.  
Si Supabase devuelve error de columna inexistente, agregar en staging:

```sql
ALTER TABLE partidos ADD COLUMN IF NOT EXISTS define_campeon boolean DEFAULT false;
ALTER TABLE partidos ADD COLUMN IF NOT EXISTS consagra_campeon boolean DEFAULT false;
ALTER TABLE partidos ADD COLUMN IF NOT EXISTS es_partido_consagracion boolean DEFAULT false;
ALTER TABLE partidos ADD COLUMN IF NOT EXISTS es_final boolean DEFAULT false;
```

El DTO (`lib/dto/legacyPublic.js`) expone estos campos **solo si vienen de la fila**.

## Protecciones

- Aborta sin `ALLOW_DEMO_SEED=true`.
- Aborta en `NODE_ENV=production` sin `ALLOW_PRODUCTION_DEMO_SEED=true`.
- No borra ni modifica torneos que **no** empiecen con `DEMO |`.
- Lista protegida: torneo id **23**.
- `DEMO_RESEED` solo elimina torneos demo por nombre verificado.

## Advertencia producción

**No ejecutar en producción** salvo confirmación explícita del equipo.  
El seed inserta datos de prueba y, con `FINALIZE_DEMOS=true`, escribe `tabla_puntos` y `puntos_ranking` en equipos demo.

---

## DEMO \| Manual Result Test

Script mínimo para probar `POST /api/torneos/:torneoId/partidos/:partidoId/resultado` con un partido pendiente sin marcador.

**Archivo:** `scripts/seed-demo-manual-result-test.mjs`

### Objetivo

Crea exactamente:

| Recurso | Detalle |
|---------|---------|
| Torneo | `DEMO \| Manual Result Test`, `sede_id: 1`, `estado: en_curso`, `tipo_torneo: round_robin` |
| Equipos | `Demo Manual A`, `Demo Manual B` (2 jugadores demo c/u) |
| Partido | 1 fila `pendiente`, sin resultado, sin scoreboard |

No inserta `tabla_puntos`, no escribe `puntos_ranking`, no finaliza el torneo, no crea `scoreboard_partidos`.  
`marcador_disponible` queda `false` en runtime vía GET partidos.

### Variables requeridas

| Variable | Requerida | Descripción |
|----------|-----------|-------------|
| `ALLOW_DEMO_SEED` | **Sí** | Gate general de seeds demo. |
| `ALLOW_MANUAL_RESULT_DEMO` | **Sí** | Gate específico de este script. |
| `DEMO_TARGET_ENV` | **Sí** | `local` o `staging` (recomendado). |
| `SUPABASE_URL` | Sí | Proyecto Supabase destino. |
| `SUPABASE_SERVICE_ROLE_KEY` | Sí | Service role (nunca commitear). |
| `DEMO_SEED_SEDE_ID` | No | Default `1`. |
| `DEMO_RESEED` | No | `true` → borra y recrea solo este demo. |
| `DEMO_DELETE_ONLY` | No | `true` → borra solo este demo, sin recrear. |
| `DEMO_API_BASE` | No | Base URL para imprimir curls (default `http://localhost:3000`). |

**No soporta** `FINALIZE_DEMOS`.

### Comandos propuestos (staging/local)

```bash
export ALLOW_DEMO_SEED=true
export ALLOW_MANUAL_RESULT_DEMO=true
export DEMO_TARGET_ENV=staging
export DEMO_SEED_SEDE_ID=1

node scripts/seed-demo-manual-result-test.mjs

# Recrear:
export DEMO_RESEED=true
node scripts/seed-demo-manual-result-test.mjs

# Solo borrar:
export DEMO_DELETE_ONLY=true
node scripts/seed-demo-manual-result-test.mjs
```

### Validación GET esperada (post-seed)

```bash
curl "$API/health"
curl "$API/api/torneos/{torneo_id}"
curl "$API/api/torneos/{torneo_id}/equipos"
curl "$API/api/torneos/{torneo_id}/partidos"
curl -H "Authorization: Bearer $JWT" "$API/api/torneos/{torneo_id}/permisos"
```

Esperado en `partidos[0]`: `estado: pendiente`, `scoreboard_id: null`, `marcador_disponible: false`, equipos A/B definidos.

**No hacer POST** sin autorización explícita.

### Advertencia producción

No ejecutar en producción salvo doble confirmación:

```bash
export DEMO_TARGET_ENV=production
export ALLOW_PRODUCTION_DEMO_SEED=true
export ALLOW_PRODUCTION_MANUAL_RESULT_DEMO=true
```

Torneos protegidos (nunca borrados por este script): **21, 23, 27, 28, 29**.
