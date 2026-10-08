import { MANUAL_PLAYED_DATE_CAPABILITY } from './manualPlayedDateCapability.js';
import { readManualPlayedDate } from './manualPlayedDateService.js';
import { unwrapResultadoJson } from './finalizarPartidoTorneoService.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const positiveId = value => (typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value)))
  && Number.isSafeInteger(Number(value)) && Number(value) > 0;
const fail = (status, code) => Object.assign(new Error('No se pudo comprobar la disponibilidad de la fecha declarada.'), { status, code });
const MATCH_SELECT = 'id,torneo_id,sede_id,estado,resultado,equipo_a_id,equipo_b_id,ganador_equipo_id';

/** Read-only advisory capability. Every later POST/PUT remains independently authorized by SQL. */
export async function getManualPlayedDateCapability(db, { torneoId, partidoId, actorId }, {
  capabilities = MANUAL_PLAYED_DATE_CAPABILITY,
  now = () => new Date(),
} = {}) {
  if (!positiveId(torneoId) || !positiveId(partidoId)) throw fail(400, 'MANUAL_DATE_CAPABILITY_INVALID_SCOPE');
  if (typeof actorId !== 'string' || !UUID.test(actorId)) throw fail(401, 'MANUAL_DATE_CAPABILITY_UNAUTHENTICATED');
  const tid = Number(torneoId), pid = Number(partidoId);
  const roleReply = await db.from('user_roles').select('user_id,role,sede_id').eq('user_id', actorId).limit(2);
  if (roleReply?.error) throw fail(503, 'MANUAL_DATE_CAPABILITY_UNAVAILABLE');
  const roles = roleReply?.data;
  const role = Array.isArray(roles) && roles.length === 1 ? roles[0] : null;
  if (!role || role.user_id?.toLowerCase() !== actorId.toLowerCase()
    || !(role.role === 'super_admin' || (role.role === 'admin_club' && positiveId(role.sede_id)))) {
    throw fail(403, 'MANUAL_DATE_CAPABILITY_ROLE_DENIED');
  }
  const [tournamentReply, matchReply] = await Promise.all([
    db.from('torneos').select('id,sede_id,deporte,formato_equipo,estado').eq('id', tid).maybeSingle(),
    db.from('partidos').select(MATCH_SELECT).eq('id', pid).maybeSingle(),
  ]);
  if ([tournamentReply, matchReply].some(reply => reply?.error)) throw fail(503, 'MANUAL_DATE_CAPABILITY_UNAVAILABLE');
  const t = tournamentReply?.data, p = matchReply?.data;
  if (!t || !p || Number(t.id) !== tid || Number(p.id) !== pid || Number(p.torneo_id) !== tid) throw fail(404, 'MANUAL_DATE_CAPABILITY_MATCH_NOT_FOUND');
  // Strict persisted venue is also required by the durable next-match effects contract.
  if (!positiveId(t.sede_id) || !positiveId(p.sede_id) || Number(p.sede_id) !== Number(t.sede_id)) throw fail(403, 'MANUAL_DATE_CAPABILITY_SCOPE_DENIED');
  if (role.role === 'admin_club' && Number(role.sede_id) !== Number(t.sede_id)) {
    throw fail(403, 'MANUAL_DATE_CAPABILITY_ROLE_DENIED');
  }
  const stamp = now();
  if (!(stamp instanceof Date) || !Number.isFinite(stamp.getTime())) throw fail(503, 'MANUAL_DATE_CAPABILITY_UNAVAILABLE');
  const answer = {
    schema: 'torneo-manual-date/v1', enabled: false, user_id: actorId,
    torneo_id: tid, partido_id: pid, sede_id: Number(t.sede_id),
    operations: { declare: false, correct: false },
    expires_at: new Date(stamp.getTime() + 60_000).toISOString(),
  };
  // Evaluator readEnabled is unrelated to form writing. OFF works before private SQL installation.
  if (capabilities?.writeEnabled !== true) return answer;
  if (t.deporte !== 'padbol' || t.formato_equipo !== 'dobles'
    || !positiveId(p.equipo_a_id) || !positiveId(p.equipo_b_id) || Number(p.equipo_a_id) === Number(p.equipo_b_id)) return answer;

  const result = unwrapResultadoJson(p.resultado);
  const manualSource = result && typeof result === 'object' && !Array.isArray(result)
    && (result.fuente_resultado === 'manual_admin' || (!Object.hasOwn(result, 'fuente_resultado') && result.set1 && result.set2));
  const winner = p.ganador_equipo_id ?? result?.ganador_id;
  const finalizedManual = p.estado === 'finalizado' && manualSource && positiveId(winner)
    && [Number(p.equipo_a_id), Number(p.equipo_b_id)].includes(Number(winner));
  const newResult = ['en_curso', 'activo'].includes(t.estado)
    && ['pendiente', 'en_curso', 'activo'].includes(p.estado) && p.resultado == null;
  if (!finalizedManual && !newResult) return answer;

  if (newResult) {
    const { data: teams, error } = await db.from('equipos').select('id,torneo_id,sede_id,inscripcion_estado')
      .in('id', [p.equipo_a_id, p.equipo_b_id]);
    if (error) throw fail(503, 'MANUAL_DATE_CAPABILITY_UNAVAILABLE');
    if (!Array.isArray(teams) || teams.length !== 2
      || new Set(teams.map(team => Number(team.id))).size !== 2
      || teams.some(team => ![Number(p.equipo_a_id), Number(p.equipo_b_id)].includes(Number(team.id))
        || Number(team.torneo_id) !== tid || (team.sede_id != null && Number(team.sede_id) !== Number(t.sede_id))
        || team.inscripcion_estado !== 'confirmado')) return answer;
  }
  // Rechecks the bound SQL role inside the existing private read transaction; never a write RPC.
  // It reads only the declaration DTO, not participants/audit/history, and is skipped entirely OFF.
  const date = await readManualPlayedDate(db, { torneoId: tid, partidoId: pid, actorId });
  if (date && date.vigente !== true) return answer;
  if (newResult && date) return answer; // Inconsistent prior state requires review, not automatic revival.
  answer.operations.declare = Boolean(newResult || finalizedManual);
  answer.operations.correct = Boolean(finalizedManual && date?.vigente === true);
  // Keep declare for an already saved manual result: pending effects must remain retryable unchanged.
  answer.enabled = answer.operations.declare || answer.operations.correct;
  return answer;
}

export function mountManualPlayedDateCapabilityRoute(app, {
  supabaseAdmin, getAuthenticatedUser,
  capabilities = MANUAL_PLAYED_DATE_CAPABILITY,
  now,
}) {
  app.get('/api/torneos/:torneoId/partidos/:partidoId/fecha-juego/capacidad', async (req, res) => {
    res.set('Cache-Control', 'private, no-store');
    res.set('Pragma', 'no-cache');
    res.vary('Authorization');
    try {
      const { torneoId, partidoId } = req.params;
      if (!positiveId(torneoId) || !positiveId(partidoId)) throw fail(400, 'MANUAL_DATE_CAPABILITY_INVALID_SCOPE');
      // Authenticate without the legacy admin guard: its role resolver can claim
      // a pending email assignment. This GET authorizes only an existing UUID link.
      const auth = await getAuthenticatedUser(req);
      if (!auth?.user) throw fail(401, 'MANUAL_DATE_CAPABILITY_UNAUTHENTICATED');
      const data = await getManualPlayedDateCapability(supabaseAdmin,
        { torneoId, partidoId, actorId: auth.user?.id }, { capabilities, now });
      res.json(data);
    } catch (cause) {
      const status = [400, 401, 403, 404, 409, 503].includes(cause?.status) ? cause.status : 503;
      const code = /^(MANUAL_DATE_CAPABILITY_[A-Z_]+|FECHA_JUEGO_(RECHAZADA|NO_DISPONIBLE|NO_CONFIRMADA))$/.test(cause?.code)
        ? cause.code : 'MANUAL_DATE_CAPABILITY_UNAVAILABLE';
      res.status(status).json({ ok: false, code,
        error: 'No se pudo comprobar la disponibilidad de la fecha declarada.' });
    }
  });
}
