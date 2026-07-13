# PadCoins — Niveles de fidelización (Starter → Legend)

PadCoins es moneda de fidelización; **no es dinero** para el jugador.

## Alcance

- Niveles de fidelización PadCoins basados en **`historico_total`** (PadCoins ganadas de por vida).
- **Canjear no baja de nivel** (`historico_total` no disminuye al canjear).
- Completamente **separado** del rango deportivo ARENA (`Rookie → GOAT` en `src/rangos`) y de ligas XP Arena (`INIT → LEGEND` en `src/xp`).
- Esta fase **no** incluye multiplicadores automáticos ni recompensas adicionales por nivel.

## Niveles y umbrales por defecto

| Orden | Slug | Nombre | Umbral mínimo (`historico_total`) |
|------:|------|--------|-----------------------------------:|
| 1 | `starter` | Starter | 0 |
| 2 | `bronze` | Bronze | 500 |
| 3 | `silver` | Silver | 2.000 |
| 4 | `gold` | Gold | 5.000 |
| 5 | `platinum` | Platinum | 12.000 |
| 6 | `diamond` | Diamond | 25.000 |
| 7 | `elite` | Elite | 50.000 |
| 8 | `legend` | Legend | 100.000 |

Los umbrales son **configurables por Super Admin** en `padcoins_global_config` (keys `nivel_fidelizacion_{slug}_umbral`). Si la tabla o filas no existen, el backend usa estos defaults en código.

Validaciones al editar:
- Starter debe permanecer en **0**
- Umbrales estrictamente ascendentes, sin duplicados ni negativos

## API jugador

`GET /api/padcoins/mi-saldo` — respuesta ampliada (compatible con clientes existentes):

```json
{
  "ok": true,
  "saldo": {
    "disponible": 1200,
    "historico_total": 5200
  },
  "nivel_fidelizacion": {
    "nivel_actual": 4,
    "nombre": "Gold",
    "slug": "gold",
    "umbral_minimo": 5000,
    "siguiente_nivel": "platinum",
    "siguiente_umbral": 12000,
    "progreso_actual": 200,
    "progreso_porcentaje": 2,
    "padcoins_faltantes": 6800,
    "nivel_maximo": false
  },
  "loyalty_level": { "...": "alias de nivel_fidelizacion" },
  "niveles_fidelizacion": [
    { "slug": "starter", "nombre": "Starter", "orden": 1, "umbral_minimo": 0 }
  ],
  "loyalty_levels": [ "... alias de niveles_fidelizacion" ]
}
```

## API Super Admin

| Método | Ruta | Descripción |
|--------|------|-------------|
| GET | `/api/admin/padcoins-loyalty-levels` | Consultar niveles y umbrales |
| PUT | `/api/admin/padcoins-loyalty-levels` | Editar umbrales (`body.updates[]` con `{ slug, umbral_minimo }`) |

Solo `super_admin`.

## SQL opcional

`docs/sql/padcoins_loyalty_levels_migration.sql` — seed idempotente de umbrales iniciales. **No es obligatorio** para que el backend funcione.

## Servicio

- Config: `src/padcoins/padcoinsLoyaltyLevelsConfig.js`
- Resolver: `src/padcoins/padcoinsLoyaltyLevelsService.js` → `resolvePadcoinsLoyaltyLevel(historico_total, thresholds)`
