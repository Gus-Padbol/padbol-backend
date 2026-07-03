# Flujo de llave knockout con avance automático

Documenta el ciclo completo de un torneo `tipo_torneo = 'knockout'`: desde la generación de la
llave enlazada hasta el avance automático de ganadores y la creación automática del marcador de
la ronda siguiente. Todo funciona sobre el schema real de `partidos` (sin columnas `fase`/`es_final`;
`ronda` es entero).

## 1. Generación de la llave (4 / 8 / 16 equipos)

`POST /api/torneos/:id/generar-partidos` para un torneo knockout genera **todos** los partidos de la
llave de una sola vez (no solo la primera ronda):

| Equipos | Partidos | Estructura |
|---------|----------|------------|
| 4 | 3 | 2 semifinales + 1 final |
| 8 | 7 | 4 cuartos + 2 semifinales + 1 final |
| 16 | 15 | 8 octavos + 4 cuartos + 2 semifinales + 1 final |

Reglas de generación:

- **Primera ronda**: `equipo_a_id` / `equipo_b_id` con equipos reales.
- **Rondas futuras**: `equipo_a_id = null` y `equipo_b_id = null` (slots vacíos), `estado = 'pendiente'`.
- `grupo = null` en toda la llave.
- Cantidad de equipos distinta de 4/8/16 → `400`, sin crear fixture parcial.
- Si el torneo ya tiene partidos, no se duplica.

Servicio puro: `lib/torneos/knockoutBracketService.js`
(`buildKnockoutBracketMatches`, `linkBracketMatches`, `getKnockoutRoundLabel`).

## 2. Posición en la llave: `bracket_round` / `bracket_position`

- `bracket_round`: profundidad de la ronda. `1` = primera ronda eliminatoria; a mayor valor, más
  cerca de la final.
- `bracket_position`: orden dentro de la ronda, empezando en `1` (para ordenar la UI de llave).
- `ronda` (columna legacy, entero) se setea igual a `bracket_round` por compatibilidad. Las
  etiquetas textuales ("cuartos", "semifinal", "final") se calculan on-the-fly con
  `getKnockoutRoundLabel(...)` y **no** se persisten.

## 3. Enlace entre partidos: `partido_siguiente_id` / `partido_siguiente_slot`

Cada partido fuente apunta al partido destino de la ronda siguiente:

- `partido_siguiente_id`: id del partido destino. `null` en la final (última ronda).
- `partido_siguiente_slot`: `'A'` → el ganador entra en `equipo_a_id` del destino; `'B'` → en `equipo_b_id`.

Regla de enlace (por índice de partido dentro de la ronda):

```
destino_index = Math.floor(sourceIndex / 2)
slot          = sourceIndex % 2 === 0 ? 'A' : 'B'
```

## 4. Sync scoreboard → partido

Cuando un scoreboard de torneo termina, `syncScoreboardToTorneoPartido` vuelca el resultado al
partido: setea `resultado`, `ganador_equipo_id`, `estado = 'finalizado'` y marca
`sync_torneo_status = 'synced'`. El hook vive en `maybeSyncTorneoAfterScoreboardTerminated`
(`routes/scoreboard.js`), disparado tras registrar el punto que finaliza el marcador.

## 5. Avance automático del ganador

Tras un sync exitoso (`status === 'synced'`), el hook llama
`advanceWinnerIfNeeded(supabaseAdmin, { partidoId })` (`lib/torneos/bracketAdvanceService.js`).

Reglas (respuesta estructurada, nunca lanza hacia el marcador):

- Partido inexistente → `failed / partido_not_found`.
- `estado !== 'finalizado'` → `skipped / not_finalizado`.
- `grupo` no nulo → `skipped / fase_grupos`.
- Sin ganador → `skipped / no_ganador`.
- `partido_siguiente_id` nulo → `skipped / no_destino` (final o partido legacy).
- Slot destino vacío → escribe el ganador → `advanced`.
- Slot destino ya tiene ese mismo ganador → `skipped / ya_avanzado` (idempotente).
- Slot destino ocupado por otro equipo → `conflict / slot_ocupado` (no pisa).
- Si tras avanzar el destino queda con ambos equipos, se deja `estado = 'pendiente'` (salvo que ya
  estuviera `en_curso`/`finalizado`).

Torneos legacy sin `partido_siguiente_id` siempre dan `skipped / no_destino`: no se tocan.

## 6. Creación automática del scoreboard cuando el destino queda completo

Solo cuando `advanceWinnerIfNeeded` devuelve `advanced` **y** existe `destino_partido_id`, el hook
llama `ensureScoreboardForCompletedBracketPartido(supabaseAdmin, { partidoId })`
(`lib/torneos/bracketScoreboardService.js`).

Reglas:

- Partido destino inexistente → `failed / partido_not_found`.
- Falta `equipo_a_id` o `equipo_b_id` (todavía hay un slot vacío) → `skipped / partido_incompleto`.
- `estado` `finalizado` o `en_curso` → `skipped / estado_no_apto`.
- Ya existe un `scoreboard_partidos` activo para ese `partido_torneo_id` → `skipped / scoreboard_existente` (no duplica).
- Si procede: crea el `scoreboard_partidos` (`estado = 'pendiente'`, mismos nombres/jugadores/sede/cancha
  que usa `generar-scoreboards`) y emite `control_token` → `created / scoreboard_creado`.

Cualquier error de esta etapa se loguea y **no** rompe la respuesta del marcador.

## 7. Final sin destino

La final tiene `partido_siguiente_id = null`. Al finalizarla, el avance devuelve
`skipped / no_destino`, por lo que **no** se crea ningún scoreboard adicional. El torneo queda
listo para cierre / cómputo de campeón sin efectos colaterales.

## 8. Validación E2E en producción (demo #28)

Torneo demo `#28` (`DEMO | Bracket Advance E2E`), knockout de 4 equipos, validado de punta a punta
sobre producción sin tocar torneos reales:

| Partido | Ronda | Resultado | Ganador |
|---------|-------|-----------|---------|
| Semifinal #45 | 1 | 6-0 / 6-0 | equipo **71** (avanzó a la final, slot A) |
| Semifinal #46 | 1 | 6-0 / 6-0 | equipo **73** (avanzó a la final, slot B) |
| Final #47 | 2 | 6-0 / 6-0 | equipo **71** (campeón) |

Comportamiento observado:

- Al finalizar cada semifinal, el ganador avanzó automáticamente al slot correspondiente de la final.
- Al completarse la final (`equipo_a_id = 71`, `equipo_b_id = 73`) se creó automáticamente su
  scoreboard (`estado = 'pendiente'`, con `control_token`).
- Al finalizar la final, `advanceWinnerIfNeeded` devolvió `skipped / no_destino` y no se creó ningún
  scoreboard extra.
- **Scoreboards del demo #28: 3** (uno por partido, sin duplicados).
- Torneos protegidos intactos durante toda la validación: **#21 = 6 partidos, #23 = 16, #27 = 1**.

## Archivos relevantes

- `lib/torneos/knockoutBracketService.js` — generación y enlace de la llave.
- `lib/torneos/bracketAdvanceService.js` — avance automático del ganador.
- `lib/torneos/bracketScoreboardService.js` — creación automática del scoreboard del destino completo.
- `src/scoreboard/scoreboardTorneoSyncService.js` — sync scoreboard → partido.
- `routes/scoreboard.js` — hook `maybeSyncTorneoAfterScoreboardTerminated` (sync → advance → scoreboard).
- `docs/sql/bracket_advance_migration.sql` — migración de columnas de llave.
