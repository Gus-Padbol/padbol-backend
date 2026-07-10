# Confirmación de asistencia — Fase 3.0 Backend

Preparación de schema, constantes, feature flag y **endpoints de solo lectura** para el flujo futuro «¿Jugaste este partido?».

## Alcance Fase 3.0

| Incluido | Excluido |
|----------|----------|
| SQL idempotente (no ejecutado) | Abrir ventana de confirmación |
| Constantes y normalización | POST confirmar / rechazar |
| Feature flag `MATCH_ATTENDANCE_CONFIRMATION_ENABLED` (default **off**) | Notificaciones push |
| Servicio de lectura `matchAttendanceService.js` | Cron de vencimiento |
| GET `/api/partidos/:id/asistencia` | Diferir PadCoins / Ranking |
| GET `/api/partidos/:id/asistencia/resumen` | Endpoints admin |
| Tests + fallback pre-SQL | Configuración por sede activa |
| | Cambiar `admin_validated` → `pending` |

## Comportamiento legacy intacto

- PadCoins, Ranking, Smart Score, resultado manual y cron de reservas **no cambian**.
- `creditValidatedMatchPadcoins`, `creditCasualMatchRanking` y hooks de acreditación **no se modifican**.
- Mientras el flag esté apagado: `can_respond = false`, `collection_status = none` (o valor persistido post-migración).

## Columnas preparadas

### `partidos_abiertos`

- `attendance_collection_status` — `none|open|expired|ready|credited|blocked`
- `attendance_opened_at`, `attendance_deadline_at`, `attendance_resolved_at`
- `attendance_resolution_reason`, `rewards_processed_at`

### `match_participants`

- `attendance_requested_at`, `attendance_responded_at`
- `attendance_response_source` — `player|admin|system_timeout|system_legacy`
- `attendance_denial_reason`

Archivo: [`docs/sql/match_attendance_phase3.sql`](./sql/match_attendance_phase3.sql)

## Feature flag

```bash
# NO activar en producción en Fase 3.0
MATCH_ATTENDANCE_CONFIRMATION_ENABLED=true
```

Valores reconocidos como activación: `true`, `1`, `yes`.

Lectura centralizada: `src/matches/matchAttendanceConfig.js`

## Endpoints (solo lectura)

### GET `/api/partidos/:id/asistencia`

- Auth obligatoria.
- Solo participantes del partido.
- Devuelve estado del partido + estado personal sin datos de otros jugadores.
- `can_respond`: false mientras flag apagado o ventana no abierta.

### GET `/api/partidos/:id/asistencia/resumen`

- Capitán, `admin_club` de la sede, o `super_admin`.
- Conteos agregados sin PII.

## Compatibilidad pre-SQL

Si las columnas nuevas no existen:

- `collection_status: none`, fechas `null`.
- Endpoints siguen respondiendo 200/403/404 según corresponda.
- Log `[Attendance Fase 3.0] schema columns missing…` sin ruido excesivo.

## Próximas fases

1. Abrir ventana y sync `pending`.
2. POST confirmar/rechazar.
3. Notificaciones + cron.
4. Diferir PadCoins/Ranking.
5. Admin + flag por sede.
