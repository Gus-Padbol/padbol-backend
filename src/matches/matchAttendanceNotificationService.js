import { createNotificacionIfAbsent, logNotificacionDiagnostic } from '../../utils/notificaciones.js';
import { sendPushToUser } from '../../utils/push.js';
import {
  getMatchAttendanceFirstReminderHours,
  getMatchAttendanceReminderBatchSize,
  getMatchAttendanceSecondReminderHours,
  isMatchAttendanceConfirmationEnabled,
  isMatchAttendanceRemindersEnabled,
} from './matchAttendanceConfig.js';
import { resolveAttendanceFeatureForPartido } from './matchAttendanceSedeConfigService.js';
import { isTorneoOutOfScopeForCasualAttendance } from './matchAttendanceTorneoScope.js';
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

export const ATTENDANCE_WINDOW_CLOSED_TITLE = 'Ventana de asistencia cerrada';
export const ATTENDANCE_WINDOW_CLOSED_MESSAGE =
  'El plazo para confirmar asistencia en este partido venció.';
export const ATTENDANCE_WINDOW_CLOSED_CONFIRMED_MESSAGE =
  'El plazo de confirmación cerró. Tus recompensas se procesaron según tu asistencia confirmada.';

export const ATTENDANCE_NOTIFICATION_STAGES = Object.freeze({
  INITIAL: 'initial',
  REMINDER_24H: 'reminder_24h',
  REMINDER_48H: 'reminder_48h',
  WINDOW_CLOSED: 'window_closed',
});

const PARTICIPANTS_REMINDER_SELECT =
  'id, user_id, match_id, attendance_status, attendance_requested_at, reward_status';

const OPEN_PARTIDOS_REMINDER_SELECT =
  'id, sede_id, attendance_opened_at, attendance_deadline_at, attendance_collection_status, estado';

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

export function classifyAttendanceNotificationParticipant(participant) {
  const userId = participant?.user_id;
  if (!isValidUserId(userId)) {
    return { eligible: false, reason: 'invalid_user_id' };
  }
  const status = normalizeAttendanceStatus(participant?.attendance_status);
  if (status !== MATCH_ATTENDANCE_STATUS.PENDING) {
    return { eligible: false, reason: 'not_pending', attendance_status: status };
  }
  if (participant?.attendance_requested_at) {
    return { eligible: false, reason: 'already_requested', duplicate: true };
  }
  return { eligible: true, reason: 'candidate', attendance_status: status };
}

function shouldSkipAttendanceNotificationPartido(partido = {}) {
  if (isTorneoOutOfScopeForCasualAttendance({ partido })) {
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

export function resolveAttendanceReminderStages(openedAt, now = new Date(), {
  firstReminderHours = getMatchAttendanceFirstReminderHours(),
  secondReminderHours = getMatchAttendanceSecondReminderHours(),
} = {}) {
  const openedMs = new Date(openedAt).getTime();
  const nowMs = now instanceof Date ? now.getTime() : new Date(now).getTime();
  if (!Number.isFinite(openedMs)) return [];

  const elapsedHours = (nowMs - openedMs) / (60 * 60 * 1000);
  const stages = [];

  if (elapsedHours >= firstReminderHours) {
    stages.push(ATTENDANCE_NOTIFICATION_STAGES.REMINDER_24H);
  }
  if (elapsedHours >= secondReminderHours) {
    stages.push(ATTENDANCE_NOTIFICATION_STAGES.REMINDER_48H);
  }

  return stages;
}

function reminderCopyForStage(stage) {
  if (stage === ATTENDANCE_NOTIFICATION_STAGES.REMINDER_48H) {
    return {
      title: ATTENDANCE_REMINDER_48H_TITLE,
      message: ATTENDANCE_REMINDER_48H_MESSAGE,
    };
  }
  if (stage === ATTENDANCE_NOTIFICATION_STAGES.WINDOW_CLOSED) {
    return {
      title: ATTENDANCE_WINDOW_CLOSED_TITLE,
      message: ATTENDANCE_WINDOW_CLOSED_MESSAGE,
    };
  }
  return {
    title: ATTENDANCE_REMINDER_24H_TITLE,
    message: ATTENDANCE_REMINDER_24H_MESSAGE,
  };
}

function windowClosedCopyForParticipant(participant) {
  const status = normalizeAttendanceStatus(participant?.attendance_status);
  if (
    status === MATCH_ATTENDANCE_STATUS.CONFIRMED
    || status === MATCH_ATTENDANCE_STATUS.ADMIN_VALIDATED
  ) {
    return {
      title: ATTENDANCE_WINDOW_CLOSED_TITLE,
      message: ATTENDANCE_WINDOW_CLOSED_CONFIRMED_MESSAGE,
    };
  }
  return {
    title: ATTENDANCE_WINDOW_CLOSED_TITLE,
    message: ATTENDANCE_WINDOW_CLOSED_MESSAGE,
  };
}

function shouldNotifyParticipantOnWindowClose(participant) {
  const status = normalizeAttendanceStatus(participant?.attendance_status);
  if (!isValidUserId(participant?.user_id)) {
    return false;
  }
  return status !== MATCH_ATTENDANCE_STATUS.DENIED;
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
  if (partido) {
    const { featureEnabled } = await resolveAttendanceFeatureForPartido(supabaseAdmin, partido);
    if (!featureEnabled) {
      return { ok: true, skipped: true, reason: 'feature_disabled', notified: 0 };
    }
  } else if (!isMatchAttendanceConfirmationEnabled()) {
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
    participant_outcomes: [],
  };

  for (const participant of rows ?? []) {
    const classification = classifyAttendanceNotificationParticipant(participant);
    if (!classification.eligible) {
      results.participant_outcomes.push({
        user_id: participant?.user_id ?? null,
        role: participant?.role ?? null,
        outcome: classification.duplicate ? 'duplicate' : 'skipped',
        reason: classification.reason,
        attendance_status: classification.attendance_status ?? participant?.attendance_status ?? null,
      });
    }
  }

  for (const participant of pending) {
    try {
      const result = await sendAttendanceNotificationToParticipant(supabaseAdmin, {
        matchId,
        participant,
        deadlineAt,
        stage: ATTENDANCE_NOTIFICATION_STAGES.INITIAL,
        deps,
      });

      const outcome = {
        user_id: participant.user_id,
        role: participant.role ?? null,
        outcome: 'unknown',
        reason: result.reason ?? null,
        attendance_status: participant.attendance_status ?? null,
      };

      if (result.skipped && result.duplicate) {
        results.duplicates += 1;
        results.skipped += 1;
        outcome.outcome = 'duplicate';
        results.participant_outcomes.push(outcome);
        logNotificacionDiagnostic('attendance_notify_duplicate', {
          match_id: matchId,
          user_id: participant.user_id,
          reason: result.reason,
        });
        continue;
      }
      if (result.skipped) {
        results.skipped += 1;
        outcome.outcome = 'skipped';
        results.participant_outcomes.push(outcome);
        logNotificacionDiagnostic('attendance_notify_skipped', {
          match_id: matchId,
          user_id: participant.user_id,
          reason: result.reason,
        });
        continue;
      }
      if (result.ok === false) {
        results.errors += 1;
        outcome.outcome = 'insert_error';
        results.participant_outcomes.push(outcome);
        logNotificacionDiagnostic('attendance_notify_insert_error', {
          match_id: matchId,
          user_id: participant.user_id,
          reason: result.reason,
        });
        continue;
      }

      results.notified += 1;
      outcome.outcome = 'insert_success';
      outcome.notification_id = result.notification?.id ?? null;
      results.participant_outcomes.push(outcome);
      logNotificacionDiagnostic('attendance_notify_insert_success', {
        match_id: matchId,
        user_id: participant.user_id,
        notification_id: outcome.notification_id,
      });
      if (result.push?.ok === false && result.push?.skipped !== true) {
        results.push_failures += 1;
        logNotificacionDiagnostic('attendance_notify_push_failure', {
          match_id: matchId,
          user_id: participant.user_id,
          reason: result.push?.reason ?? 'push_failed',
        });
      } else {
        logNotificacionDiagnostic('attendance_notify_push_success', {
          match_id: matchId,
          user_id: participant.user_id,
        });
      }
    } catch (err) {
      results.errors += 1;
      results.participant_outcomes.push({
        user_id: participant.user_id,
        role: participant.role ?? null,
        outcome: 'error',
        reason: err?.message ?? 'exception',
        attendance_status: participant.attendance_status ?? null,
      });
      console.warn(
        `[Attendance Fase 3.5] initial notify error partido=${matchId} user=${participant.user_id}:`,
        err?.message ?? err,
      );
    }
  }

  if (results.notified > 0 || results.errors > 0 || results.skipped > 0) {
    console.log(
      `[Attendance Fase 3.5] initial notifications partido=${matchId} notified=${results.notified} skipped=${results.skipped} duplicates=${results.duplicates} errors=${results.errors}`,
    );
  }

  return results;
}

export async function fetchOpenPartidosForAttendanceReminders(supabaseAdmin, {
  limit = getMatchAttendanceReminderBatchSize(),
} = {}) {
  if (!isMatchAttendanceRemindersEnabled()) {
    return [];
  }

  const effectiveLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : getMatchAttendanceReminderBatchSize();

  const { data, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select(OPEN_PARTIDOS_REMINDER_SELECT)
    .eq('attendance_collection_status', MATCH_ATTENDANCE_COLLECTION_STATUS.OPEN)
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

  if (!isMatchAttendanceRemindersEnabled()) {
    return { ...summary, cron_skipped: true, reason: 'reminders_disabled' };
  }

  const partidos = await fetchOpenPartidosForAttendanceReminders(supabaseAdmin, {
    limit: batchSize,
  });

  for (const partido of partidos) {
    const { featureEnabled } = await resolveAttendanceFeatureForPartido(supabaseAdmin, partido);
    if (!featureEnabled) {
      continue;
    }

    if (!isAttendanceReminderDeadlineValid(partido.attendance_deadline_at, now)) {
      continue;
    }

    const stages = resolveAttendanceReminderStages(partido.attendance_opened_at, now);
    if (stages.length === 0) {
      continue;
    }

    const participants = await fetchPendingParticipantsForOpenPartido(
      supabaseAdmin,
      partido.id,
    );

    for (const participant of participants) {
      for (const stage of stages) {
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
            `[Attendance Fase 3.5] reminder error partido=${partido.id} user=${participant.user_id} stage=${stage}:`,
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

export async function notifyAttendanceWindowClosed(supabaseAdmin, matchId, {
  partido = null,
  participants = null,
  deadlineAt = null,
  deps = {},
} = {}) {
  if (partido) {
    const { featureEnabled } = await resolveAttendanceFeatureForPartido(supabaseAdmin, partido);
    if (!featureEnabled) {
      return { ok: true, skipped: true, reason: 'feature_disabled', notified: 0 };
    }
  } else if (!isMatchAttendanceConfirmationEnabled()) {
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

  const results = {
    ok: true,
    match_id: Number(matchId),
    notified: 0,
    skipped: 0,
    duplicates: 0,
    errors: 0,
  };

  const createFn = deps.createNotificacionIfAbsent ?? createNotificacionIfAbsent;
  const pushFn = deps.sendPushToUser ?? sendPushToUser;
  const effectiveDeadlineAt = deadlineAt ?? partido?.attendance_deadline_at ?? null;

  for (const participant of rows ?? []) {
    if (!shouldNotifyParticipantOnWindowClose(participant)) {
      results.skipped += 1;
      continue;
    }

    const copy = windowClosedCopyForParticipant(participant);
    const payload = buildAttendanceNotificationPayload(matchId, participant.user_id, {
      deadlineAt: effectiveDeadlineAt,
      stage: ATTENDANCE_NOTIFICATION_STAGES.WINDOW_CLOSED,
      ...copy,
    });

    try {
      const notificationResult = await createFn(supabaseAdmin, payload);
      if (notificationResult.duplicate) {
        results.duplicates += 1;
        results.skipped += 1;
        continue;
      }
      if (!notificationResult.created) {
        results.errors += 1;
        continue;
      }

      results.notified += 1;

      try {
        await pushFn(supabaseAdmin, participant.user_id, {
          title: copy.title,
          body: copy.message,
          data: {
            tipo: ATTENDANCE_NOTIFICATION_TYPE,
            partido_id: String(matchId),
            deadline_at: effectiveDeadlineAt,
            action: ATTENDANCE_NOTIFICATION_ACTION,
            source: ATTENDANCE_NOTIFICATION_SOURCE,
            reminder_stage: ATTENDANCE_NOTIFICATION_STAGES.WINDOW_CLOSED,
          },
        });
      } catch (err) {
        console.warn(
          `[Attendance Fase 3.5] window closed push error partido=${matchId} user=${participant.user_id}:`,
          err?.message ?? err,
        );
      }
    } catch (err) {
      results.errors += 1;
      console.warn(
        `[Attendance Fase 3.5] window closed notify error partido=${matchId} user=${participant.user_id}:`,
        err?.message ?? err,
      );
    }
  }

  if (results.notified > 0 || results.errors > 0) {
    console.log(
      `[Attendance Fase 3.5] window closed notifications partido=${matchId} notified=${results.notified} skipped=${results.skipped} duplicates=${results.duplicates} errors=${results.errors}`,
    );
  }

  return results;
}
