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
 * Resolución global + sede (Fase 3.6):
 * - global ON → habilitado;
 * - global OFF + sede ON → habilitado para esa sede;
 * - ambos OFF → deshabilitado.
 */
export function resolveAttendanceConfirmationEnabled({
  globalEnabled = isMatchAttendanceConfirmationEnabled(),
  sedeEnabled = false,
} = {}) {
  if (globalEnabled === true) return true;
  return sedeEnabled === true;
}

/**
 * @param {object|null} match — partido con sede_id (opcional)
 * @param {{ sedeEnabled?: boolean }} options — override explícito de sede
 */
export function isAttendanceConfirmationEnabledForMatch(match = null, { sedeEnabled = false } = {}) {
  void match;
  const effectiveSedeEnabled = sedeEnabled === true
    || match?.attendance_confirmation_enabled_sede === true;
  return resolveAttendanceConfirmationEnabled({
    globalEnabled: isMatchAttendanceConfirmationEnabled(),
    sedeEnabled: effectiveSedeEnabled,
  });
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

export const DEFAULT_MATCH_ATTENDANCE_FIRST_REMINDER_HOURS = 24;
export const DEFAULT_MATCH_ATTENDANCE_SECOND_REMINDER_HOURS = 48;
export const DEFAULT_MATCH_ATTENDANCE_REMINDER_BATCH_SIZE = 100;
export const DEFAULT_MATCH_ATTENDANCE_REMINDER_CRON_INTERVAL_MINUTES = 30;

export function isMatchAttendanceRemindersEnabled() {
  return parseMatchAttendanceTruthyEnv(process.env.MATCH_ATTENDANCE_REMINDERS_ENABLED);
}

export function getMatchAttendanceFirstReminderHours() {
  const raw = Number(process.env.MATCH_ATTENDANCE_FIRST_REMINDER_HOURS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MATCH_ATTENDANCE_FIRST_REMINDER_HOURS;
}

export function getMatchAttendanceSecondReminderHours() {
  const raw = Number(process.env.MATCH_ATTENDANCE_SECOND_REMINDER_HOURS);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MATCH_ATTENDANCE_SECOND_REMINDER_HOURS;
}

export function getMatchAttendanceReminderBatchSize() {
  const raw = Number(process.env.MATCH_ATTENDANCE_REMINDER_BATCH_SIZE);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MATCH_ATTENDANCE_REMINDER_BATCH_SIZE;
}

export function getMatchAttendanceReminderCronIntervalMinutes() {
  const raw = Number(process.env.MATCH_ATTENDANCE_REMINDER_CRON_INTERVAL_MINUTES);
  if (Number.isFinite(raw) && raw > 0) {
    return Math.floor(raw);
  }
  return DEFAULT_MATCH_ATTENDANCE_REMINDER_CRON_INTERVAL_MINUTES;
}

export function getMatchAttendanceReminderCronExpression() {
  const minutes = getMatchAttendanceReminderCronIntervalMinutes();
  if (minutes >= 60 && minutes % 60 === 0) {
    const hours = minutes / 60;
    return hours === 1 ? '0 * * * *' : `0 */${hours} * * *`;
  }
  if (minutes >= 60) {
    return '0 * * * *';
  }
  return `*/${minutes} * * * *`;
}
