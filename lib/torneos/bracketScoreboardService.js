import { persistControlTokenForScoreboard } from '../../src/scoreboard/scoreboardControlTokenService.js';
import {
  buildScoreboardInsertRow,
  SCOREBOARD_INSERT_SELECT,
} from '../../src/scoreboard/scoreboardTorneoService.js';

const PARTIDO_SELECT = [
  'id',
  'torneo_id',
  'sede_id',
  'cancha',
  'estado',
  'equipo_a_id',
  'equipo_b_id',
].join(', ');

const ESTADOS_NO_APTOS = new Set(['finalizado', 'en_curso']);
const ESTADOS_SCOREBOARD_TERMINADO = new Set(['terminado', 'finalizado']);

function normalizeEstado(estado) {
  return String(estado ?? '').trim().toLowerCase();
}

function buildResult({ status, reason, partidoId, scoreboardId, controlToken }) {
  const result = {
    status,
    reason,
    partido_id: Number(partidoId),
  };
  if (scoreboardId != null) result.scoreboard_id = scoreboardId;
  if (controlToken != null) result.control_token = controlToken;
  return result;
}

/**
 * Crea el scoreboard de un partido de llave que quedó con ambos equipos definidos.
 * Idempotente: no duplica si ya hay un scoreboard activo para el partido.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {{ partidoId: number | string }} params
 * @param {{
 *   buildScoreboardInsertRow?: Function,
 *   persistControlTokenForScoreboard?: Function,
 * }} [deps]
 */
export async function ensureScoreboardForCompletedBracketPartido(
  supabaseAdmin,
  { partidoId },
  deps = {},
) {
  const id = Number(partidoId);
  if (!Number.isFinite(id) || id <= 0) {
    return buildResult({ status: 'failed', reason: 'partido_not_found', partidoId: partidoId ?? 0 });
  }

  const buildRow = deps.buildScoreboardInsertRow ?? buildScoreboardInsertRow;
  const persistToken = deps.persistControlTokenForScoreboard ?? persistControlTokenForScoreboard;

  const { data: partido, error: errPartido } = await supabaseAdmin
    .from('partidos')
    .select(PARTIDO_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (errPartido || !partido) {
    return buildResult({ status: 'failed', reason: 'partido_not_found', partidoId: id });
  }

  if (partido.equipo_a_id == null || partido.equipo_b_id == null) {
    return buildResult({ status: 'skipped', reason: 'partido_incompleto', partidoId: id });
  }

  if (ESTADOS_NO_APTOS.has(normalizeEstado(partido.estado))) {
    return buildResult({ status: 'skipped', reason: 'estado_no_apto', partidoId: id });
  }

  const { data: existentes, error: errExistentes } = await supabaseAdmin
    .from('scoreboard_partidos')
    .select('id, estado')
    .eq('partido_torneo_id', id);

  if (errExistentes) {
    return buildResult({ status: 'failed', reason: 'scoreboard_lookup_failed', partidoId: id });
  }

  const activo = (existentes ?? []).find(
    (sb) => !ESTADOS_SCOREBOARD_TERMINADO.has(normalizeEstado(sb.estado)),
  );
  if (activo) {
    return buildResult({
      status: 'skipped',
      reason: 'scoreboard_existente',
      partidoId: id,
      scoreboardId: activo.id,
    });
  }

  const { data: torneo } = await supabaseAdmin
    .from('torneos')
    .select('id, nombre, sede_id')
    .eq('id', partido.torneo_id)
    .maybeSingle();

  const { data: equipos } = await supabaseAdmin
    .from('equipos')
    .select('id, nombre, jugadores')
    .in('id', [partido.equipo_a_id, partido.equipo_b_id]);

  const equiposMap = new Map((equipos ?? []).map((eq) => [Number(eq.id), eq]));
  const equipoA = equiposMap.get(Number(partido.equipo_a_id));
  const equipoB = equiposMap.get(Number(partido.equipo_b_id));

  const insertRow = buildRow({
    partido,
    torneo: torneo ?? { id: partido.torneo_id, nombre: null, sede_id: partido.sede_id },
    equipoA,
    equipoB,
    cancha: partido.cancha ?? null,
  });

  const { data: inserted, error: errInsert } = await supabaseAdmin
    .from('scoreboard_partidos')
    .insert(insertRow)
    .select(SCOREBOARD_INSERT_SELECT)
    .limit(1);

  if (errInsert) {
    return buildResult({ status: 'failed', reason: 'scoreboard_insert_failed', partidoId: id });
  }

  const scoreboard = Array.isArray(inserted) ? inserted[0] : inserted;
  if (!scoreboard?.id) {
    return buildResult({ status: 'failed', reason: 'scoreboard_insert_failed', partidoId: id });
  }

  let controlToken = null;
  try {
    const tokenResult = await persistToken(supabaseAdmin, scoreboard.id);
    controlToken = tokenResult?.controlToken ?? null;
  } catch {
    // La emisión del token no debe invalidar el scoreboard ya creado.
    controlToken = null;
  }

  return buildResult({
    status: 'created',
    reason: 'scoreboard_creado',
    partidoId: id,
    scoreboardId: scoreboard.id,
    controlToken,
  });
}
