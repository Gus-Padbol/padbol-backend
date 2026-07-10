/**
 * Auditoría append-only — confirmación de asistencia Fase 3.6.
 * Fallback silencioso si match_attendance_audit_log no existe aún.
 */

export const MATCH_ATTENDANCE_AUDIT_ACTIONS = Object.freeze({
  PARTICIPANT_OVERRIDE: 'participant_override',
  FORCE_CLOSE_READY: 'force_close_ready',
  FORCE_CLOSE_BLOCKED: 'force_close_blocked',
  REPROCESS_REWARDS: 'reprocess_rewards',
});

function isMissingAuditTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('match_attendance_audit_log')
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function normalizeMetadata(value) {
  if (value == null) return {};
  if (typeof value === 'object' && !Array.isArray(value)) {
    return value;
  }
  return { value };
}

export async function appendMatchAttendanceAuditLog(supabaseAdmin, {
  match_id,
  actor_user_id = null,
  actor_role = null,
  action,
  target_user_id = null,
  previous_status = null,
  new_status = null,
  reason = null,
  metadata = {},
} = {}) {
  if (!supabaseAdmin || !action) {
    return { ok: false, skipped: true, reason: 'invalid_payload' };
  }

  const payload = {
    match_id: Number(match_id),
    actor_user_id: actor_user_id ?? null,
    actor_role: actor_role ?? null,
    action: String(action).trim(),
    target_user_id: target_user_id ?? null,
    previous_status: previous_status ?? null,
    new_status: new_status ?? null,
    reason: reason != null ? String(reason).trim() || null : null,
    metadata: normalizeMetadata(metadata),
  };

  if (!Number.isFinite(payload.match_id) || payload.match_id <= 0) {
    return { ok: false, skipped: true, reason: 'invalid_match_id' };
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('match_attendance_audit_log')
      .insert(payload)
      .select('id, action, created_at')
      .single();

    if (error) {
      if (isMissingAuditTable(error)) {
        return { ok: true, skipped: true, reason: 'audit_table_missing' };
      }
      throw error;
    }

    return { ok: true, skipped: false, audit: data };
  } catch (err) {
    if (isMissingAuditTable(err)) {
      return { ok: true, skipped: true, reason: 'audit_table_missing' };
    }
    throw err;
  }
}
