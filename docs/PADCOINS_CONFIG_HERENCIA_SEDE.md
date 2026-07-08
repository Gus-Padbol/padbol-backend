# PadCoins — herencia global → sede → effective

## Resumen

Cada sede **hereda** las reglas de `padcoins_global_config` y puede definir **overrides opcionales** en `padcoins_sede_config.rule_overrides` (JSONB).

El backend expone un **resolver único**:

```js
resolvePadcoinsConfigForSede(supabaseAdmin, sedeId)
// → { global, sede_overrides, effective, sede, keys }
```

**Regla:** `effective[key] = sede_overrides[key]` si existe y es válido; si no, `global[key]` (con fallback de código si falta en DB).

## Keys soportadas

Las mismas que `padcoins_global_config` (`PADCOINS_GLOBAL_CONFIG_KEYS`):

- Earn: `partido_jugado`, `partido_ganado`, `logro_desbloqueado`, `inscripcion_torneo`, `reserva_confirmada`, `porcentaje_devolucion_reserva`, `padcoins_por_usd_equivalente`, `modo_calculo_reserva`
- Límites: `limite_diario_jugador`, `limite_mensual_jugador`
- Penalizaciones: `cancelacion_tarde`, `no_show`

No hay límite semanal en config hoy. Umbrales de alertas (`PADCOINS_ALERT_THRESHOLDS`) siguen en código, no en esta herencia.

## Formato `rule_overrides`

```json
{
  "limite_diario_jugador": 500,
  "logro_desbloqueado": 750,
  "modo_calculo_reserva": "porcentaje_valor_pagado"
}
```

También acepta `{ "value_integer": N }` / `{ "value_text": "..." }` al **leer** desde DB legacy. En **PUT** solo valores planos (número o texto).

`null` en PUT → **400** (omitir la key; el body reemplaza el JSON completo).

## Endpoints

### Lectura

`GET /api/admin/padcoins/sedes/:sedeId/config-effective`

| Rol | Acceso |
|-----|--------|
| Super Admin | Cualquier sede |
| Admin Club | Solo su `sede_id` |
| Otros | 403 |

### Escritura overrides

`PUT /api/admin/padcoins/sedes/:sedeId/rule-overrides`

Body: `{ "rule_overrides": { ... } }` — **reemplazo total** del JSON. `{}` limpia todos los overrides.

| Rol | Acceso |
|-----|--------|
| Super Admin | Cualquier sede |
| Admin Club | Solo su `sede_id` |
| Otros | 403 |

Respuesta: `{ ok, sede_id, rule_overrides, effective, global }`.

## Cableado en runtime

| Flujo | Config | `sede_id` |
|-------|--------|-----------|
| Límites earn | `getPadcoinsEarnLimitsForSede` | Del movimiento (`addPadcoins`) |
| Penalizaciones | `getPadcoinsPenaltyAmount(key, sedeId)` | De la reserva |
| **Reservas completadas** | `getPadcoinsReservationConfigForSede` | De `reserva.sede_id` (obligatorio para acreditar) |
| **Logros** | `getEffectivePadcoinsValueForSede` | Solo si `options.sede_id` explícito; si no → global |

Sin `sede_id` seguro en logros → `getPadcoinsValue` global (no se infiere sede).

## Qué NO hacer

- **Frontend / app nativa:** no calcular reglas localmente; consumir `effective` del backend.
- **Earn restante global:** partidos, torneos, ajustes admin; logros de comportamiento sin `sede_id` en contexto.
- **Duplicar defaults:** usar `PADCOINS_GLOBAL_CONFIG_DEFAULTS` y el resolver; no copiar números en otro módulo.

## Migración SQL

`docs/sql/padcoins_sede_config_rule_overrides_migration.sql` — agrega columna `rule_overrides JSONB DEFAULT '{}'`.

## Archivos

- `src/padcoins/padcoinsEffectiveConfigService.js` — resolver
- `src/padcoins/padcoinsSedeConfigService.js` — lee `rule_overrides`
- `src/routes/padcoins.js` — endpoint admin
- `lib/padcoinsEffectiveConfig.test.js` — tests herencia y permisos
