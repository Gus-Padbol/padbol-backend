# Confirmación de asistencia — Fase 3 Backend

Preparación, apertura de ventana y respuesta del jugador para partidos casuales «¿Jugaste este partido?».

## Fase 3.0 (lectura)

| Incluido | Excluido |
|----------|----------|
| SQL idempotente | Notificaciones push |
| Constantes y normalización | Cron de vencimiento |
| Feature flag `MATCH_ATTENDANCE_CONFIRMATION_ENABLED` (default **off**) | Acreditación diferida activa con flag OFF |
| GET `/api/partidos/:id/asistencia` | Configuración por sede activa |
| GET `/api/partidos/:id/asistencia/resumen` | |

## Fase 3.1 (apertura de ventana)

| Incluido | Excluido |
|----------|----------|
| `openAttendanceWindowForMatch` | POST confirmar / rechazar |
| `syncPendingParticipantsForAttendance` | Notificaciones |
| Orquestación manual + Smart Score con flag ON | Cron |
| Plazo configurable (default **72 h**) | Marcar `ready` / `credited` |
| Participantes `pending` + ventana `open` | Activación en producción |

### Apertura de ventana

Cuando un partido casual termina **y** `MATCH_ATTENDANCE_CONFIRMATION_ENABLED=true`:

1. Se sincronizan participantes reales (`partidos_abiertos_jugadores`, `equipos_asignacion`, capitanes, Smart Score).
2. Se crean/actualizan filas en `match_participants` con `attendance_status=pending`, `reward_status=pending`.
3. Se setea en `partidos_abiertos`:
   - `attendance_collection_status = open`
   - `attendance_opened_at = now`
   - `attendance_deadline_at = now + 72h`
   - `attendance_resolved_at = null`
   - `attendance_resolution_reason = null`
   - `rewards_processed_at = null`

### Flag OFF vs ON (Fase 3.1)

| Flag | Resultado manual | Smart Score casual |
|------|------------------|-------------------|
| **OFF** | Sync `admin_validated` + PadCoins + Ranking inmediatos (sin cambios) | Flujo actual intacto |
| **ON** | Sync `pending` + ventana `open`; **no** PadCoins ni Ranking | Sync `pending` + ventana `open`; **no** PadCoins ni Ranking |

## Fase 3.2 (respuesta del jugador)

| Incluido | Excluido |
|----------|----------|
| POST `/api/partidos/:id/asistencia` | Notificaciones |
| Confirmar / rechazar asistencia propia | Cron |
| `evaluateAttendanceCollectionState` | Endpoints admin |
| Transición `open → ready` o `blocked` | Acreditación PadCoins/Ranking |
| Idempotencia y cambios confirm ↔ deny | Activación en producción |

### Endpoint POST

```http
POST /api/partidos/:id/asistencia
Authorization: Bearer <JWT>
Content-Type: application/json

{
  "response": "confirm" | "deny",
  "reason": "texto opcional"
}
```

**Respuesta exitosa:**

```json
{
  "ok": true,
  "match_id": 88,
  "idempotent": false,
  "player": {
    "attendance_status": "confirmed",
    "attendance_responded_at": "...",
    "attendance_response_source": "player",
    "attendance_denial_reason": null
  },
  "match": {
    "collection_status": "open",
    "deadline_at": "...",
    "resolved_at": null,
    "resolution_reason": null
  },
  "summary": {
    "total_participants": 4,
    "pending": 2,
    "confirmed": 1,
    "denied": 0,
    "admin_validated": 1,
    "excluded": 0,
    "eligible": 1
  }
}
```

### Reglas de respuesta

| Condición | HTTP |
|-----------|------|
| Sin auth | 401 |
| Usuario ajeno al partido | 403 |
| Flag OFF | 409 |
| Ventana `none` / `ready` / `credited` / `blocked` | 409 |
| Ventana `expired` | 409 |
| `deadline_at` vencido | 409 |
| Sin fila en `match_participants` | 404 |
| `admin_validated` / `excluded` | 409 |
| Columnas Fase 3 ausentes | 503 (sin escritura parcial) |

### Efecto por acción

**Confirm (`confirm`):**
- `attendance_status = confirmed`
- `attendance_confirmed_at = now`
- `attendance_responded_at = now`
- `attendance_response_source = player`
- `attendance_denial_reason = null`
- `reward_status` permanece `pending`

**Deny (`deny`):**
- `attendance_status = denied`
- `attendance_confirmed_at = null`
- `attendance_responded_at = now`
- `attendance_response_source = player`
- `attendance_denial_reason` normalizado (máx. 280 chars) o `null`
- `reward_status` permanece `pending`

### Idempotencia y cambios

| Transición | Permitido |
|------------|-----------|
| Misma respuesta repetida | Sí (idempotente, sin alterar timestamps) |
| `pending → confirmed/denied` | Sí |
| `confirmed ↔ denied` | Sí mientras ventana `open` y sin `rewards_processed_at` |
| Modificar `admin_validated` / `excluded` | No |

### Transición agregada (`evaluateAttendanceCollectionState`)

Tras cada respuesta, con ventana `open`:

| Situación | Nuevo estado | `attendance_resolution_reason` |
|-----------|--------------|--------------------------------|
| Quedan `pending` | `open` | — |
| Sin `pending`, hay `confirmed` o `admin_validated` | `ready` | `all_responded` |
| Todos `denied` o `excluded` | `blocked` | `no_eligible_participants` |

No se marca `credited` ni se completa `rewards_processed_at` en Fase 3.2.

## Fase 3.3 (orquestador de recompensas)

| Incluido | Excluido |
|----------|----------|
| `tryFinalizeMatchAttendanceRewards` | Cron |
| Acreditación PadCoins + Ranking tras `ready` | Notificaciones |
| Transición `ready → credited` idempotente | Endpoints admin |
| Bloque `rewards` en POST asistencia | Activación en producción |
| Reproceso seguro ante fallos parciales | |

### Orquestador central

`tryFinalizeMatchAttendanceRewards(matchId, options)` en `matchAttendanceService.js`:

1. Carga partido + resumen de asistencia.
2. Verifica: casual, no torneo, no cancelado, flag ON, `attendance_collection_status = ready`, sin `rewards_processed_at`, al menos un elegible.
3. Acredita PadCoins vía `creditValidatedMatchPadcoins` (sin modificar su lógica interna).
4. Acredita Ranking vía `processCasualMatchRankingAfterResultConfirmed` o `processCasualMatchRankingAfterScoreboardFinished`.
5. Si ambas ramas terminan OK → `credited` + `rewards_processed_at = now`.

### Participantes elegibles

Solo `confirmed` y `admin_validated` con `user_id` UUID válido. Excluye `pending`, `denied`, `excluded` y filas sin `user_id`. No se modifica `attendance_status` durante la acreditación.

### Transición final

| Resultado | Estado partido |
|-----------|----------------|
| PadCoins OK + Ranking OK | `credited`, `rewards_processed_at` completado |
| Rama ya acreditada (ledger) | Rama exitosa; completa la otra si falta |
| Fallo en una rama | Permanece `ready`; reproceso seguro |
| 0 elegibles en `ready` | `blocked`, motivo `no_eligible_participants` |

Se conservan `attendance_resolved_at` y `attendance_resolution_reason` existentes (p. ej. `all_responded`).

### Idempotencia

Soporta: llamadas repetidas, doble respuesta simultánea del último participante, PadCoins credited + Ranking pendiente (y viceversa), partido ya credited, eventos pending recuperables y reintentos tras error. Los ledgers (`match_reward_events`) son la fuente de verdad; no depende solo de `rewards_processed_at`.

### Flag OFF vs ON

| Flag | Comportamiento |
|------|----------------|
| **OFF** | POST devuelve 409; flujo legacy acredita inmediato al finalizar partido |
| **ON** | No acredita antes de `ready`; tras última respuesta POST invoca orquestador automáticamente |

### POST — bloque `rewards`

Tras `evaluateAttendanceCollectionState`, si el partido queda `ready` se invoca el orquestador. Respuesta ampliada:

```json
{
  "rewards": {
    "processed": true,
    "padcoins": { "ok": true, "reason": "credited" },
    "ranking": { "ok": true, "reason": "credited" }
  }
}
```

- `processed: true` cuando ambas ramas OK y el partido quedó `credited`.
- `processed: false` si sigue `ready`, falló alguna rama o no aplicaba acreditación.
- No expone saldos ni datos sensibles de otros usuarios.

El `match.collection_status` refleja el estado final (`ready` o `credited`).

## Fase 3.4 (cron de vencimiento)

| Incluido | Excluido |
|----------|----------|
| `expireAttendanceWindow` | Notificaciones |
| `processExpiredAttendanceWindows` | Endpoints admin |
| Cron `matchAttendanceCron.js` (apagado por defecto) | Activación en producción |
| `pending → excluded` por timeout | Recordatorios |
| `timeout_partial` / `system_timeout` | Cambios SQL |

### Política de timeout

Cuando `attendance_collection_status = open`, `attendance_deadline_at <= now` y flag de confirmación ON:

| Campo participante | Valor |
|--------------------|-------|
| `attendance_status` | `excluded` (solo si era `pending`) |
| `attendance_responded_at` | `now` |
| `attendance_response_source` | `system_timeout` |
| `attendance_denial_reason` | `null` |
| `reward_status` | sin cambios (`pending`) |

No se modifican `confirmed`, `denied`, `admin_validated` ni `excluded` ya resueltos.

### Resolución del partido

Tras excluir pendientes vencidos:

| Situación | Estado | `attendance_resolution_reason` |
|-----------|--------|--------------------------------|
| Hay `confirmed` o `admin_validated` | `ready` | `timeout_partial` |
| Sin elegibles | `blocked` | `no_eligible_participants` |

No se usa `expired` como estado final estable. Si queda `ready`, se invoca `tryFinalizeMatchAttendanceRewards` (igual que Fase 3.3).

### Cron (apagado por defecto)

```bash
# NO activar en producción
MATCH_ATTENDANCE_CRON_ENABLED=true
MATCH_ATTENDANCE_CRON_INTERVAL_MINUTES=15   # default 15
MATCH_ATTENDANCE_CRON_BATCH_SIZE=50         # default 50
```

Requiere además `MATCH_ATTENDANCE_CONFIRMATION_ENABLED=true` para procesar ventanas.

El server monta el timer solo si `MATCH_ATTENDANCE_CRON_ENABLED=true`. Resumen por ejecución: examinadas, expiradas, ready, credited, blocked, errores. Idempotente; continúa ante fallo individual.

### Flag OFF vs cron OFF

| Config | Efecto |
|--------|--------|
| Confirmación OFF | No expira ventanas; legacy intacto |
| Cron OFF | No se inicia timer (default) |

## Fase 3.5 (notificaciones y recordatorios)

| Incluido | Excluido |
|----------|----------|
| Notificación inicial al abrir ventana | Endpoints admin |
| Recordatorios 24h y 48h (cron apagado) | Activación en producción |
| Dedupe vía `attendance_requested_at` + `notificaciones.data.dedupe_key` | Cambios SQL |
| Push no bloqueante | UI |

### Notificación inicial

Al abrir ventana (Fase 3.1, flag confirmación ON):

- Tipo: `asistencia_partido_pendiente`
- Solo participantes `pending` con `user_id` válido
- Título: **Confirmá si jugaste**
- Mensaje: *El partido ya terminó. Confirmá tu asistencia antes del vencimiento para recibir tus recompensas.*
- Payload: `partido_id`, `deadline_at`, `action: confirmar_asistencia`, `source: attendance_phase3`
- Sin saldos ni RP estimados

### Dedupe

| Mecanismo | Uso |
|-----------|-----|
| `attendance_requested_at` | Puerta principal notificación inicial |
| `notificaciones.data.dedupe_key` | Clave estable por etapa |

Claves:

```
attendance|match|{matchId}|user|{userId}|initial
attendance|match|{matchId}|user|{userId}|reminder_24h
attendance|match|{matchId}|user|{userId}|reminder_48h
```

Tras crear notificación interna, se completa `attendance_requested_at`. Fallo de push no bloquea apertura ni duplica notificación interna.

### Recordatorios (apagados por defecto)

```bash
# NO activar en producción
MATCH_ATTENDANCE_REMINDERS_ENABLED=true
MATCH_ATTENDANCE_FIRST_REMINDER_HOURS=24
MATCH_ATTENDANCE_SECOND_REMINDER_HOURS=48
MATCH_ATTENDANCE_REMINDER_BATCH_SIZE=100
MATCH_ATTENDANCE_REMINDER_CRON_INTERVAL_MINUTES=30
```

Requiere `MATCH_ATTENDANCE_CONFIRMATION_ENABLED=true`. Solo envía mientras ventana `open`, participante `pending` y deadline vigente.

### Flags por defecto

| Flag | Default |
|------|---------|
| `MATCH_ATTENDANCE_CONFIRMATION_ENABLED` | false |
| `MATCH_ATTENDANCE_CRON_ENABLED` | false |
| `MATCH_ATTENDANCE_REMINDERS_ENABLED` | false |

## Columnas preparadas

Ver [`docs/sql/match_attendance_phase3.sql`](./sql/match_attendance_phase3.sql).

## Feature flag

```bash
# NO activar en producción hasta fases posteriores
MATCH_ATTENDANCE_CONFIRMATION_ENABLED=true
MATCH_ATTENDANCE_WINDOW_HOURS=72
```

Default: **apagado**.

## Endpoints

| Método | Ruta | Acceso |
|--------|------|--------|
| GET | `/api/partidos/:id/asistencia` | Participante autenticado |
| GET | `/api/partidos/:id/asistencia/resumen` | Capitán / admin_club / super_admin |
| POST | `/api/partidos/:id/asistencia` | Participante con fila en `match_participants` |

## Próximas fases

1. Endpoints admin + overrides por sede.
