import {validateNationalLineup} from '../nationalTeamLineup.js';
const fail = (code) => { throw Object.assign(new Error(code), { code }); };
const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

/** Contexto real marcador: scoreboard -> partido torneo -> torneo/sede/equipos/alineaciones. */
export async function loadNationsMarkerMatchContext(pool, scoreboardId, options={}) {
  const lock = options.lock === true ? ' FOR UPDATE' : '';
  if (typeof scoreboardId !== 'string' || !scoreboardId.trim()) fail('SCOREBOARD_ID_REQUIRED');
  const sb = await pool.query("SELECT id, partido_torneo_id, cronometro_inicio, cronometro_pausado, cronometro_segundos, to_jsonb(sp)->>'sede_id' AS sede_id, to_jsonb(sp)->>'torneo_id' AS torneo_id FROM scoreboard_partidos sp WHERE id=$1"+lock, [scoreboardId]);
  if (!sb.rows[0]) fail('SCOREBOARD_NOT_FOUND');
  const row = sb.rows[0];
  if (row.partido_torneo_id == null) fail('MATCH_LINK_MISSING');
  const match = await pool.query('SELECT id, torneo_id, equipo_a_id, equipo_b_id FROM partidos WHERE id=$1'+lock, [row.partido_torneo_id]);
  if (!match.rows[0]) fail('MATCH_NOT_FOUND');
  const m = match.rows[0];
  const a = String(m.equipo_a_id ?? ''); const b = String(m.equipo_b_id ?? '');
  if (!a || !b || a === b) fail('MATCH_TEAMS_INVALID');
  const torneo = await pool.query('SELECT id, sede_id, modalidad_plantel, deporte FROM torneos WHERE id=$1'+lock, [m.torneo_id]);
  if (!torneo.rows[0]) fail('TOURNAMENT_NOT_FOUND');
  const sede=Number(torneo.rows[0].sede_id); if(!Number.isSafeInteger(sede)||sede<=0) fail('SEDE_INVALID');
  const sbSede=row.sede_id==null?null:Number(row.sede_id); if(sbSede!=null&&sbSede!==sede) fail('SCOREBOARD_VENUE_MISMATCH');
  const sbTorneo=row.torneo_id==null?null:Number(row.torneo_id); if(sbTorneo!=null&&sbTorneo!==Number(m.torneo_id)) fail('SCOREBOARD_TOURNAMENT_MISMATCH');
  if(String(torneo.rows[0].modalidad_plantel||'').toLowerCase()!=='selecciones'||String(torneo.rows[0].deporte||'').toLowerCase()!=='padbol') return {notNations:true,sedeId:sede,scoreboardId:String(scoreboardId)};
  const teams = await pool.query('SELECT id, torneo_id, jugadores, inscripcion_estado FROM equipos WHERE id = ANY($1::bigint[])'+lock, [[a,b]]);
  if (teams.rows.length !== 2) fail('TEAMS_MISSING');
  const lineups = await pool.query('SELECT torneo_id, partido_id, equipo_id, iniciales, suplentes, revision FROM torneo_partido_alineaciones WHERE partido_id=$1 AND equipo_id = ANY($2::bigint[])'+lock, [m.id, [a,b]]);
  if (lineups.rows.length !== 2) fail('LINEUP_MISSING');
  const byTeam = new Map();
  for (const l of lineups.rows) {
    const key = String(l.equipo_id);
    if (byTeam.has(key)) fail('LINEUP_DUPLICATE');
    if (Number(l.torneo_id) !== Number(m.torneo_id) || Number(l.partido_id) !== Number(m.id)) fail('LINEUP_SCOPE_MISMATCH');
    if (!Number.isSafeInteger(Number(l.revision)) || Number(l.revision) < 1) fail('LINEUP_REVISION_INVALID');
    byTeam.set(key, l);
  }
  const outTeams = {};
  for (const t of teams.rows) {
    const key = String(t.id);
    const lineup = byTeam.get(key); if (!lineup) fail('LINEUP_MISSING');
    if (Number(t.torneo_id) !== Number(m.torneo_id)) fail('TEAM_TOURNAMENT_MISMATCH');
    if (String(t.inscripcion_estado || '').toLowerCase() !== 'confirmado') fail('TEAM_NOT_CONFIRMED');
    const team = { id: key, jugadores: Array.isArray(t.jugadores) ? t.jugadores : [], inscripcion_estado: t.inscripcion_estado };
    const valid = validateNationalLineup({ iniciales: lineup.iniciales, suplentes: lineup.suplentes }, team, { allowGeneric: true });
    const roster = Array.isArray(team.jugadores) ? team.jugadores : [];
    const player = (id) => { const hit = roster.find(p => String(p.user_id || p.participante_id || p.id || '').toLowerCase() === String(id).toLowerCase()); if (!hit || hit.tipo_identidad === 'plaza_pendiente' || !['confirmado', 'aceptado'].includes(hit.estado || 'confirmado')) return null; const name = String(hit.nombre || '').trim(); if (!name) return null; const out = { id: String(id), name }; if (hit.dorsal != null && String(hit.dorsal).trim() !== '') out.dorsal = String(hit.dorsal).trim(); return out; };
    const named = (id) => { const p = player(id); return p && p.name ? p : null; };
    const iniciales = valid.iniciales.map(named);
    if (iniciales.length !== 2 || iniciales.some(p => !p)) fail('PLAYERS_INCOMPLETE');
    const suplentes = valid.suplentes.map(named).filter(Boolean);
    const players = [...iniciales, ...suplentes];
    if (players.length < 2 || players.length > 4 || new Set(players.map(p => p.id)).size !== players.length) fail('PLAYERS_INCOMPLETE');
    outTeams[key] = { teamId: key, lineup: { iniciales: iniciales.map(p => p.id), suplentes: suplentes.map(p => p.id), revision: Number(lineup.revision) }, players };
  }
  const keys = Object.keys(outTeams);
  if (keys.length !== 2) fail('TEAMS_INVALID');
  return {
    scoreboardId: String(row.id), partidoTorneoId: String(m.id), torneoId: String(m.torneo_id), sedeId: String(sede),
    membership: { A: a, B: b }, teams: outTeams,
    clock: { inicio: row.cronometro_inicio ?? null, pausado: row.cronometro_pausado ?? null, segundos: row.cronometro_segundos ?? null },
  };
}
