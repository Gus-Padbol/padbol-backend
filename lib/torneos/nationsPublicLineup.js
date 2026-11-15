import { loadNationsMarkerMatchContext } from './nationsMarkerMatchContext.js';
const canon = (v) => Array.isArray(v) ? [...v].map(String).sort() : v;
const same = (a, b) => JSON.stringify(canon(a)) === JSON.stringify(canon(b));
const object = (v) => v && typeof v === 'object' && !Array.isArray(v);
const key = (p) => String(p?.user_id || p?.participante_id || p?.id || '').toLowerCase();

/** Only public scoreboard media from this project. Never profile avatars or signed URLs. */
export function trustedScoreboardPhoto(value, supabaseUrl) {
  if (typeof value !== 'string' || !supabaseUrl) return null;
  try {
    const u = new URL(value), base = new URL(supabaseUrl);
    if (u.protocol !== 'https:' || u.origin !== base.origin || u.username || u.password || u.search || u.hash) return null;
    const path = decodeURIComponent(u.pathname);
    if (!path.startsWith('/storage/v1/object/public/scoreboard-fotos/')) return null;
    if (path.split('/').some((part) => part === '..' || part === '.') || path.endsWith('/')) return null;
    return u.href;
  } catch { return null; }
}

function presentPlayer(player, active, raw, supabaseUrl) {
  const matches = raw.filter((entry) => key(entry) === String(player.id).toLowerCase());
  const original = matches.length === 1 ? matches[0] : null;
  const onCourt = active.includes(player.id);
  const out = { nombre: player.name, role: onCourt ? 'on_court' : 'bench', on_court: onCourt };
  const dorsal = player.dorsal ?? original?.jersey ?? original?.numero;
  if ((typeof dorsal === 'string' || typeof dorsal === 'number') && String(dorsal).trim()) out.jersey = String(dorsal).trim();
  const foto = trustedScoreboardPhoto(original?.foto_url, supabaseUrl);
  if (foto) out.foto_url = foto;
  return out;
}

/** Server-only repeatable-read snapshot; no writes, locks, audit actors or profile queries. */
export async function projectCurrentNationsLineup({ pool, row, supabaseUrl, torneoId } = {}) {
  if (!pool?.connect) return null;
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const context = await loadNationsMarkerMatchContext(client, String(row.id));
    if (context.notNations
      || String(context.partidoTorneoId) !== String(row.partido_torneo_id)
      || (row.torneo_id != null && String(context.torneoId) !== String(row.torneo_id))
      || (torneoId != null && String(context.torneoId) !== String(torneoId))) {
      throw Error('PUBLIC_LINEUP_SCOPE');
    }
    const aggregate = (await client.query(
      'SELECT revision,states,tracking_status FROM nations_marker_private.nations_marker_match WHERE match_id=$1',
      [String(row.id)],
    )).rows[0];
    if (!aggregate
      || aggregate.tracking_status !== 'active'
      || !Number.isSafeInteger(Number(aggregate.revision))
      || Number(aggregate.revision) < 0
      || !object(aggregate.states)
      || !same(Object.keys(aggregate.states).sort(), Object.keys(context.teams).sort())) {
      throw Error('PUBLIC_LINEUP_UNCONFIRMED');
    }
    const out = { nations_lineup_status: 'current', nations_lineup_revision: Number(aggregate.revision) };
    for (const side of ['A', 'B']) {
      const team = context.teams[context.membership[side]];
      const state = aggregate.states[team.teamId];
      const ids = team.players.map((player) => player.id);
      if (!object(state)
        || !['open', 'paused', 'closed', 'corrected'].includes(state.status)
        || !Array.isArray(state.active)
        || state.active.length !== 2
        || new Set(state.active).size !== 2
        || state.active.some((id) => !ids.includes(id))
        || !object(state.lineup)
        || !same(state.lineup.iniciales, team.lineup.iniciales)
        || !same(state.lineup.suplentes, team.lineup.suplentes)
        || !same(state.roster, ids)) {
        throw Error('PUBLIC_LINEUP_UNCONFIRMED');
      }
      const field = side === 'A' ? 'equipo_a_jugadores' : 'equipo_b_jugadores';
      const raw = Array.isArray(row[field]) ? row[field] : [];
      out[field] = team.players.map((player) => presentPlayer(player, state.active, raw, supabaseUrl));
    }
    await client.query('COMMIT');
    return out;
  } catch {
    try { await client?.query('ROLLBACK'); } catch {}
    return null;
  } finally {
    client?.release();
  }
}
