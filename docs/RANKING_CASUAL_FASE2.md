# Ranking Casual — Fase 2

Estadísticas persistentes en `rankings_leaderboard` y exposición en el endpoint público `GET /api/rankings/:deporte`.

## Reglas de RP (sin cambios respecto a Fase 1)

| Resultado | RP |
|-----------|-----|
| Victoria | +3 |
| Derrota | +1 |
| Empate manual | +2 |

`puntos` sigue siendo el RP acumulado del jugador en el leaderboard.

## Estadísticas persistidas

Columnas agregadas por `docs/sql/rankings_leaderboard_casual_stats.sql`:

| Columna | Descripción |
|---------|-------------|
| `partidos_jugados` | Partidos casuales validados contabilizados |
| `ganados` | Victorias |
| `perdidos` | Derrotas |
| `empatados` | Empates manuales |
| `racha_actual` | Racha de victorias consecutivas actual |
| `mejor_racha` | Máxima racha de victorias histórica |

### Delta por resultado

| Outcome | PJ | G | P | E | Racha |
|---------|----|---|---|---|-------|
| `win` | +1 | +1 | — | — | +1; `mejor_racha = max(mejor_racha, racha_actual)` |
| `loss` | +1 | — | +1 | — | reset a 0 |
| `draw` | +1 | — | — | +1 | reset a 0 |

## Porcentaje de victorias (API, no persistido)

```
porcentaje_victorias = 0                    si partidos_jugados = 0
porcentaje_victorias = round(ganados / partidos_jugados * 100, 2)   en otro caso
```

Implementado en `lib/rankingsLeaderboardPublic.js` → `computePorcentajeVictorias()`.

## Idempotencia

- Misma `source_key` que Fase 1: `user|match|casual|{matchId}|ranking|{userId}`.
- Tabla puerta: `match_reward_events` con `reward_type = ranking`.
- Si el evento ya está `credited`, no se vuelven a sumar RP ni estadísticas.
- Manual y Smart Score del mismo partido comparten la misma clave por usuario → no duplican.

## Recuperación de eventos `pending`

Flujo en `creditSingleUserRanking()`:

1. Buscar evento existente por `source_key`.
2. Si está `credited` → skip.
3. Si está `pending` (intento anterior interrumpido) → reutilizar ese evento, no crear duplicado.
4. Actualizar RP + stats en `rankings_leaderboard` (una lectura + una escritura por jugador).
5. Solo si la actualización fue exitosa → marcar el evento `credited` con metadata completa.
6. Si la actualización falla → el evento permanece `pending` (el schema no incluye status `failed`) para permitir reintento seguro.

Metadata del evento al acreditar:

- `outcome`, `rp`, `stats_delta`
- `partidos_jugados_after`, `ganados_after`, `perdidos_after`, `empatados_after`
- `racha_actual_after`, `mejor_racha_after`
- `participant_side`, `mode`, `puntos_totales`
- `stats_applied`, `stats_omitted_reason` (compatibilidad pre-SQL)

## Compatibilidad antes de aplicar SQL

Hasta ejecutar `docs/sql/rankings_leaderboard_casual_stats.sql` en Supabase:

- PadCoins, Smart Score y confirmación manual siguen funcionando.
- RP (Fase 1) se acredita con normalidad.
- Si las columnas de stats no existen, el servicio detecta el error (`42703`) y omite stats.
- Se registra `[Ranking Casual] stats omitidas ... reason=stats_columns_missing`.
- `metadata.stats_applied` queda en `false`; no se marca `true`.
- Tras aplicar el SQL, el mismo deploy comienza a persistir stats sin cambios de código.

## Fuera de alcance (Fase 2)

- **Corrección de resultados:** no hay reversión de RP ni stats.
- **Torneos:** skip completo (`partido_torneo_id` presente).
- **Empate Smart Score:** no soportado (mismo criterio que Fase 1).
- **CHECK de coherencia estricta** entre stats (p. ej. PJ = G + P + E): no implementado.

## Endpoint público

`GET /api/rankings/:deporte?nivel=club`

Campos adicionales por fila (sin eliminar los existentes):

- `partidos_jugados`, `ganados`, `perdidos`, `empatados`
- `racha_actual`, `mejor_racha`
- `porcentaje_victorias`

Si las columnas aún no existen en producción, el endpoint responde con stats en `0` y `porcentaje_victorias = 0`.

## Archivos principales

- `docs/sql/rankings_leaderboard_casual_stats.sql` — migración idempotente (no ejecutada)
- `src/ranking/casualMatchRankingService.js` — acreditación RP + stats
- `lib/rankingsLeaderboardPublic.js` — DTO público y cálculo de porcentaje
- `routes/rankingsLeaderboard.js` — query con fallback pre-SQL
