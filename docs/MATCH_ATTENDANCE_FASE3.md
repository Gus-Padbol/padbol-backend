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

1. Notificaciones + cron de vencimiento.
2. Acreditación PadCoins/Ranking tras ventana `ready`.
3. Endpoints admin + overrides por sede.
