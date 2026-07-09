# PadCoins Match Rewards — Fase 1

Backend-first: acreditar PadCoins solo cuando hay participantes identificados y validados en un partido real, sin romper reservas simples ni pagos.

## Qué cambia

### Flujo nuevo (reserva con partido vinculado)

```
Reserva → Partido abierto → Participantes (match_participants) → Validación → Acreditación PadCoins
```

1. **Cron reservas** (`src/cron/reservasCron.js`): si la reserva tiene `partido_id` o un `partidos_abiertos` vinculado por `reserva_id`, **no** acredita PadCoins automáticos al pasar el horario.
2. Se crea/asegura el participante **organizer** (`source: reservation`, `reward_status: pending`).
3. Al **confirmar resultado casual** (dual capitanes en `POST /api/partidos/:id/resultado`, o legacy `POST /api/partidos-abiertos/:id/resultado`):
   - Se sincronizan jugadores de `partidos_abiertos_jugadores` con `user_id`.
   - Se marcan como `admin_validated` (confirmación dual suficiente en Fase 1).
   - Se acreditan PadCoins de forma **idempotente** vía `match_reward_events` + `padcoins_movimientos`.

### Flujo sin cambios (reserva simple)

Reserva **sin** partido vinculado: el cron sigue llamando `acreditarPadcoinsPorReservaCompletada` al organizador (`reserva.user_id`), comportamiento compatible con producción.

## Qué no cambia

- Frontend, app nativa, Supabase directo (solo SQL documentado en `docs/sql/`).
- Torneos y ranking casual (`tabla_puntos`, `rankings_leaderboard`).
- Pagos, cancelaciones, penalizaciones y reversa PadCoins existentes.
- XP por resultado casual (capitanes) — sin cambios.

## Tablas (migración manual)

Archivo: [`docs/sql/match_participants_rewards_phase1.sql`](./sql/match_participants_rewards_phase1.sql)

| Tabla | Rol |
|-------|-----|
| `match_participants` | Quién participó, rol, asistencia, estado de recompensa |
| `match_reward_events` | Ledger idempotente (`source_key` único) |

## Servicios

| Archivo | Funciones principales |
|---------|----------------------|
| `src/matches/matchParticipantsService.js` | `upsertMatchParticipant`, `listMatchParticipants`, `markAttendance`, `ensureOrganizerParticipantFromReserva`, `getEligibleParticipantsForRewards` |
| `src/matches/matchRewardsService.js` | `evaluateReservationRewardMode`, `creditOrganizerOnlyReservationReward`, `creditValidatedMatchPadcoins`, `processReservationPadcoinsOnComplete`, `processCasualMatchPadcoinsAfterResultConfirmed` |

## Reglas de elegibilidad (Fase 1)

- `user_id` obligatorio para PadCoins.
- `attendance_status` `pending` / `denied` / `excluded` → no elegible.
- `confirmed` / `admin_validated` → elegible.
- Si **solo** el organizador está identificado y validado → PadCoins **solo** al organizador (100% del pool de la reserva).
- Si hay otros jugadores validados → reparto del pool entre elegibles + **10% bonus** al organizador (`MATCH_REWARDS_ORGANIZER_BONUS_PERCENT`, constante backend por ahora).
- Participantes en `partidos_abiertos_jugadores` **sin** `user_id` no reciben PadCoins.

## Idempotencia (`source_key`)

| Clave | Uso |
|-------|-----|
| `user\|reservation\|{reservaId}\|organizer` | Reserva simple o partido validado solo-organizador |
| `user\|match\|{type}\|{id}\|padcoins\|participant\|{userId}` | Participante en partido validado |
| `user\|match\|{type}\|{id}\|padcoins\|organizer_bonus\|{userId}` | Bonus organizador (futuro split explícito) |

El sufijo `|{userId}` en claves de partido evita colisiones en `UNIQUE(source_key)` cuando hay varios jugadores.

## Por qué no hay ranking todavía

Fase 1 se limita a PadCoins con participantes identificados. El ranking casual requiere definir RP, confirmación de asistencia más estricta (Smart Score / check-in) y no mezclar con el earn legacy de reserva. Los eventos `reward_type: ranking` existen en esquema pero **no se escriben** en esta fase.

## Cómo se evita premiar jugadores no identificados

1. Cron con partido vinculado → **cero** PadCoins automáticos.
2. Solo filas en `match_participants` con `user_id` UUID válido.
3. Acreditación post-resultado, no post-horario.
4. `match_reward_events.source_key` + idempotencia en `padcoins_movimientos` impiden duplicados.

## Próximos pasos

- **Smart Score / scoreboard** → sync participantes con `source: scoreboard`.
- **Confirmación de asistencia** explícita (QR, check-in) antes de `confirmed`.
- **Ranking casual** vía `match_reward_events` tipo `ranking`.
- Parametrizar split organizador/participantes por sede (hoy constante 10%).
- Migración ejecutada en staging → validar cron + resultado E2E antes de producción.

## Deploy checklist

1. Ejecutar SQL en Supabase staging.
2. Deploy backend.
3. Verificar reserva simple sigue acreditando.
4. Verificar reserva+partido difiere hasta resultado.
5. Confirmar resultado con 2+ jugadores `user_id` y revisar `match_reward_events` + saldo.
