# Confirmación de asistencia — Fase 3 Backend

Preparación y apertura de ventana de confirmación «¿Jugaste este partido?» para partidos casuales.

## Fase 3.0 (lectura)

| Incluido | Excluido |
|----------|----------|
| SQL idempotente | POST confirmar / rechazar |
| Constantes y normalización | Notificaciones push |
| Feature flag `MATCH_ATTENDANCE_CONFIRMATION_ENABLED` (default **off**) | Cron de vencimiento |
| GET `/api/partidos/:id/asistencia` | Acreditación diferida activa con flag OFF |
| GET `/api/partidos/:id/asistencia/resumen` | Configuración por sede activa |

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

### Plazo

Variable de entorno opcional:

```bash
MATCH_ATTENDANCE_WINDOW_HOURS=72
```

Lectura centralizada: `getMatchAttendanceWindowHours()` en `matchAttendanceConfig.js`.

### Flag OFF vs ON

| Flag | Resultado manual | Smart Score casual |
|------|------------------|-------------------|
| **OFF** | Sync `admin_validated` + PadCoins + Ranking inmediatos (sin cambios) | Flujo actual intacto |
| **ON** | Sync `pending` + ventana `open`; **no** PadCoins ni Ranking | Sync `pending` + ventana `open`; **no** PadCoins ni Ranking |

Si el flag está ON pero la ventana no puede abrirse (resultado no claro, cancelado, schema faltante): **no se acreditan** recompensas por accidente; se registra warning.

### Idempotencia

- Si la ventana ya está `open`, `expired`, `ready`, `credited` o `blocked`: no se reinicia ni se mueve el deadline.
- Segunda ejecución devuelve resultado idempotente.

### Preservación de estados

Al sincronizar participantes **no** se degradan filas ya `confirmed`, `denied`, `admin_validated` o `excluded`.

## Columnas preparadas

Ver [`docs/sql/match_attendance_phase3.sql`](./sql/match_attendance_phase3.sql).

## Feature flag

```bash
# NO activar en producción hasta fases posteriores
MATCH_ATTENDANCE_CONFIRMATION_ENABLED=true
```

Valores reconocidos: `true`, `1`, `yes`. Default: **apagado**.

## Endpoints (solo lectura — Fase 3.0)

- GET `/api/partidos/:id/asistencia` — participante autenticado.
- GET `/api/partidos/:id/asistencia/resumen` — capitán / admin_club / super_admin.

Con flag OFF: `can_respond=false`. Con flag ON y ventana open: `can_respond` evalúa estado `pending` (POST aún no implementado).

## Próximas fases

1. POST confirmar/rechazar.
2. Notificaciones + cron de vencimiento.
3. Acreditación PadCoins/Ranking tras ventana cerrada.
4. Endpoints admin + flag por sede.
