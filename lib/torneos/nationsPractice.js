import { createHash, randomUUID } from 'node:crypto';
import { registrarPunto, deshacerPunto, buildHistorialPuntoSnapshot, applyHistorialPuntoSnapshot } from '../../utils/scoreboardLogic.js';
import { NAPOLI_GROUPS_POLICY } from '../../src/scoreboard/napoliScoringPolicy.js';
import { assertChangeEndsWindow, substitutionWindow, substitutionSwaps } from './nationsChangeEnds.js';
import { enrichPartidoResponse } from '../../utils/scoreboardLogic.js';

const MAX_SAFE = Number.MAX_SAFE_INTEGER;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const PRACTICE_VIRTUAL_MIN = 1_000_000_000_000;
const isId = (v) => Number.isSafeInteger(Number(v)) && Number(v) >= PRACTICE_VIRTUAL_MIN && Number(v) <= MAX_SAFE;

function initialState(match) {
  const players = (team) => (Array.isArray(team?.players) ? team.players : []).slice(0, 6);
  const active = (rows) => rows.slice(0, 2).map((p) => String(p.id));
  return {
    status: 'pendiente', startedAt: null, pausedAt: null, finishedAt: null,
    active: { A: active(match.teamA.players), B: active(match.teamB.players) },
    points: { A: 0, B: 0 }, games: { A: 0, B: 0 }, sets: { A: 0, B: 0 }, history: [], historial_puntos: [], es_tiebreak: false, saque_actual: 'A', pausedMs: 0, pauseStarted: null,
    revision: 0,
  };
}

async function loadMatch(pool, match) {
  const teams = (await pool.query('SELECT id,nombre,pais,players FROM nations_practice.teams WHERE event_id=$1', [match.event_id])).rows;
  const byId = new Map(teams.map((t) => [String(t.id), t]));
  const event = (await pool.query('SELECT virtual_torneo_id FROM nations_practice.events WHERE id=$1', [match.event_id])).rows[0];
  return { ...match, event_virtual_id: event?.virtual_torneo_id ?? null, teamA: byId.get(String(match.equipo_a_id)), teamB: byId.get(String(match.equipo_b_id)) };
}

function publicTeam(team) {
  return { id: String(team.id), nombre: team.nombre, pais: team.pais || null, jugadores: (team.players || []).map((p, i) => ({ nombre: p.nombre, jersey: p.jersey ?? i + 1, numero: p.jersey ?? i + 1 })) };
}
function publicPlayers(team) {
  return (team.players || []).map((p, i) => ({ nombre: p.nombre, jersey: p.jersey ?? i + 1, numero: p.jersey ?? i + 1, pais: team.pais || null }));
}

export async function getPracticeEvent(pool, rawId) {
  if (!isId(rawId)) return null;
  const event = (await pool.query('SELECT * FROM nations_practice.events WHERE virtual_torneo_id=$1', [Number(rawId)])).rows[0];
  if (!event) return null;
  const teams = (await pool.query('SELECT * FROM nations_practice.teams WHERE event_id=$1 ORDER BY id', [event.id])).rows;
  const matches = (await pool.query('SELECT * FROM nations_practice.matches WHERE event_id=$1 ORDER BY id', [event.id])).rows;
  return { event, teams, matches };
}

export function practiceTournamentDto(event) {
  return { id: Number(event.virtual_torneo_id), nombre: event.nombre, deporte: event.deporte, estado: 'en_curso', es_practica: true, tipo_torneo: 'round_robin', formato_equipo: 'selecciones', fecha_inicio: new Date().toISOString().slice(0, 10), fecha_fin: new Date().toISOString().slice(0, 10), sede_id: null, sede_nombre: 'Canchas de práctica', plan_nations: null, modalidad_plantel: 'selecciones' };
}

export function practiceTeamsDto(teams) { return teams.map(publicTeam); }
export function practicePlayersDto(teams) { return teams.flatMap(publicPlayers); }
export function practiceMatchesDto(matches, event = null) {
  return matches.map((m) => ({ id: String(m.id), torneo_id: Number(event?.virtual_torneo_id ?? m.event_id), equipo_a_id: String(m.equipo_a_id), equipo_b_id: String(m.equipo_b_id), cancha: m.cancha, cancha_id: m.cancha_id ?? null, scoreboard_id: m.scoreboard_id, scoreboard_estado: m.estado, marcador_disponible: true, estado: m.estado, fase: m.phase, equipo_a: { id: String(m.equipo_a_id), nombre: `Equipo ${m.equipo_a_id}` }, equipo_b: { id: String(m.equipo_b_id), nombre: `Equipo ${m.equipo_b_id}` } }));
}

export function practiceBoardDto(match) {
  const state = match.state || initialState(match);
  const board = boardFromState(match, state);
  const enriched = enrichPartidoResponse(board, {}, (state.format || (match.phase === 'group' ? 'groups' : 'knockout')) === 'groups' ? NAPOLI_GROUPS_POLICY : null);
  const players = (team, side) => (team.players || []).map((p, i) => ({ nombre: p.nombre, jersey: p.jersey ?? i + 1, numero: p.jersey ?? i + 1, on_court: (state.active?.[side] || []).includes(String(p.id)) }));
  return { ...enriched, id: match.scoreboard_id, torneo_id: Number(match.event_virtual_id ?? match.event_id), torneo_nombre: 'Práctica Nations', cancha: match.cancha, estado: board.estado, display: { ...enriched.display, server_now: new Date().toISOString() }, equipo_a_nombre: match.teamA?.nombre || 'Equipo A', equipo_b_nombre: match.teamB?.nombre || 'Equipo B', equipo_a_jugadores: players(match.teamA, 'A'), equipo_b_jugadores: players(match.teamB, 'B') };
}

export async function getPracticeBoard(pool, boardId) {
  if (!UUID.test(String(boardId))) return null;
  const row = (await pool.query('SELECT * FROM nations_practice.matches WHERE scoreboard_id=$1', [boardId])).rows[0];
  if (!row) return null;
  return practiceBoardDto(await loadMatch(pool, row));
}

function tokenHash(token) { return createHash('sha256').update(String(token)).digest('hex'); }
async function authorizeControl(pool, token, matchId) {
  if (!token || String(token).length < 32) throw Object.assign(new Error('PRACTICE_CONTROL_REQUIRED'), { status: 401 });
  const row = (await pool.query(`SELECT t.*, m.id AS match_id FROM nations_practice.control_tokens t JOIN nations_practice.matches m ON m.event_id=t.event_id WHERE t.token_hash=$1 AND t.match_id=$2 AND m.id=$2 AND t.expires_at>now()`, [tokenHash(token), matchId])).rows[0];
  if (!row || String(row.match_id) !== String(matchId)) throw Object.assign(new Error('PRACTICE_CONTROL_DENIED'), { status: 403 });
  return row;
}


function boardFromState(match, state) {
  const seconds = clockSeconds(state, state.status === 'finalizado' ? Date.parse(state.finishedAt || '') : Date.now());
  return { estado: state.status === 'finalizado' ? 'terminado' : state.status === 'pendiente' ? 'pendiente' : 'en_curso', score_a: state.points.A, score_b: state.points.B, games_a: state.games.A, games_b: state.games.B, sets_a: state.sets.A, sets_b: state.sets.B, historial_sets: state.history || [], historial_puntos: state.historial_puntos || [], es_tiebreak: Boolean(state.es_tiebreak), saque_actual: state.saque_actual || 'A', cronometro_segundos: seconds, cronometro_inicio: state.startedAt, cronometro_pausado: Boolean(state.pausedAt) };
}
function stateFromBoard(match, old, board, now) {
  return { ...old, points: { A: Number(board.score_a) || 0, B: Number(board.score_b) || 0 }, games: { A: Number(board.games_a) || 0, B: Number(board.games_b) || 0 }, sets: { A: Number(board.sets_a) || 0, B: Number(board.sets_b) || 0 }, history: Array.isArray(board.historial_sets) ? board.historial_sets : [], historial_puntos: Array.isArray(board.historial_puntos) ? board.historial_puntos : [], es_tiebreak: Boolean(board.es_tiebreak), saque_actual: board.saque_actual || old.saque_actual || 'A', status: board.estado === 'terminado' ? 'finalizado' : board.estado === 'pendiente' ? 'pendiente' : 'en_curso', finishedAt: board.estado === 'terminado' ? (old.finishedAt || now) : null };
}
function clockSeconds(state, nowMs) {
  const start = Date.parse(state.startedAt || '');
  if (!Number.isFinite(start)) return 0;
  const end = state.status === 'finalizado' ? (Date.parse(state.finishedAt || '') || nowMs) : nowMs;
  const paused = state.pausedAt ? Math.max(0, nowMs - Date.parse(state.pauseStarted || state.pausedAt)) : 0;
  return Math.max(0, Math.floor((end - start - (Number(state.pausedMs)||0) - paused)/1000));
}
async function applyAction(state, match, action, body, now) {
  if (!state || typeof state !== 'object') throw Object.assign(new Error('PRACTICE_STATE_INVALID'), { status: 409 });
  if (state.status === 'finalizado' && action !== 'reset') throw Object.assign(new Error('PRACTICE_FINISHED'), { status: 409 });
  if (action === 'start') {
    if (state.status !== 'pendiente') throw Object.assign(new Error('PRACTICE_ALREADY_STARTED'), { status: 409 });
    return { ...state, status: 'en_curso', startedAt: now, pausedAt: null };
  }
  if (action === 'pause') { if (state.status !== 'en_curso' || state.pausedAt) throw Object.assign(new Error('PRACTICE_PAUSE_INVALID'), { status: 409 }); return { ...state, pausedAt: now, pauseStarted: now }; }
  if (action === 'resume') { if (state.status !== 'en_curso' || !state.pausedAt) throw Object.assign(new Error('PRACTICE_RESUME_INVALID'), { status: 409 }); const delta = Math.max(0, Date.parse(now) - Date.parse(state.pauseStarted || now)); return { ...state, pausedAt: null, pauseStarted: null, pausedMs: (Number(state.pausedMs) || 0) + delta }; }
  if (action === 'reset') { const next = initialState(match); next.format = ['groups','knockout'].includes(body.format) ? body.format : 'groups'; return next; }
  if (state.status !== 'en_curso' || state.pausedAt) throw Object.assign(new Error('PRACTICE_STATE_NOT_RUNNING'), { status: 409 });
  if (action === 'point') {
    const team = String(body.team || '').toUpperCase();
    if (!['A','B'].includes(team)) throw Object.assign(new Error('PRACTICE_TEAM_INVALID'), { status: 400 });
    const board = boardFromState(match, state);
    registrarPunto(board, team, (state.format || (match.phase === 'group' ? 'groups' : 'knockout')) === 'groups' ? NAPOLI_GROUPS_POLICY : null);
    return stateFromBoard(match, state, board, now);
  }
  if (action === 'undo') {
    const board = boardFromState(match, state);
    deshacerPunto(board);
    return stateFromBoard(match, state, board, now);
  }
  if (action === 'substitution') {
    const board = boardFromState(match, state);
    try { assertChangeEndsWindow(board); } catch { throw Object.assign(new Error('PRACTICE_SUBSTITUTION_NOT_ODD_GAME'), { status: 409 }); }
    const team = String(body.team || '').toUpperCase();
    if (!['A','B'].includes(team)) throw Object.assign(new Error('PRACTICE_TEAM_INVALID'), { status: 400 });
    const roster = match[team === 'A' ? 'teamA' : 'teamB']?.players || [];
    const view = { active: [...state.active[team]], roster: roster.map((p) => String(p.id)) };
    let swaps; try { swaps = substitutionSwaps(body, view); } catch (e) { throw Object.assign(new Error('PRACTICE_SWAP_INVALID'), { status: 409, code: 'PRACTICE_SWAP_INVALID' }); }
    const next = { ...state, active: { A: [...state.active.A], B: [...state.active.B] } };
    for (const swap of swaps) { next.active[team] = next.active[team].map((id) => id === String(swap.outId) ? String(swap.inId) : id); }
    if (next.active[team].length !== 2 || new Set(next.active[team]).size !== 2) throw Object.assign(new Error('PRACTICE_SWAP_INVALID'), { status: 409 });
    return next;
  }
  throw Object.assign(new Error('PRACTICE_ACTION_INVALID'), { status: 400 });
}


export async function getPracticeMatchByBoard(pool, boardId) {
  if (!UUID.test(String(boardId))) return null;
  const row = (await pool.query('SELECT * FROM nations_practice.matches WHERE scoreboard_id=$1', [boardId])).rows[0];
  return row ? loadMatch(pool, row) : null;
}

export async function practiceControlContext({ pool, boardId, token } = {}) {
  if (!pool || !UUID.test(String(boardId || '')) || !token) return null;
  const row = (await pool.query(`SELECT m.* FROM nations_practice.matches m JOIN nations_practice.control_tokens t ON t.event_id=m.event_id WHERE m.scoreboard_id=$1 AND t.token_hash=$2 AND t.match_id=m.id AND t.expires_at>now()`, [boardId, tokenHash(token)])).rows[0];
  if (!row) throw Object.assign(new Error('PRACTICE_CONTROL_DENIED'), { status: 403 });
  const match = await loadMatch(pool, row);
  const state = row.state || initialState(match);
  const window = substitutionWindow(boardFromState(match, state));
  const lineups = {};
  for (const side of ['A','B']) {
    const team = match[side === 'A' ? 'teamA' : 'teamB'];
    lineups[side] = (team?.players || []).map((p, i) => ({ id: String(p.id), name: p.nombre, jersey: p.jersey ?? i + 1, on_court: (state.active?.[side] || []).includes(String(p.id)) }));
  }
  return { board: practiceBoardDto(match), revision: Number(row.revision), lineups, substitution_window: window };
}

function canonicalBody(body) { const keys = ['team','swaps','format','outId','inId']; return JSON.stringify(Object.fromEntries(keys.filter((k) => body && Object.hasOwn(body, k)).map((k) => [k, body[k]]))); }

export async function executePracticeAction({ pool, matchId, action, requestId, expectedRevision, body = {}, token } = {}) {
  if (!pool) throw Object.assign(new Error('PRACTICE_UNAVAILABLE'), { status: 503 });
  if (!UUID.test(String(requestId || ''))) throw Object.assign(new Error('PRACTICE_REQUEST_ID_INVALID'), { status: 400 });
  if (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) throw Object.assign(new Error('PRACTICE_REVISION_INVALID'), { status: 400 });
  await authorizeControl(pool, token, matchId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const row = (await client.query('SELECT * FROM nations_practice.matches WHERE id=$1 FOR UPDATE', [matchId])).rows[0];
    if (!row) throw Object.assign(new Error('PRACTICE_MATCH_NOT_FOUND'), { status: 404 });
    const afterLock = (await client.query('SELECT action,expected_revision,payload,result FROM nations_practice.commands WHERE match_id=$1 AND request_id=$2', [matchId, requestId])).rows[0];
    if (afterLock) {
      if (afterLock.action !== action || Number(afterLock.expected_revision) !== Number(expectedRevision) || JSON.stringify(afterLock.payload) !== canonicalBody(body)) throw Object.assign(new Error('PRACTICE_IDEMPOTENCY_CONFLICT'), { status: 409, code: 'PRACTICE_IDEMPOTENCY_CONFLICT' });
      await client.query('COMMIT'); return { deduplicated: true, ...afterLock.result };
    }
    if (Number(row.revision) !== Number(expectedRevision)) throw Object.assign(new Error('PRACTICE_REVISION_CONFLICT'), { status: 409, code: 'PRACTICE_REVISION_CONFLICT', revision: Number(row.revision) });
    const match = await loadMatch(client, row);
    const now = new Date().toISOString();
    const nextState = await applyAction(row.state && Object.keys(row.state).length ? row.state : initialState(match), match, action, body, now);
    nextState.revision = Number(row.revision) + 1;
    const estado = nextState.status === 'finalizado' ? 'finalizado' : nextState.status === 'en_curso' ? 'en_curso' : 'pendiente';
    await client.query('UPDATE nations_practice.matches SET state=$2::jsonb, estado=$3, revision=$4, updated_at=now() WHERE id=$1', [matchId, JSON.stringify(nextState), estado, nextState.revision]);
    const result = { revision: nextState.revision, status: nextState.status, state: nextState };
    await client.query('INSERT INTO nations_practice.commands(match_id,request_id,expected_revision,action,payload,result) VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)', [matchId, requestId, Number(expectedRevision), action, canonicalBody(body), JSON.stringify(result)]);
    await client.query('COMMIT');
    return { deduplicated: false, ...result };
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
}

export async function issuePracticeControlToken({ pool, eventId, matchId, expiresAt, token = randomUUID() }) {
  if (!pool || !eventId || !matchId || !expiresAt) throw new Error('PRACTICE_TOKEN_INPUT');
  const hash = tokenHash(token);
  await pool.query('INSERT INTO nations_practice.control_tokens(id,event_id,match_id,token_hash,expires_at) VALUES($1,$2,$3,$4,$5)', [randomUUID(), eventId, matchId, hash, expiresAt]);
  return { token, expiresAt };
}
