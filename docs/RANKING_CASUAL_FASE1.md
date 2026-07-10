# Ranking casual — Fase 1 Backend

## Qué acredita

Puntos de ranking (RP) en `rankings_leaderboard` para partidos **casuales validados** con participantes reales (`user_id`) y resultado claro.

| Outcome | RP |
|---------|-----|
| Ganador | +3 |
| Perdedor | +1 |
| Empate (si aplica) | +2 c/u |
| Sin resultado / lado indeterminado | 0 (skip) |

Scope Fase 1: `deporte` del partido (default `padbol`), `nivel = club`.

## Cuándo corre

1. **Resultado manual confirmado** — tras `processCasualMatchPadcoinsAfterResultConfirmed` (dual capitanes o legacy).
2. **Smart Score casual terminado** — tras PadCoins en `processScoreboardPadcoinsAfterFinished`.

Solo en la primera acreditación exitosa por usuario/partido (idempotente).

## Idempotencia

Ledger: `match_reward_events` con:

- `reward_type = ranking`
- `source_key = user|match|casual|{matchId}|ranking|{userId}`

Segunda ejecución (manual + Smart Score, o re-hook) **no duplica** RP ni eventos.

PadCoins usa keys distintas (`…|padcoins|…`); no se mezclan.

## Reglas de elegibilidad

- `match_type = casual`
- Participante con `user_id` UUID
- `attendance_status ∈ { confirmed, admin_validated }`
- Excluye `pending`, `denied`, `excluded`
- Torneo (`partido_torneo_id`) → skip
- Sin ganador determinable → skip (`sin_resultado_claro`)

## Determinación ganador/perdedor

| Fuente | Ganador | Lado participante |
|--------|---------|-------------------|
| Manual | `partidos_abiertos.ganador` (`equipo1` / `equipo2`) | `equipos_asignacion`, capitanes, o `team` |
| Smart Score | `sets_a` vs `sets_b` → `A` / `B` | `match_participants.team`, JSON equipos scoreboard |

## Tabla destino

**Fase 1 write:** `rankings_leaderboard` (`user_id`, `deporte`, `nivel`, `puntos`, `updated_at`).

**No toca:** `tabla_puntos`, `equipos.puntos_ranking` (dominio torneos).

**Lectura existente:** `GET /api/rankings/:deporte?nivel=club`.

### Stats extendidas (Fase 2)

`rankings_leaderboard` hoy no tiene `partidos_jugados` / `ganados` / `perdidos`. Ver `docs/sql/rankings_leaderboard_casual_stats.sql` (preparado, no ejecutado).

Metadata por partido en `match_reward_events.metadata` (`outcome`, `rp`, `participant_side`).

## Diferencias con torneos

| | Casual Fase 1 | Torneos |
|--|---------------|---------|
| Trigger | Resultado validado / Smart Score | `POST /api/torneos/:id/finalizar` |
| Tabla | `rankings_leaderboard` | `tabla_puntos` + `equipos.puntos_ranking` |
| Scoring | +3/+1/+2 fijo | FIPA por posición |
| XP | Sin cambios (manual confirm sí XP capitanes) | Rangos post-finalize |

## Qué queda para Fase 2

- Columnas de stats en leaderboard
- Nivel `nacional` / `fipa` automático
- Empate en Smart Score si producto lo habilita
- Exponer RP en respuesta API de marcador/resultado
- Ranking por sede / temporada

## Archivos

| Archivo | Rol |
|---------|-----|
| `src/ranking/casualMatchRankingService.js` | Lógica Fase 1 |
| `src/matches/matchRewardsService.js` | Hook post-PadCoins manual |
| `src/matches/scoreboardMatchRewardsService.js` | Hook post-PadCoins Smart Score |
| `lib/casualMatchRankingPhase1.test.js` | Tests |
| `docs/sql/rankings_leaderboard_casual_stats.sql` | Migración opcional stats |

## Validación local

```bash
node --check src/ranking/casualMatchRankingService.js
node --check src/matches/matchRewardsService.js
node --check src/matches/scoreboardMatchRewardsService.js
npm test
```

## Validación funcional (post-deploy)

1. Confirmar resultado casual con 2+ jugadores identificados y ganador.
2. Consultar `match_reward_events` (`reward_type = ranking`) — 1 fila por elegible.
3. Consultar `rankings_leaderboard` — `puntos` incrementados (+3/+1).
4. Repetir confirmación o Smart Score → sin nuevos eventos.
5. Torneo scoreboard → sin eventos ranking.
