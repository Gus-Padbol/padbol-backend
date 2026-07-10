/**
 * Configuración por sede — confirmación de asistencia Fase 3.6.
 * Lee padbol_match_setup_status.attendance_confirmation_enabled (default false).
 */

import { isAttendanceConfirmationEnabledForMatch } from './matchAttendanceConfig.js';

export const SEDE_ATTENDANCE_CONFIG_KEY = 'attendance_confirmation_enabled';

const SETUP_STATUS_ATTENDANCE_SELECT = 'sede_id, attendance_confirmation_enabled';

function parseSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function isMissingTableOrColumn(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || error?.code === '42703'
    || message.includes('padbol_match_setup_status')
    || message.includes('attendance_confirmation_enabled')
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

/**
 * Resuelve si la sede tiene confirmación de asistencia habilitada.
 * Sin fila, tabla o columna → false (default seguro).
 */
export async function getSedeAttendanceConfirmationEnabled(supabaseAdmin, sedeId) {
  const sid = parseSedeId(sedeId);
  if (!sid || !supabaseAdmin) {
    return false;
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('padbol_match_setup_status')
      .select(SETUP_STATUS_ATTENDANCE_SELECT)
      .eq('sede_id', sid)
      .maybeSingle();

    if (error) {
      if (isMissingTableOrColumn(error)) return false;
      throw error;
    }

    return data?.attendance_confirmation_enabled === true;
  } catch (err) {
    if (isMissingTableOrColumn(err)) return false;
    throw err;
  }
}

export async function resolveAttendanceFeatureForPartido(supabaseAdmin, partido = {}) {
  const sedeEnabled = await getSedeAttendanceConfirmationEnabled(supabaseAdmin, partido?.sede_id);
  const featureEnabled = isAttendanceConfirmationEnabledForMatch(partido, { sedeEnabled });
  return { sedeEnabled, featureEnabled };
}
