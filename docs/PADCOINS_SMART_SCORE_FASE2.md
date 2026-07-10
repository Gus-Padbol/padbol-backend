# PadCoins Smart Score — Fase 2 Backend

## Qué conecta

Al finalizar un **scoreboard casual** (`estado` pasa a `terminado` vía `POST /api/scoreboard/partidos/:id/punto/:equipo` o ruta por control token):

1. Hook `maybeProcessCasualPadcoinsAfterScoreboardTerminated` en `routes/scoreboard.js` (junto al hook de torneos).
2. Servicio `src/matches/scoreboardMatchRewardsService.js`:
   - Resuelve vínculo casual (`partido_abierto_id` / `reserva_id`).
   - Sincroniza `match_participants` desde Smart Score.
   - Acredita PadCoins vía `creditValidatedMatchPadcoins` (Fase 1, idempotente).

## Qué no conecta (Fase 2)

| Fuera de alcance | Motivo |
|------------------|--------|
| **Torneos** (`partido_torneo_id`) | PadCoins casual no aplica; hook skip explícito |
| **Ranking casual / RP** | Pendiente fase posterior |
| **XP / Arena** | Sin cambios |
| **Reversión PadCoins en undo** | Mismo criterio que sync torneo post-undo |
| **Frontend / nativa** | Solo backend |

## Detección de scoreboard terminado

No hay endpoint dedicado de “finalizar”. El partido termina cuando `registrarPunto` / `finishSet` en `utils/scoreboardLogic.js` detecta 2 sets ganados y setea `estado = 'terminado'`.

El hook corre **solo en la primera transición** (`estadoAntes` no terminado → `saved.estado` terminado), igual que `maybeSyncTorneoAfterScoreboardTerminated`.

## Resolución de partido casual

Prioridad en `resolveCasualLinkFromScoreboard`:

1. **`partido_abierto_id`** → `match_type: casual`, `match_id = partido_abierto_id`.
2. **`reserva_id` sin partido_abierto_id**:
   - Busca `reservas.partido_id`.
   - Busca `partidos_abiertos` por `reserva_id`.
   - Si no hay partido abierto → **skip** (`reserva_sin_partido_abierto`). No inventa `match_id` sintético.

Torneo (`partido_torneo_id`) → skip (`torneo_out_of_scope`).

## Reglas de participantes

Fuentes (merge por `user_id`, sin duplicar):

1. `scoreboard_jugadores_temp` (con `user_id`, equipo `a`/`b`).
2. `equipo_a_jugadores` / `equipo_b_jugadores` JSONB (campo `user_id` o `userId`).
3. `partidos_abiertos_jugadores` (si hay `partido_abierto_id`).

Reglas:

- **Solo `user_id` UUID** recibe fila en `match_participants` y puede recibir PadCoins.
- Nombres anónimos → display only; se cuentan en `skipped_no_user_id`.
- `source: scoreboard` en upsert desde Smart Score.
- `attendance_status: admin_validated` + `reward_status: eligible` (marcador finalizado = validación suficiente Fase 2).
- Organizador: `ensureOrganizerParticipantFromReserva` + capitán/reserva.user_id reforzados con `markAttendance`.

## Resultado del marcador

`buildScoreboardResultPayload` extrae sets/games/score/ganador para metadata de respuesta y logs. **No escribe ranking** ni tablas de clasificación.

## Acreditación PadCoins

`processScoreboardPadcoinsAfterFinished` → `creditValidatedMatchPadcoins`:

- Idempotencia por `match_reward_events.source_key` + `padcoins_movimientos`.
- Segunda ejecución (re-hook o confirmación dual Fase 1) **no duplica** saldo.
- Sin participantes con `user_id` → skip (`sin_participantes_identificados`).
- Sin reserva vinculada → skip (`sin_reserva_vinculada`).

## Coexistencia con Fase 1 (resultado casual)

Si además se confirma resultado por capitanes (`processCasualMatchPadcoinsAfterResultConfirmed`), la acreditación es idempotente por las mismas `source_key`. El primer camino que corra acredita; el segundo no duplica.

## Logs

Prefijo `[PadCoins Scoreboard]` con:

- `scoreboard` id
- `partido_abierto_id` / `reserva_id`
- cantidad participantes identificados
- usuarios acreditados / total PadCoins
- skips (torneo, sin user_id, sin partido, sin reserva)

## Archivos

| Archivo | Rol |
|---------|-----|
| `src/matches/scoreboardMatchRewardsService.js` | Lógica Fase 2 |
| `routes/scoreboard.js` | Hook en `handleRegistrarPunto` |
| `lib/scoreboardPadcoinsPhase2.test.js` | Tests |
| `src/matches/matchRewardsService.js` | Reutilizado (sin cambios Fase 2) |
| `src/matches/matchParticipantsService.js` | Reutilizado |

## Validación

```bash
npm test
node --check src/matches/scoreboardMatchRewardsService.js
node --check routes/scoreboard.js
```

## Riesgos

| Riesgo | Mitigación |
|--------|------------|
| Scoreboard solo con nombres anónimos | Skip seguro, log `skipped_no_user_id` |
| Reserva sin `partidos_abiertos` | Skip documentado; requiere vínculo partido para PadCoins |
| Doble vía Smart Score + resultado capitanes | Idempotencia Fase 1 |
| Undo después de terminado | No revierte PadCoins (igual que torneo sync) |

## Pendiente (Fase 3+)

- Ranking casual / RP desde scoreboard.
- Check-in QR → `attendance_status: confirmed` estricto antes de crédito.
- Reversión PadCoins si se deshace el último punto que terminó el partido.
