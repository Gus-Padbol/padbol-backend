import {
  getMatchAttendanceReminderCronExpression,
  isMatchAttendanceRemindersEnabled,
} from '../matches/matchAttendanceConfig.js';
import { processAttendanceReminders } from '../matches/matchAttendanceNotificationService.js';

const TZ_DEFAULT = 'America/Argentina/Buenos_Aires';

let activeReminderCronTask = null;

export async function runMatchAttendanceReminderCronJob({
  supabaseAdmin,
  now,
  batchSize,
  deps,
} = {}) {
  if (!supabaseAdmin) {
    return { ok: false, reason: 'supabase_missing' };
  }

  if (!isMatchAttendanceRemindersEnabled()) {
    return {
      ok: true,
      skipped: true,
      reason: 'reminders_disabled',
      examined: 0,
      sent: 0,
      skipped_count: 0,
      duplicates: 0,
      errors: 0,
    };
  }

  return processAttendanceReminders(supabaseAdmin, {
    now,
    batchSize,
    deps,
  });
}

export function startMatchAttendanceReminderCron({
  supabaseAdmin,
  cron,
  timezone = TZ_DEFAULT,
  deps = {},
} = {}) {
  if (!isMatchAttendanceRemindersEnabled()) {
    return { started: false, reason: 'reminders_disabled' };
  }

  if (!cron || typeof cron.schedule !== 'function') {
    console.warn('⚠️ Cron recordatorios asistencia — node-cron no disponible');
    return { started: false, reason: 'cron_unavailable' };
  }

  if (activeReminderCronTask) {
    return { started: false, reason: 'already_running' };
  }

  const expression = getMatchAttendanceReminderCronExpression();

  const run = async () => {
    try {
      await runMatchAttendanceReminderCronJob({ supabaseAdmin, deps });
    } catch (err) {
      console.error('❌ Cron recordatorios asistencia — error inesperado:', err?.message ?? err);
    }
  };

  activeReminderCronTask = cron.schedule(expression, run, { timezone });

  console.log(
    `⏰ Cron recordatorios asistencia registrado (${expression}) — requiere MATCH_ATTENDANCE_CONFIRMATION_ENABLED y MATCH_ATTENDANCE_REMINDERS_ENABLED`,
  );

  return { started: true, expression };
}

export function stopMatchAttendanceReminderCron() {
  if (!activeReminderCronTask) {
    return { stopped: false, reason: 'not_running' };
  }

  if (typeof activeReminderCronTask.stop === 'function') {
    activeReminderCronTask.stop();
  }

  activeReminderCronTask = null;
  return { stopped: true };
}

export function isMatchAttendanceReminderCronRunning() {
  return activeReminderCronTask != null;
}

export function initMatchAttendanceReminderCron(options = {}) {
  return startMatchAttendanceReminderCron(options);
}

export function resetMatchAttendanceReminderCronForTests() {
  activeReminderCronTask = null;
}
