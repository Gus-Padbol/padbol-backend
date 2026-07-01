import {
  hashControlToken,
  parseControlTokenParam,
  stripSensitiveControlFields,
} from './scoreboardControlToken.js';

export const SCOREBOARD_TERMINADO_ESTADOS = new Set(['terminado', 'finalizado']);

export function isScoreboardTerminated(estado) {
  return SCOREBOARD_TERMINADO_ESTADOS.has(String(estado ?? '').toLowerCase());
}

export function assertScoreboardMutable(partido) {
  if (isScoreboardTerminated(partido?.estado)) {
    const err = new Error('El partido ya terminó');
    err.status = 400;
    throw err;
  }
}

const SCOREBOARD_TOKEN_LOOKUP_SELECT = [
  'id', 'sede_id', 'torneo_id', 'torneo_nombre', 'cancha',
  'partido_abierto_id', 'reserva_id', 'partido_torneo_id',
  'equipo_a_nombre', 'equipo_b_nombre', 'equipo_a_jugadores', 'equipo_b_jugadores',
  'jersey_a1', 'jersey_a2', 'jersey_a3', 'jersey_a4',
  'jersey_b1', 'jersey_b2', 'jersey_b3', 'jersey_b4',
  'color_a', 'color_b',
  'color_uniforme_a1', 'color_uniforme_a2', 'color_uniforme_b1', 'color_uniforme_b2',
  'estado', 'saque_actual', 'score_a', 'score_b', 'games_a', 'games_b', 'sets_a', 'sets_b',
  'historial_sets', 'es_tiebreak', 'ultimo_punto', 'historial_puntos',
  'cronometro_inicio', 'cronometro_pausado', 'cronometro_segundos',
  'control_token_hash', 'control_token_created_at', 'control_token_revoked_at',
  'synced_to_torneo_at', 'sync_torneo_status',
  'created_at', 'updated_at',
].join(', ');

/**
 * Resuelve scoreboard por token de control (hash lookup).
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {string} rawToken
 * @returns {Promise<object>}
 */
export async function resolveScoreboardByControlToken(supabaseAdmin, rawToken) {
  const token = parseControlTokenParam(rawToken);
  const tokenHash = hashControlToken(token);

  const { data, error } = await supabaseAdmin
    .from('scoreboard_partidos')
    .select(SCOREBOARD_TOKEN_LOOKUP_SELECT)
    .eq('control_token_hash', tokenHash)
    .maybeSingle();

  if (error) throw error;

  if (!data) {
    const err = new Error('Token de control inválido');
    err.status = 401;
    throw err;
  }

  if (data.control_token_revoked_at != null) {
    const err = new Error('Token de control revocado');
    err.status = 401;
    throw err;
  }

  return stripSensitiveControlFields(data);
}
