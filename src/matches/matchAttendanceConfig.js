/**
 * Feature flag — confirmación de asistencia Fase 3.
 * Lectura centralizada; no leer process.env desde otros servicios.
 */

const TRUTHY_ENV_VALUES = new Set(['true', '1', 'yes']);

export const DEFAULT_MATCH_ATTENDANCE_WINDOW_HOURS = 72;

export function parseMatchAttendanceTruthyEnv(value) {
  return TRUTHY_ENV_VALUES.has(String(value ?? '').trim().toLowerCase());
}

export function isMatchAttendanceConfirmationEnabled() {
  return parseMatchAttendanceTruthyEnv(process.env.MATCH_ATTENDANCE_CONFIRMATION_ENABLED);
}

/**
 * Preparado para configuración futura por sede.
 * Fase 3.0: solo el flag global habilita la confirmación.
 */
export function isAttendanceConfirmationEnabledForMatch(match = null) {
  void match;
  return isMatchAttendanceConfirmationEnabled();
}

/**
 * Plazo de ventana de confirmación (horas). Configurable vía env.
 */
export function getMatchAttendanceWindowHours() {
  const raw = Number(process.env.MATCH_ATTENDANCE_WINDOW_HOURS);
  if (Number.isFinite(raw) && raw > 0) {
    return raw;
  }
  return DEFAULT_MATCH_ATTENDANCE_WINDOW_HOURS;
}

export const DEFAULT_MATCH_ATTENDANCE_CRON_INTERVAL_MINUTES = 15;
export const DEFAULT_MATCH_ATTENDANCE_CRON_BATCH_SIZE = 50;

export function isMatchAttendanceCronEnabled() {
  return parseMatchAttendanceTruthyEnv(process.env.MATCH_ATTENDANCE_CRON_ENABLED);
}

export function getMatchAttendanceCronIntervalMinutes() {
  const raw = Number(process.env.MATCH_ATTENDANCE_CRON_INTERVAL_MINUTES);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MATCH_ATTENDANCE_CRON_INTERVAL_MINUTES;
}

export function getMatchAttendanceCronBatchSize() {
  const raw = Number(process.env.MATCH_ATTENDANCE_CRON_BATCH_SIZE);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MATCH_ATTENDANCE_CRON_BATCH_SIZE;
}

/**
 * Expresión cron según intervalo en minutos (default cada 15 min).
 */
export function getMatchAttendanceCronExpression() {
  const minutes = getMatchAttendanceCronIntervalMinutes();
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
  }
  if (minutes >= 60) {
    return '0 * * * *';
  }
  return `*/${minutes} * * * *`;
}
