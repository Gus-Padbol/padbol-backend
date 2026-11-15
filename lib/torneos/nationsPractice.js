import { createHash, randomUUID } from 'node:crypto';

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
    points: { A: 0, B: 0 }, games: { A: 0, B: 0 }, sets: { A: 0, B: 0 }, history: [],
    revision: 0,
  };
}

async function loadMatch(pool, match) {
  const teams = (await pool.query('SELECT id,nombre,pais,players FROM nations_practice.teams WHERE event_id=$1', [match.event_id])).rows;
  const byId = new Map(teams.map((t) => [String(t.id), t]));
  return { ...match, teamA: byId.get(String(match.equipo_a_id)), teamB: byId.get(String(match.equipo_b_id)) };
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
  const players = (team) => (team.players || []).map((p, i) => ({ nombre: p.nombre, jersey: p.jersey ?? i + 1, numero: p.jersey ?? i + 1, on_court: state.active?.[team === match.teamA ? 'A' : 'B']?.includes(String(p.id)) ?? false }));
  return {
    id: match.scoreboard_id, torneo_id: Number(match.event_id), torneo_nombre: 'Práctica Nations', cancha: match.cancha, estado: match.estado,
    score_a: state.points.A, score_b: state.points.B, games_a: state.games.A, games_b: state.games.B, sets_a: state.sets.A, sets_b: state.sets.B,
    historial_sets: Array.isArray(state.history) ? state.history : [], es_tiebreak: false,
    display: { displayA: String(state.points.A), displayB: String(state.points.B), mode: 'normal', cronometro: '00:00:00', cronometroSegundos: 0 },
    equipo_a_nombre: match.teamA?.nombre || 'Equipo A', equipo_b_nombre: match.teamB?.nombre || 'Equipo B',
    equipo_a_jugadores: players(match.teamA), equipo_b_jugadores: players(match.teamB),
  };
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
  const row = (await pool.query(`SELECT t.*, m.id AS match_id FROM nations_practice.control_tokens t JOIN nations_practice.matches m ON m.event_id=t.event_id WHERE t.token_hash=$1 AND m.id=$2 AND t.expires_at>now()`, [tokenHash(token), matchId])).rows[0];
  if (!row || String(row.match_id) !== String(matchId)) throw Object.assign(new Error('PRACTICE_CONTROL_DENIED'), { status: 403 });
  return row;
}

async function applyAction(state, match, action, body, now) {
  if (!state || typeof state !== 'object') throw Object.assign(new Error('PRACTICE_STATE_INVALID'), { status: 409 });
  if (state.status === 'finalizado' && action !== 'reset') throw Object.assign(new Error('PRACTICE_FINISHED'), { status: 409 });
  if (action === 'start') {
    if (state.status !== 'pendiente') throw Object.assign(new Error('PRACTICE_ALREADY_STARTED'), { status: 409 });
    return { ...state, status: 'en_curso', startedAt: now, pausedAt: null };
  }
  if (action === 'pause') { if (state.status !== 'en_curso' || state.pausedAt) throw Object.assign(new Error('PRACTICE_PAUSE_INVALID'), { status: 409 }); return { ...state, pausedAt: now }; }
  if (action === 'resume') { if (state.status !== 'en_curso' || !state.pausedAt) throw Object.assign(new Error('PRACTICE_RESUME_INVALID'), { status: 409 }); return { ...state, pausedAt: null }; }
  if (action === 'reset') { const next = initialState(match); next.format = ['groups','knockout'].includes(body.format) ? body.format : 'groups'; return next; }
  if (state.status !== 'en_curso' || state.pausedAt) throw Object.assign(new Error('PRACTICE_STATE_NOT_RUNNING'), { status: 409 });
  if (action === 'point') {
    const team = String(body.team || '').toUpperCase();
    if (!['A','B'].includes(team)) throw Object.assign(new Error('PRACTICE_TEAM_INVALID'), { status: 400 });
    const next = { ...state, points: { ...state.points } };
    next.points[team] += 1;
    const target = (state.format || (match.phase === 'group' ? 'groups' : 'knockout')) === 'groups' ? 10 : 6;
    if (next.points[team] >= target) {
      next.games = { ...next.games, [team]: next.games[team] + 1 };
      next.points = { A: 0, B: 0 };
      next.history = [...(state.history || []), { a: state.points.A, b: state.points.B, type: (state.format || (match.phase === 'group' ? 'groups' : 'knockout')) === 'groups' ? 'super_tiebreak' : 'normal', target, win_by: 1 }];
      next.sets = { ...next.sets, [team]: next.sets[team] + 1 };
      if ((state.format || (match.phase === 'group' ? 'groups' : 'knockout')) === 'groups' || next.sets[team] >= 2) { next.status = 'finalizado'; next.finishedAt = now; }
    }
    return next;
  }
  if (action === 'undo') {
    if (state.points.A > 0) return { ...state, points: { ...state.points, A: state.points.A - 1 } };
    if (state.points.B > 0) return { ...state, points: { ...state.points, B: state.points.B - 1 } };
    throw Object.assign(new Error('PRACTICE_UNDO_EMPTY'), { status: 409 });
  }
  if (action === 'substitution') {
    if (((Number(state.games.A) || 0) + (Number(state.games.B) || 0)) % 2 !== 1) throw Object.assign(new Error('PRACTICE_SUBSTITUTION_NOT_ODD_GAME'), { status: 409 });
    const swaps = Array.isArray(body.swaps) && body.swaps.length ? body.swaps : [{ outId: body.outId, inId: body.inId }];
    if (![1,2].includes(swaps.length)) throw Object.assign(new Error('PRACTICE_SWAP_INVALID'), { status: 400 });
    const next = { ...state, active: { A: [...state.active.A], B: [...state.active.B] } };
    const team = String(body.team || '').toUpperCase();
    if (!['A','B'].includes(team)) throw Object.assign(new Error('PRACTICE_TEAM_INVALID'), { status: 400 });
    const roster = match[team === 'A' ? 'teamA' : 'teamB']?.players || [];
    const rosterIds = new Set(roster.map((p) => String(p.id)));
    for (const swap of swaps) {
      const out = String(swap.outId), incoming = String(swap.inId);
      if (!next.active[team].includes(out) || next.active[team].includes(incoming) || !rosterIds.has(incoming)) throw Object.assign(new Error('PRACTICE_SWAP_INVALID'), { status: 409 });
      next.active[team] = next.active[team].map((id) => id === out ? incoming : id);
    }
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
  const row = (await pool.query(`SELECT m.* FROM nations_practice.matches m JOIN nations_practice.control_tokens t ON t.event_id=m.event_id WHERE m.scoreboard_id=$1 AND t.token_hash=$2 AND t.expires_at>now()`, [boardId, tokenHash(token)])).rows[0];
  if (!row) throw Object.assign(new Error('PRACTICE_CONTROL_DENIED'), { status: 403 });
  const match = await loadMatch(pool, row);
  const state = row.state || initialState(match);
  const games = (Number(state.games?.A) || 0) + (Number(state.games?.B) || 0);
  const lineups = {};
  for (const side of ['A','B']) {
    const team = match[side === 'A' ? 'teamA' : 'teamB'];
    lineups[side] = (team?.players || []).map((p, i) => ({ id: String(p.id), name: p.nombre, jersey: p.jersey ?? i + 1, on_court: (state.active?.[side] || []).includes(String(p.id)) }));
  }
  return { board: practiceBoardDto(match), revision: Number(row.revision), lineups, substitution_window: { allowed: state.status === 'en_curso' && !state.pausedAt && games > 0 && games % 2 === 1, reason: state.status !== 'en_curso' ? 'MATCH_NOT_RUNNING' : state.pausedAt ? 'MATCH_PAUSED' : games === 0 ? 'NO_GAMES' : games % 2 === 0 ? 'NOT_ODD_GAME' : 'ALLOWED', completed_games: games, set_number: (state.sets?.A || 0) + (state.sets?.B || 0) + 1 } };
}

export async function executePracticeAction({ pool, matchId, action, requestId, expectedRevision, body = {}, token } = {}) {
  if (!pool) throw Object.assign(new Error('PRACTICE_UNAVAILABLE'), { status: 503 });
  if (!UUID.test(String(requestId || ''))) throw Object.assign(new Error('PRACTICE_REQUEST_ID_INVALID'), { status: 400 });
  if (!Number.isSafeInteger(Number(expectedRevision)) || Number(expectedRevision) < 0) throw Object.assign(new Error('PRACTICE_REVISION_INVALID'), { status: 400 });
  await authorizeControl(pool, token, matchId);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const existing = (await client.query('SELECT result FROM nations_practice.commands WHERE match_id=$1 AND request_id=$2', [matchId, requestId])).rows[0];
    if (existing) { await client.query('COMMIT'); return { deduplicated: true, ...existing.result }; }
    const row = (await client.query('SELECT * FROM nations_practice.matches WHERE id=$1 FOR UPDATE', [matchId])).rows[0];
    if (!row) throw Object.assign(new Error('PRACTICE_MATCH_NOT_FOUND'), { status: 404 });
    if (Number(row.revision) !== Number(expectedRevision)) throw Object.assign(new Error('PRACTICE_REVISION_CONFLICT'), { status: 409, code: 'PRACTICE_REVISION_CONFLICT', revision: Number(row.revision) });
    const match = await loadMatch(client, row);
    const now = new Date().toISOString();
    const nextState = await applyAction(row.state && Object.keys(row.state).length ? row.state : initialState(match), match, action, body, now);
    nextState.revision = Number(row.revision) + 1;
    const estado = nextState.status === 'finalizado' ? 'finalizado' : nextState.status === 'en_curso' ? 'en_curso' : 'pendiente';
    await client.query('UPDATE nations_practice.matches SET state=$2::jsonb, estado=$3, revision=$4, updated_at=now() WHERE id=$1', [matchId, JSON.stringify(nextState), estado, nextState.revision]);
    const result = { revision: nextState.revision, status: nextState.status, state: nextState };
    await client.query('INSERT INTO nations_practice.commands(match_id,request_id,expected_revision,action,result) VALUES($1,$2,$3,$4,$5::jsonb)', [matchId, requestId, Number(expectedRevision), action, JSON.stringify(result)]);
    await client.query('COMMIT');
    return { deduplicated: false, ...result };
  } catch (error) { try { await client.query('ROLLBACK'); } catch {} throw error; } finally { client.release(); }
}

export async function issuePracticeControlToken({ pool, eventId, expiresAt, token = randomUUID() }) {
  if (!pool || !eventId || !expiresAt) throw new Error('PRACTICE_TOKEN_INPUT');
  const hash = tokenHash(token);
  await pool.query('INSERT INTO nations_practice.control_tokens(id,event_id,token_hash,expires_at) VALUES($1,$2,$3,$4)', [randomUUID(), eventId, hash, expiresAt]);
  return { token, expiresAt };
}
