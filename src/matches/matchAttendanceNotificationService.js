import { createNotificacionIfAbsent } from '../../utils/notificaciones.js';
import { sendPushToUser } from '../../utils/push.js';
import {
  getMatchAttendanceFirstReminderHours,
  getMatchAttendanceReminderBatchSize,
  getMatchAttendanceSecondReminderHours,
  isAttendanceConfirmationEnabledForMatch,
  isMatchAttendanceConfirmationEnabled,
  isMatchAttendanceRemindersEnabled,
} from './matchAttendanceConfig.js';
import {
  MATCH_ATTENDANCE_COLLECTION_STATUS,
  MATCH_ATTENDANCE_STATUS,
  MATCH_TYPES,
  isValidUserId,
  normalizeAttendanceStatus,
  normalizeMatchId,
} from './matchParticipantsConstants.js';
import { listMatchParticipants } from './matchParticipantsService.js';

export const ATTENDANCE_NOTIFICATION_TYPE = 'asistencia_partido_pendiente';
export const ATTENDANCE_NOTIFICATION_SOURCE = 'attendance_phase3';
export const ATTENDANCE_NOTIFICATION_ACTION = 'confirmar_asistencia';

export const ATTENDANCE_NOTIFICATION_TITLE = 'Confirmá si jugaste';
export const ATTENDANCE_NOTIFICATION_MESSAGE =
  'El partido ya terminó. Confirmá tu asistencia antes del vencimiento para recibir tus recompensas.';

export const ATTENDANCE_REMINDER_24H_TITLE = 'Recordatorio: confirmá tu asistencia';
export const ATTENDANCE_REMINDER_24H_MESSAGE =
  'Todavía podés confirmar si jugaste este partido antes del vencimiento.';

export const ATTENDANCE_REMINDER_48H_TITLE = 'Último recordatorio de asistencia';
export const ATTENDANCE_REMINDER_48H_MESSAGE =
  'Queda poco tiempo para confirmar si jugaste este partido y recibir tus recompensas.';

export const ATTENDANCE_NOTIFICATION_STAGES = Object.freeze({
  INITIAL: 'initial',
  REMINDER_24H: 'reminder_24h',
  REMINDER_48H: 'reminder_48h',
});

const PARTICIPANTS_REMINDER_SELECT =
  'id, user_id, match_id, attendance_status, attendance_requested_at, reward_status';

const OPEN_PARTIDOS_REMINDER_SELECT =
  'id, attendance_opened_at, attendance_deadline_at, attendance_collection_status, partido_torneo_id, torneo_id, estado';

export function buildAttendanceNotificationDedupeKey(matchId, userId, stage) {
  const normalizedMatchId = normalizeMatchId(matchId);
  const normalizedUserId = String(userId ?? '').trim();
  return `attendance|match|${normalizedMatchId}|user|${normalizedUserId}|${stage}`;
}

export function buildAttendanceNotificationData(matchId, {
  deadlineAt = null,
  stage = ATTENDANCE_NOTIFICATION_STAGES.INITIAL,
} = {}) {
  return {
    partido_id: Number(matchId) || null,
    deadline_at: deadlineAt,
    action: ATTENDANCE_NOTIFICATION_ACTION,
    source: ATTENDANCE_NOTIFICATION_SOURCE,
    reminder_stage: stage === ATTENDANCE_NOTIFICATION_STAGES.INITIAL ? null : stage,
  };
}

function buildAttendanceNotificationPayload(matchId, userId, {
  deadlineAt = null,
  stage = ATTENDANCE_NOTIFICATION_STAGES.INITIAL,
  title = ATTENDANCE_NOTIFICATION_TITLE,
  message = ATTENDANCE_NOTIFICATION_MESSAGE,
} = {}) {
  const dedupeKey = buildAttendanceNotificationDedupeKey(matchId, userId, stage);

  return {
    user_id: userId,
    tipo: ATTENDANCE_NOTIFICATION_TYPE,
    titulo: title,
    mensaje: message,
    data: {
      ...buildAttendanceNotificationData(matchId, { deadlineAt, stage }),
      dedupe_key: dedupeKey,
    },
  };
}

function shouldSkipAttendanceNotificationPartido(partido = {}) {
  if (partido.partido_torneo_id != null || partido.torneo_id != null) {
    return { skip: true, reason: 'torneo_out_of_scope' };
  }
  if (String(partido.estado ?? '').trim().toLowerCase() === 'cancelado') {
    return { skip: true, reason: 'partido_cancelado' };
  }
  return { skip: false };
}

function isAttendanceReminderDeadlineValid(deadlineAt, now = new Date()) {
  if (!deadlineAt) return true;
  const deadlineMs = new Date(deadlineAt).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  return Number.isFinite(deadlineMs) && deadlineMs > nowMs;
}

export function resolveAttendanceReminderStage(openedAt, now = new Date(), {
  firstReminderHours = getMatchAttendanceFirstReminderHours(),
  secondReminderHours = getMatchAttendanceSecondReminderHours(),
} = {}) {
  const openedMs = new Date(openedAt).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(openedMs)) return null;

  const elapsedHours = (nowMs - openedMs) / (60 * 60 * 1000);

  if (elapsedHours >= secondReminderHours) {
    return ATTENDANCE_NOTIFICATION_STAGES.REMINDER_48H;
  }
  if (elapsedHours >= firstReminderHours) {
    return ATTENDANCE_NOTIFICATION_STAGES.REMINDER_24H;
  }

  return null;
}

function reminderCopyForStage(stage) {
  if (stage === ATTENDANCE_NOTIFICATION_STAGES.REMINDER_48H) {
    return {
      title: ATTENDANCE_REMINDER_48H_TITLE,
      message: ATTENDANCE_REMINDER_48H_MESSAGE,
    };
  }
  return {
    title: ATTENDANCE_REMINDER_24H_TITLE,
    message: ATTENDANCE_REMINDER_24H_MESSAGE,
  };
}

async function markParticipantAttendanceRequestedAt(supabaseAdmin, participantId, {
  now = new Date(),
} = {}) {
  if (!participantId) return { ok: false, reason: 'invalid_participant' };

  const requestedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  const { data, error } = await supabaseAdmin
    .from('match_participants')
    .update({
      attendance_requested_at: requestedAt,
      updated_at: requestedAt,
    })
    .eq('id', participantId)
    .is('attendance_requested_at', null)
    .select('id, attendance_requested_at')
    .maybeSingle();

  if (error) throw error;
  return { ok: true, updated: Boolean(data), participant: data ?? null };
}

export async function sendAttendanceNotificationToParticipant(supabaseAdmin, {
  matchId,
  participant,
  deadlineAt = null,
  stage = ATTENDANCE_NOTIFICATION_STAGES.INITIAL,
  deps = {},
} = {}) {
  const userId = participant?.user_id;
  if (!isValidUserId(userId)) {
    return { ok: true, skipped: true, reason: 'invalid_user_id' };
  }

  if (normalizeAttendanceStatus(participant?.attendance_status) !== MATCH_ATTENDANCE_STATUS.PENDING) {
    return { ok: true, skipped: true, reason: 'not_pending' };
  }

  if (stage === ATTENDANCE_NOTIFICATION_STAGES.INITIAL && participant.attendance_requested_at) {
    return { ok: true, skipped: true, reason: 'already_requested', duplicate: true };
  }

  const copy = stage === ATTENDANCE_NOTIFICATION_STAGES.INITIAL
    ? { title: ATTENDANCE_NOTIFICATION_TITLE, message: ATTENDANCE_NOTIFICATION_MESSAGE }
    : reminderCopyForStage(stage);

  const payload = buildAttendanceNotificationPayload(matchId, userId, {
    deadlineAt,
    stage,
    ...copy,
  });

  const createFn = deps.createNotificacionIfAbsent ?? createNotificacionIfAbsent;
  const pushFn = deps.sendPushToUser ?? sendPushToUser;

  const notificationResult = await createFn(supabaseAdmin, payload);
  if (notificationResult.duplicate) {
    if (stage === ATTENDANCE_NOTIFICATION_STAGES.INITIAL) {
      await markParticipantAttendanceRequestedAt(supabaseAdmin, participant.id, {
        now: deps.now,
      }).catch(() => null);
    }
    return {
      ok: true,
      skipped: true,
      duplicate: true,
      reason: 'notification_duplicate',
      stage,
    };
  }

  if (!notificationResult.created) {
    return {
      ok: false,
      skipped: false,
      reason: 'notification_create_failed',
      stage,
    };
  }

  let pushResult = { ok: false, skipped: true };
  try {
    pushResult = await pushFn(supabaseAdmin, userId, {
      title: copy.title,
      body: copy.message,
      data: {
        tipo: ATTENDANCE_NOTIFICATION_TYPE,
        partido_id: String(matchId),
        deadline_at: deadlineAt,
        action: ATTENDANCE_NOTIFICATION_ACTION,
        source: ATTENDANCE_NOTIFICATION_SOURCE,
        reminder_stage: stage === ATTENDANCE_NOTIFICATION_STAGES.INITIAL ? null : stage,
      },
    });
  } catch (err) {
    console.warn(
      `[Attendance Fase 3.5] push error partido=${matchId} user=${userId} stage=${stage}:`,
      err?.message ?? err,
    );
    pushResult = { ok: false, reason: 'push_exception' };
  }

  if (stage === ATTENDANCE_NOTIFICATION_STAGES.INITIAL) {
    await markParticipantAttendanceRequestedAt(supabaseAdmin, participant.id, {
      now: deps.now,
    }).catch((err) => {
      console.warn(
        `[Attendance Fase 3.5] mark requested_at error participant=${participant.id}:`,
        err?.message ?? err,
      );
    });
  }

  return {
    ok: true,
    sent: true,
    stage,
    notification: notificationResult.notificacion ?? null,
    push: pushResult,
  };
}

export async function notifyInitialAttendancePendingParticipants(supabaseAdmin, matchId, {
  deadlineAt = null,
  partido = null,
  participants = null,
  deps = {},
} = {}) {
  if (!isMatchAttendanceConfirmationEnabled()) {
    return { ok: true, skipped: true, reason: 'feature_disabled', notified: 0 };
  }

  if (partido && !isAttendanceConfirmationEnabledForMatch(partido)) {
    return { ok: true, skipped: true, reason: 'feature_disabled', notified: 0 };
  }

  const partidoSkip = shouldSkipAttendanceNotificationPartido(partido ?? {});
  if (partidoSkip.skip) {
    return { ok: true, skipped: true, reason: partidoSkip.reason, notified: 0 };
  }

  const normalizedMatchId = normalizeMatchId(matchId);
  if (!normalizedMatchId) {
    return { ok: false, reason: 'invalid_match_id', notified: 0 };
  }

  const rows = participants ?? await listMatchParticipants(supabaseAdmin, {
    matchType: MATCH_TYPES.CASUAL,
    matchId: normalizedMatchId,
  });

  const pending = (rows ?? []).filter(
    (row) => isValidUserId(row.user_id)
      && normalizeAttendanceStatus(row.attendance_status) === MATCH_ATTENDANCE_STATUS.PENDING,
  );

  const results = {
    ok: true,
    match_id: Number(matchId),
    notified: 0,
    skipped: 0,
    duplicates: 0,
    errors: 0,
    push_failures: 0,
  };

  for (const participant of pending) {
    try {
      const result = await sendAttendanceNotificationToParticipant(supabaseAdmin, {
        matchId,
        participant,
        deadlineAt,
        stage: ATTENDANCE_NOTIFICATION_STAGES.INITIAL,
        deps,
      });

      if (result.skipped && result.duplicate) {
        results.duplicates += 1;
        results.skipped += 1;
        continue;
      }
      if (result.skipped) {
        results.skipped += 1;
        continue;
      }
      if (result.ok === false) {
        results.errors += 1;
        continue;
      }

      results.notified += 1;
      if (result.push?.ok === false && result.push?.skipped !== true) {
        results.push_failures += 1;
      }
    } catch (err) {
      results.errors += 1;
      console.warn(
        `[Attendance Fase 3.5] initial notify error partido=${matchId} user=${participant.user_id}:`,
        err?.message ?? err,
      );
    }
  }

  if (results.notified > 0 || results.errors > 0) {
    console.log(
      `[Attendance Fase 3.5] initial notifications partido=${matchId} notified=${results.notified} skipped=${results.skipped} duplicates=${results.duplicates} errors=${results.errors}`,
    );
  }

  return results;
}

export async function fetchOpenPartidosForAttendanceReminders(supabaseAdmin, {
  limit = getMatchAttendanceReminderBatchSize(),
} = {}) {
  if (!isMatchAttendanceConfirmationEnabled() || !isMatchAttendanceRemindersEnabled()) {
    return [];
  }

  const effectiveLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : getMatchAttendanceReminderBatchSize();

  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select(OPEN_PARTIDOS_REMINDER_SELECT)
    .eq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN)
    .is('partido_torneo_id', null)
    .is('torneo_id', null)
    .order('attendance_opened_at', { ascending: true })
    .limit(effectiveLimit);

  if (error) throw error;

  return (data ?? []).filter((partido) => !shouldSkipAttendanceNotificationPartido(partido).skip);
}

export async function fetchPendingParticipantsForOpenPartido(supabaseAdmin, matchId) {
  const normalizedMatchId = normalizeMatchId(matchId);
  if (!normalizedMatchId) return [];

  const { data, error } = await supabaseAdmin
    .from('match_participants')
    .select(PARTICIPANTS_REMINDER_SELECT)
    .eq('match_type', MATCH_TYPES.CASUAL)
    .eq('match_id', normalizedMatchId)
    .eq('attendance_status', MATCH_ATTENDANCE_STATUS.PENDING);

  if (error) throw error;
  return (data ?? []).filter((row) => isValidUserId(row.user_id));
}

export async function processAttendanceReminders(supabaseAdmin, options = {}) {
  const {
    now = new Date(),
    batchSize = getMatchAttendanceReminderBatchSize(),
    deps = {},
  } = options;

  const summary = {
    ok: true,
    examined: 0,
    sent: 0,
    skipped: 0,
    duplicates: 0,
    errors: 0,
  };

  if (!isMatchAttendanceConfirmationEnabled()) {
    return { ...summary, cron_skipped: true, reason: 'feature_disabled' };
  }

  if (!isMatchAttendanceRemindersEnabled()) {
    return { ...summary, cron_skipped: true, reason: 'reminders_disabled' };
  }

  const partidos = await fetchOpenPartidosForAttendanceReminders(supabaseAdmin, {
    limit: batchSize,
  });

  for (const partido of partidos) {
    if (!isAttendanceReminderDeadlineValid(partido.attendance_deadline_at, now)) {
      continue;
    }

    const stage = resolveAttendanceReminderStage(partido.attendance_opened_at, now);
    if (!stage) {
      continue;
    }

    const participants = await fetchPendingParticipantsForOpenPartido(
      supabaseAdmin,
      partido.id,
    );

    for (const participant of participants) {
      summary.examined += 1;

      try {
        const result = await sendAttendanceNotificationToParticipant(supabaseAdmin, {
          matchId: partido.id,
          participant,
          deadlineAt: partido.attendance_deadline_at ?? null,
          stage,
          deps: { ...deps, now },
        });

        if (result.skipped && result.duplicate) {
          summary.duplicates += 1;
          summary.skipped += 1;
          continue;
        }
        if (result.skipped) {
          summary.skipped += 1;
          continue;
        }
        if (result.ok === false) {
          summary.errors += 1;
          continue;
        }
        if (result.sent) {
          summary.sent += 1;
        }
      } catch (err) {
        summary.errors += 1;
        console.warn(
          `[Attendance Fase 3.5] reminder error partido=${partido.id} user=${participant.user_id}:`,
          err?.message ?? err,
        );
      }

      if (summary.examined >= batchSize) {
        break;
      }
    }

    if (summary.examined >= batchSize) {
      break;
    }
  }

  if (summary.sent > 0 || summary.errors > 0) {
    console.log(
      `[Attendance Fase 3.5] reminders examined=${summary.examined} sent=${summary.sent} skipped=${summary.skipped} duplicates=${summary.duplicates} errors=${summary.errors}`,
    );
  }

  return summary;
}
