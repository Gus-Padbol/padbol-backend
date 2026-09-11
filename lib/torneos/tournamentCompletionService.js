import { buildFinalRankingForTorneo, parsePartidoResultado } from './clasificacionService.js';
import { verifyLinkedTournamentClosure } from './linkedTournamentClosure.js';
import { isTerminalScoreboardPoint, TERMINAL_POINT_SELECT } from './terminalScoreboardPoint.js';

const normalized = value => String(value ?? '').trim().toLowerCase();
const denied = reason => ({ verified: false, reason });
const isLinked = matches => matches.some(p => p.bracket_round != null || p.partido_siguiente_id != null);
const error = (code, message) => Object.assign(new Error(message), { status: 409, code });

export function getTournamentCompletionEvidence(torneo, matches, equipos) {
  if (!matches.length || equipos.length < 2) return denied('sporting_results_missing');
  const results = new Map();
  const pairIds = new Set(equipos.map(e => Number(e.id)));
  for (const match of matches) {
    const result = parsePartidoResultado(match);
    if (normalized(match.estado) !== 'finalizado' || !result || result.source_format === 'unknown'
      || ![result.sets_a, result.sets_b].every(n => Number.isInteger(n) && n >= 0)
      || !pairIds.has(Number(match.equipo_a_id)) || !pairIds.has(Number(match.equipo_b_id))
      || Number(match.equipo_a_id) === Number(match.equipo_b_id)) return denied('sporting_results_incomplete');
    const computedWinner = result.sets_a > result.sets_b ? match.equipo_a_id
      : result.sets_b > result.sets_a ? match.equipo_b_id : null;
    if (isLinked(matches) && computedWinner == null) return denied('bracket_winner_missing');
    if (match.ganador_equipo_id != null && Number(match.ganador_equipo_id) !== Number(computedWinner)) {
      return denied('winner_result_conflict');
    }
    results.set(Number(match.id), result);
  }
  if (isLinked(matches)) {
    return verifyLinkedTournamentClosure(torneo, matches, results, pairIds);
  }
  // Keep legacy/manual formats on their existing ranking engine, with real results.
  const { rankingRows } = buildFinalRankingForTorneo({ equipos, partidos: matches, tipoTorneo: torneo.tipo_torneo });
  const champion = rankingRows[0];
  if (!champion) return denied('champion_missing');
  if (['knockout', 'grupos_knockout'].includes(normalized(torneo.tipo_torneo))
    && champion.tiebreak?.detalle !== 'campeon') {
    // Do not infer a final just from the first registered team.
    const explicitFinals = matches.filter(p => p.es_final === true
      || normalized(p.fase) === 'final' || normalized(p.ronda) === 'final');
    const final = explicitFinals.length === 1 ? explicitFinals[0]
      : matches.length === 1 && equipos.length === 2 ? matches[0] : null;
    const finalResult = final && results.get(Number(final.id));
    if (!finalResult?.winner_id) return denied('legacy_final_unverified');
    return { verified: true, reason: 'legacy_final', final_partido_id: final.id, ganador_equipo_id: finalResult.winner_id };
  }
  return { verified: true, reason: 'existing_standings', ganador_equipo_id: champion.equipo_id };
}

async function rows(query) {
  const { data, error: failure } = await query;
  if (failure) throw failure;
  return data;
}

export async function loadTournamentCompletion(supabase, torneoId) {
  const torneo = await rows(supabase.from('torneos').select('id,sede_id,deporte,tipo_torneo,estado,fecha_fin,updated_at').eq('id', torneoId).maybeSingle());
  if (!torneo) throw Object.assign(new Error('Torneo no encontrado'), { status: 404 });
  const [matches, equipos] = await Promise.all([
    rows(supabase.from('partidos').select('*').eq('torneo_id', torneo.id)),
    rows(supabase.from('equipos').select('id').eq('torneo_id', torneo.id)),
  ]);
  return { torneo, matches: matches ?? [], equipos: equipos ?? [] };
}

/** Used by both manual state writers; a client cannot choose a benefit month. */
export async function prepareTournamentUpdate(supabase, torneoId, input, now = new Date()) {
  const { torneo, matches, equipos } = await loadTournamentCompletion(supabase, torneoId);
  const patch = { ...input };
  const closing = normalized(input.estado ?? torneo.estado) === 'finalizado';
  if (closing) {
    if (input.tipo_torneo != null && input.tipo_torneo !== torneo.tipo_torneo) {
      throw error('TORNEO_CLOSURE_FORMAT_CHANGE', 'Reabre el torneo antes de cambiar su formato.');
    }
    const evidence = getTournamentCompletionEvidence(torneo, matches, equipos);
    if (!evidence.verified) throw error('TORNEO_CLOSURE_UNVERIFIED', 'Completa los resultados y la definición del campeón antes de cerrar el torneo.');
    patch.estado = 'finalizado';
    patch.fecha_fin = normalized(torneo.estado) === 'finalizado' ? torneo.fecha_fin : now.toISOString().slice(0, 10);
  }
  return { patch, torneo };
}

/** Only the authenticated/token-authorized scoreboard hook invokes this writer. */
export async function completeTournamentFromFinalScoreboard(supabase, { scoreboardId, partidoId }, { now = new Date() } = {}) {
  const match = await rows(supabase.from('partidos').select('id,torneo_id').eq('id', partidoId).maybeSingle());
  if (!match) return { status: 'skipped', reason: 'match_missing' };
  const { torneo, matches, equipos } = await loadTournamentCompletion(supabase, match.torneo_id);
  if (normalized(torneo.deporte) !== 'padbol'
    || !['knockout', 'grupos_knockout'].includes(torneo.tipo_torneo) || !isLinked(matches)) {
    return { status: 'skipped', reason: 'manual_closure_format' };
  }
  if (['cancelado', 'suspendido'].includes(normalized(torneo.estado))) return { status: 'skipped', reason: 'tournament_not_active' };
  const evidence = getTournamentCompletionEvidence(torneo, matches, equipos);
  if (!evidence.verified || Number(evidence.final_partido_id) !== Number(partidoId)) {
    return { status: 'skipped', reason: evidence.verified ? 'not_final' : evidence.reason };
  }
  const scoreboard = await rows(supabase.from('scoreboard_partidos')
    .select('id,sede_id,torneo_id,partido_torneo_id,estado,sets_a,sets_b,historial_sets,sync_torneo_status,synced_to_torneo_at')
    .eq('id', scoreboardId).maybeSingle());
  const final = matches.find(p => Number(p.id) === Number(partidoId));
  const result = parsePartidoResultado(final);
  if (!scoreboard || Number(scoreboard.partido_torneo_id) !== Number(partidoId)
    || Number(scoreboard.torneo_id) !== Number(torneo.id) || Number(scoreboard.sede_id) !== Number(torneo.sede_id)
    || Number(final.ganador_equipo_id) !== Number(evidence.ganador_equipo_id)
    || scoreboard.sync_torneo_status !== 'synced' || scoreboard.sets_a !== result.sets_a || scoreboard.sets_b !== result.sets_b) {
    return { status: 'skipped', reason: 'final_scoreboard_unverified' };
  }
  const points = await rows(supabase.from('scoreboard_historial_puntos').select(TERMINAL_POINT_SELECT)
    .eq('partido_id', scoreboardId).order('timestamp', { ascending: false }).limit(1));
  if (!isTerminalScoreboardPoint(scoreboard, points?.[0])) return { status: 'skipped', reason: 'deciding_point_unverified' };
  if (normalized(torneo.estado) === 'finalizado') return { status: 'idempotent', ...evidence, torneo_id: torneo.id };
  // The sync timestamp is server-owned and preserves the event month across delayed retries.
  const finishedDate = new Date(scoreboard.synced_to_torneo_at).toISOString().slice(0, 10);
  let update = supabase.from('torneos').update({ estado: 'finalizado', fecha_fin: finishedDate, updated_at: now.toISOString() })
    .eq('id', torneo.id).eq('estado', torneo.estado);
  update = torneo.updated_at == null ? update.is('updated_at', null) : update.eq('updated_at', torneo.updated_at);
  const changed = await rows(update.select('id,estado,fecha_fin').maybeSingle());
  return changed ? { status: 'completed', ...evidence, torneo_id: torneo.id, fecha_fin: changed.fecha_fin }
    : { status: 'conflict', reason: 'tournament_changed_retry' };
}
