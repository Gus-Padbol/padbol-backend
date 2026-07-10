import {
  getMatchAttendanceCronExpression,
  isMatchAttendanceCronEnabled,
} from '../matches/matchAttendanceConfig.js';
import { processExpiredAttendanceWindows } from '../matches/matchAttendanceService.js';

const TZ_DEFAULT = 'America/Argentina/Buenos_Aires';

let activeCronTask = null;

export async function runMatchAttendanceCronJob({
  supabaseAdmin,
  now,
  batchSize,
  deps,
} = {}) {
  if (!supabaseAdmin) {
    return { ok: false, reason: 'supabase_missing' };
  }

  if (!isMatchAttendanceCronEnabled()) {
    return {
      ok: true,
      skipped: true,
      reason: 'cron_disabled',
      examined: 0,
      expired: 0,
      ready: 0,
      credited: 0,
      blocked: 0,
      errors: 0,
    };
  }

  return processExpiredAttendanceWindows(supabaseAdmin, {
    now,
    batchSize,
    deps,
  });
}

export function startMatchAttendanceCron({
  supabaseAdmin,
  cron,
  timezone = TZ_DEFAULT,
  deps = {},
} = {}) {
  if (!isMatchAttendanceCronEnabled()) {
    return { started: false, reason: 'cron_disabled' };
  }

  if (!cron || typeof cron.schedule !== 'function') {
    console.warn('⚠️ Cron asistencia partidos — node-cron no disponible');
    return { started: false, reason: 'cron_unavailable' };
  }

  if (activeCronTask) {
    return { started: false, reason: 'already_running' };
  }

  const expression = getMatchAttendanceCronExpression();

  const run = async () => {
    try {
      await runMatchAttendanceCronJob({ supabaseAdmin, deps });
    } catch (err) {
      console.error('❌ Cron asistencia partidos — error inesperado:', err?.message ?? err);
    }
  };

  activeCronTask = cron.schedule(expression, run, { timezone });

  console.log(
    `⏰ Cron asistencia partidos registrado (${expression}) — requiere MATCH_ATTENDANCE_CONFIRMATION_ENABLED`,
  );

  return { started: true, expression };
}

export function stopMatchAttendanceCron() {
  if (!activeCronTask) {
    return { stopped: false, reason: 'not_running' };
  }

  if (typeof activeCronTask.stop === 'function') {
    activeCronTask.stop();
  }

  activeCronTask = null;
  return { stopped: true };
}

export function isMatchAttendanceCronRunning() {
  return activeCronTask != null;
}

export function initMatchAttendanceCron(options = {}) {
  return startMatchAttendanceCron(options);
}

export function resetMatchAttendanceCronForTests() {
  activeCronTask = null;
}
