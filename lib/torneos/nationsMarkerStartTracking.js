import {loadNationsMarkerMatchContext} from './nationsMarkerMatchContext.js';
import {clockSnapshot} from './nationsMarkerClockContinuity.js';
import {assertScoreboardMutable} from '../../src/scoreboard/scoreboardControlAuth.js';
const fail = (code, status = 409) => { throw Object.assign(new Error(code), { code, status }); };
/** START aislado: una transacción inicia cronómetro oficial, agregado, receipt y audit baseline. */
export async function startNationsMarkerTracking({ pool, authorize, req, scoreboardId, idempotencyKey, payload = {} }) {
  if (!idempotencyKey) fail('IDEMPOTENCY_KEY_REQUIRED', 400);
  const actor = await authorize(req, { matchId: scoreboardId });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0))");
    const sb = await client.query('SELECT id, partido_torneo_id, cancha, cronometro_inicio, cronometro_pausado, cronometro_segundos, estado FROM scoreboard_partidos WHERE id=$1 FOR UPDATE', [scoreboardId]);
    if (!sb.rows[0]) fail('SCOREBOARD_NOT_FOUND', 404);
    const row = sb.rows[0];
    if (actor.authorizeLocked) await actor.authorizeLocked(client, row);
    try { assertScoreboardMutable(row); } catch (e) { fail('MATCH_NOT_MUTABLE', e.status === 409 ? 409 : 400); }
    if (!String(row.cancha || '').trim()) fail('COURT_REQUIRED', 409);
    const ctx = await loadNationsMarkerMatchContext(client, scoreboardId);
    const existing = await client.query('SELECT revision, states, receipts, tracking_status FROM nations_marker_private.nations_marker_match WHERE match_id=$1 FOR UPDATE', [scoreboardId]);
    if(existing.rows[0]?.tracking_status==='reset_pending')fail('GAME_TRACKING_RESTART_REQUIRED');
    const receipt = existing.rows[0]?.receipts?.start;
    if (receipt) {
      if (receipt.idempotencyKey !== idempotencyKey || receipt.actorId !== actor.actorId) fail('START_ALREADY_EXISTS');
      await client.query('COMMIT');
      return { startedAt: receipt.startedAt, revision: Number(existing.rows[0].revision), receipt, deduplicated: true };
    }
    if (existing.rows[0]) fail('TRACKING_INCOMPLETE');
    if (row.cronometro_inicio != null || row.cronometro_pausado === true || Number(row.cronometro_segundos) > 0) fail('TRACKING_INCOMPLETE');
    const ts = (await client.query('SELECT clock_timestamp() AS ts')).rows[0].ts;
    const lineupState = {};
    for (const [teamId, t] of Object.entries(ctx.teams)) lineupState[teamId] = { revision: 0, status: 'open', startedAt: new Date(ts).getTime(), closedAt: null, pausedAt: null, events: [], corrections: [], active: [...t.lineup.iniciales], lineup: { iniciales: [...t.lineup.iniciales], suplentes: [...t.lineup.suplentes] }, roster: [...t.lineup.iniciales, ...t.lineup.suplentes] };
    await client.query("UPDATE scoreboard_partidos SET cronometro_inicio=$2, cronometro_pausado=false, estado=CASE WHEN estado='pendiente' THEN 'en_curso' ELSE estado END, updated_at=now() WHERE id=$1", [scoreboardId, ts]);
    await client.query('INSERT INTO nations_marker_private.nations_marker_clock_revision(scoreboard_id,revision) VALUES($1,0) ON CONFLICT (scoreboard_id) DO NOTHING', [scoreboardId]);
    const revRow = await client.query('SELECT revision FROM nations_marker_private.nations_marker_clock_revision WHERE scoreboard_id=$1', [scoreboardId]);
    const clockAfter = clockSnapshot({ ...row, cronometro_inicio: ts, cronometro_pausado: false, estado: row.estado === 'pendiente' ? 'en_curso' : row.estado }, revRow.rows[0]?.revision || 0);
    const receipts = { __clock: clockAfter, start: { idempotencyKey, actorId: actor.actorId, startedAt: ts, lineup: Object.fromEntries(Object.entries(ctx.teams).map(([id, t]) => [id, t.lineup.revision])) } };
    await client.query('INSERT INTO nations_marker_private.nations_marker_match (match_id,revision,states,receipts,updated_at) VALUES ($1,0,$2::jsonb,$3::jsonb,now())', [scoreboardId, JSON.stringify(lineupState), JSON.stringify(receipts)]);
    await client.query('INSERT INTO nations_marker_private.nations_marker_audit (match_id,revision,kind,actor,payload) VALUES ($1,0,$2,$3,$4::jsonb)', [scoreboardId, 'start', actor.actorId, JSON.stringify({ eventId: 'start', idempotencyKey, startedAt: ts, payload })]);
    await client.query('COMMIT');
    return { startedAt: ts, revision: 0, receipt: receipts.start, deduplicated: false };
  } catch (e) { try { await client.query('ROLLBACK'); } catch {} throw e; }
  finally { client.release(); }
}
