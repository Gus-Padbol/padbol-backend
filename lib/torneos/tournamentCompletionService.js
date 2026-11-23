import { resolvePersistedScoringPolicy } from '../../src/scoreboard/napoliScoringPolicy.js';
import { validateTournamentDates, tournamentClosureDate, tournamentLocalDate } from './tournamentDates.js';
import { buildNationsPlacements } from './nationsCupService.js';
import { isNationalRoster } from '../nationalTeamLineup.js';
import { buildFinalRankingForTorneo, parsePartidoResultado } from './clasificacionService.js';
import { verifyLinkedTournamentClosure } from './linkedTournamentClosure.js';
import { isTerminalScoreboardPoint, TERMINAL_POINT_SELECT } from './terminalScoreboardPoint.js';

const normalized = value => String(value ?? '').trim().toLowerCase();
const denied = reason => ({ verified: false, reason });
const isLinked = matches => matches.some(p => p.bracket_round != null || p.partido_siguiente_id != null);
const error = (code, message) => Object.assign(new Error(message), { status: 409, code });

export function getTournamentCompletionEvidence(torneo, matches, equipos) {
  if (torneo.plan_nations) {
    try { const places=buildNationsPlacements(torneo.plan_nations,matches); return {verified:true,reason:'nations_approved_placements',ganador_equipo_id:places[0].equipo_id}; }
    catch (e) { return denied(e.code ?? 'nations_closure_unverified'); }
  }
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
  let torneo = await rows(supabase.from('torneos').select('id,sede_id,deporte,tipo_torneo,cupos_maximos,estado,fecha_inicio,fecha_fin,es_prueba,updated_at,modalidad_plantel,plan_nations').eq('id', torneoId).maybeSingle());
  if (!torneo) throw Object.assign(new Error('Torneo no encontrado'), { status: 404 });
  if(torneo.plan_nations){const {data,error:failure}=await supabase.rpc('leer_estado_nations',{p_torneo_id:Number(torneo.id)});if(failure)throw failure;if(!data?.torneo||!Array.isArray(data.matches)||!Array.isArray(data.teams))throw error('NATIONS_STATE_UNCONFIRMED','No se pudo verificar el estado privado del evento.');return {torneo:data.torneo,matches:data.matches,equipos:data.teams};}
  const [matches, equipos] = await Promise.all([
    rows(supabase.from('partidos').select('*').eq('torneo_id', torneo.id)),
    rows(supabase.from('equipos').select('id').eq('torneo_id', torneo.id)),
  ]);
  return { torneo, matches: matches ?? [], equipos: equipos ?? [] };
}

async function withTournamentTimezone(supabase, torneo) {
  if (torneo.plan_nations || torneo.sede_id == null) return torneo;
  const venue = await supabase.from('sedes').select('timezone').eq('id',torneo.sede_id).maybeSingle();
  if (venue.error) throw venue.error;
  return {...torneo, timezone: venue.data?.timezone || 'America/Argentina/Buenos_Aires'};
}

/** Server-owned generic closure date, aligned with the persisted venue calendar guard. */
export async function resolveGenericTournamentClosureDate(supabase, torneo, now = new Date()) {
  const event = await withTournamentTimezone(supabase, torneo);
  return tournamentClosureDate(event, tournamentLocalDate(event, now));
}

/** Used by both manual state writers; a client cannot choose a benefit month. */
export async function prepareTournamentUpdate(supabase, torneoId, input, now = new Date()) {
  const { torneo, matches, equipos } = await loadTournamentCompletion(supabase, torneoId);
  const patch = { ...input };
  const changesCompetitionStructure = (input.tipo_torneo != null && input.tipo_torneo !== torneo.tipo_torneo)
    || (input.cupos_maximos !== undefined && (input.cupos_maximos == null ? null : Number(input.cupos_maximos)) !== (torneo.cupos_maximos == null ? null : Number(torneo.cupos_maximos)));
  if (changesCompetitionStructure && matches.length > 0) {
    throw error('TORNEO_STRUCTURE_FROZEN', 'El formato y la capacidad solo se pueden editar antes de generar el fixture.');
  }
  validateTournamentDates({ ...torneo, ...Object.fromEntries(Object.entries(input).filter(([,v])=>v !== undefined)) });
  const closing = normalized(input.estado ?? torneo.estado) === 'finalizado';
  if (closing) {
    if (isNationalRoster(torneo)) throw error('NATIONAL_ATOMIC_CLOSURE_REQUIRED','Cierra la selección con Finalizar torneo para conservar sus convocados y puntos.');
    if (input.tipo_torneo != null && input.tipo_torneo !== torneo.tipo_torneo) {
      throw error('TORNEO_CLOSURE_FORMAT_CHANGE', 'Reabre el torneo antes de cambiar su formato.');
    }
    const evidence = getTournamentCompletionEvidence(torneo, matches, equipos);
    if (!evidence.verified) throw error('TORNEO_CLOSURE_UNVERIFIED', 'Completa los resultados y la definición del campeón antes de cerrar el torneo.');
    patch.estado = 'finalizado';
    patch.fecha_fin = normalized(torneo.estado) === 'finalizado' ? torneo.fecha_fin : tournamentClosureDate(torneo, tournamentLocalDate(await withTournamentTimezone(supabase, torneo), now));
  }
  return { patch, torneo };
}

/** Only the authenticated/token-authorized scoreboard hook invokes this writer. */
export async function completeTournamentFromFinalScoreboard(supabase, { scoreboardId, partidoId }, { now = new Date() } = {}) {
  const match = await rows(supabase.from('partidos').select('id,torneo_id').eq('id', partidoId).maybeSingle());
  if (!match) return { status: 'skipped', reason: 'match_missing' };
  const { torneo, matches, equipos } = await loadTournamentCompletion(supabase, match.torneo_id);
  if (isNationalRoster(torneo)) return {status:'skipped',reason:'national_explicit_atomic_closure_required'};
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
  if (!isTerminalScoreboardPoint(scoreboard, points?.[0], resolvePersistedScoringPolicy(torneo, final))) return { status: 'skipped', reason: 'deciding_point_unverified' };
  if (normalized(torneo.estado) === 'finalizado') return { status: 'idempotent', ...evidence, torneo_id: torneo.id };
  // The sync timestamp is server-owned and preserves the event month across delayed retries.
  const finishedDate = tournamentClosureDate(torneo, tournamentLocalDate(await withTournamentTimezone(supabase, torneo), scoreboard.synced_to_torneo_at));
  let update = supabase.from('torneos').update({ estado: 'finalizado', fecha_fin: finishedDate, updated_at: now.toISOString() })
    .eq('id', torneo.id).eq('estado', torneo.estado);
  update = torneo.updated_at == null ? update.is('updated_at', null) : update.eq('updated_at', torneo.updated_at);
  const changed = await rows(update.select('id,estado,fecha_fin').maybeSingle());
  return changed ? { status: 'completed', ...evidence, torneo_id: torneo.id, fecha_fin: changed.fecha_fin }
    : { status: 'conflict', reason: 'tournament_changed_retry' };
}

const genericClosureFailure = (status = 503) => Object.assign(
  new Error('No se pudo confirmar el cierre atómico del torneo. Reintenta.'),
  { status, code: 'TORNEO_CLOSURE_ATOMIC_UNCONFIRMED' },
);

/**
 * Persists the complete generic closure in one database transaction:
 * tabla_puntos + equipos.puntos_ranking + torneos.estado/fecha_fin.
 * The route keeps the authorization check and the ranking/evidence validation;
 * this writer only accepts a complete snapshot and confirms what PostgreSQL committed.
 */
export async function persistGenericTournamentClosure(db, { torneo, equipos, puntosData, fechaFin }) {
  const teamIds = new Set((equipos ?? []).map(equipo => Number(equipo.id)));
  const rows = (puntosData ?? []).map(({ equipo_id, posicion, puntos }) => ({
    torneo_id: Number(torneo.id), equipo_id: Number(equipo_id), posicion: Number(posicion), puntos: Number(puntos),
  }));
  const { data, error } = await db.rpc('finalizar_torneo_generico', {
    p_torneo_id: Number(torneo.id),
    p_expected_estado: torneo.estado ?? null,
    p_expected_updated_at: torneo.updated_at ?? null,
    p_fecha_fin: fechaFin ?? null,
    p_puntos: rows,
  });
  if (error) throw genericClosureFailure(['22023', '22P02', '40001', 'P0002'].includes(error.code) ? 409 : 503);
  if (!data || !['completed', 'idempotent', 'conflict', 'not_found'].includes(data.status)) {
    throw genericClosureFailure();
  }
  if (data.status === 'conflict' || data.status === 'not_found') return { status: data.status };
  if (data.ok !== true) throw genericClosureFailure();
  if (Number(data.torneo?.id) !== Number(torneo.id) || !Array.isArray(data.tabla)) throw genericClosureFailure();
  const savedIds = new Set(data.tabla.map(row => Number(row.equipo_id)));
  const complete = data.tabla.length === teamIds.size && savedIds.size === teamIds.size
    && [...savedIds].every(id => teamIds.has(id));
  if (!complete) {
    if (data.status === 'idempotent') return { status: 'historical_ledger_incomplete', torneo: data.torneo };
    throw genericClosureFailure();
  }
  if (data.status === 'completed') {
    const expected = new Map(rows.map(row => [row.equipo_id, row]));
    const matches = data.tabla.length === rows.length && data.tabla.every(row => {
      const want = expected.get(Number(row.equipo_id));
      return want && Number(row.posicion) === want.posicion && Number(row.puntos) === want.puntos;
    });
    if (!matches) throw genericClosureFailure();
  }
  return { status: data.status, torneo: data.torneo, tabla: data.tabla };
}
