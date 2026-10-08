import { isDeepStrictEqual } from 'node:util';
import { unwrapResultadoJson } from './finalizarPartidoTorneoService.js';

export const MANUAL_DATE_SELECT = 'partido_id,torneo_id,sede_id,fecha_juego,procedencia,revision,vigente,resultado_snapshot,equipo_a_id,equipo_b_id,ganador_equipo_id,participantes_a,participantes_b,participantes_procedencia,registrado_at,actualizado_at';
const PUBLIC_FIELDS = ['fecha_juego','procedencia','revision','vigente','registrado_at','actualizado_at'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(status, code, message) { return Object.assign(new Error(message), { status, code }); }
function positiveId(value) { return ((typeof value === 'number' || (typeof value === 'string' && /^[1-9]\d*$/.test(value))) && Number.isSafeInteger(Number(value)) && Number(value)>0) ? Number(value) : null; }
function validDate(date) {
  if (typeof date!=='string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || date<'0001-01-01') return false;
  const parsed=new Date(`${date}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0,10)===date;
}
export function parsePlayedDate(body, { now = new Date(), optional = false } = {}) {
  if (optional && body?.fecha_juego === undefined) return null;
  const date=body?.fecha_juego;
  if (!validDate(date) || date>now.toISOString().slice(0,10)) throw fail(400,'FECHA_JUEGO_INVALIDA','Indica una fecha de juego válida, no futura.');
  const revision=body?.revision_esperada ?? 0;
  if (!Number.isSafeInteger(revision) || revision<0) throw fail(400,'FECHA_JUEGO_REVISION_INVALIDA','Recarga la fecha actual del partido.');
  const reason=body?.motivo_correccion;
  if (revision>0 && (typeof reason!=='string' || reason.trim().length<5 || [...reason].length>300)) {
    throw fail(400,'FECHA_JUEGO_MOTIVO_REQUERIDO','Explica el motivo de la corrección (5 a 300 caracteres).');
  }
  return { date, revision, reason: revision>0 ? reason.trim() : null };
}
function publicDate(row) {
  if (!row || !validDate(row.fecha_juego) || row.procedencia!=='declaracion_operador'
    || !Number.isSafeInteger(row.revision) || row.revision<=0 || typeof row.vigente!=='boolean'
    || typeof row.registrado_at!=='string' || typeof row.actualizado_at!=='string'
    || !Number.isFinite(Date.parse(row.registrado_at)) || !Number.isFinite(Date.parse(row.actualizado_at))
    || Date.parse(row.actualizado_at)<Date.parse(row.registrado_at)
    || row.fecha_juego>new Date(row.actualizado_at).toISOString().slice(0,10)) {
    throw fail(503,'FECHA_JUEGO_NO_CONFIRMADA','El servidor no confirmó la fecha de juego.');
  }
  return Object.fromEntries(PUBLIC_FIELDS.map(key=>[key,row[key]]));
}
export function matchesManualDateEvidence(row, match, tournament) {
  const result=unwrapResultadoJson(match?.resultado);
  const manual=result?.fuente_resultado==='manual_admin'
    || (result && !Object.hasOwn(result,'fuente_resultado') && result.set1 && result.set2);
  try { publicDate(row); } catch { return false; }
  return Boolean(manual && match?.estado==='finalizado' && row.vigente===true
    && positiveId(row.partido_id) && positiveId(row.partido_id)===positiveId(match.id)
    && positiveId(row.torneo_id) && positiveId(row.torneo_id)===positiveId(tournament?.id)
    && positiveId(match.torneo_id)===positiveId(tournament.id)
    && positiveId(row.sede_id) && positiveId(row.sede_id)===positiveId(tournament.sede_id)
    && (match.sede_id==null || positiveId(match.sede_id)===positiveId(tournament.sede_id))
    && positiveId(row.equipo_a_id) && positiveId(row.equipo_a_id)===positiveId(match.equipo_a_id)
    && positiveId(row.equipo_b_id) && positiveId(row.equipo_b_id)===positiveId(match.equipo_b_id)
    && positiveId(row.equipo_a_id)!==positiveId(row.equipo_b_id)
    && (row.ganador_equipo_id==null ? match.ganador_equipo_id==null : positiveId(row.ganador_equipo_id)===positiveId(match.ganador_equipo_id))
    && isDeepStrictEqual(row.resultado_snapshot,match.resultado));
}
/** UUIDs captured when recording a new result. This is declared roster evidence, not physical presence.
 * No fallback to current team membership for historical/legacy results. Account and venue eligibility
 * must still be checked by the future monthly evaluator; digital activity uses its existing evidence.
 */
export function getManualDateParticipantIds(row, match, tournament) {
  if (!matchesManualDateEvidence(row,match,tournament) || row.participantes_procedencia!=='plantel_al_registrar_resultado'
    || !Array.isArray(row.participantes_a) || row.participantes_a.length!==2
    || !Array.isArray(row.participantes_b) || row.participantes_b.length!==2) return [];
  const ids=[...row.participantes_a,...row.participantes_b];
  if (!ids.every(id=>typeof id==='string' && UUID.test(id))) return [];
  const normalized=ids.map(id=>id.toLowerCase());
  return new Set(normalized).size===4 ? normalized : [];
}
function rpcParams({torneoId,partidoId,actorId}) {
  const tid=positiveId(torneoId),pid=positiveId(partidoId);
  if (!tid || !pid) throw fail(400,'FECHA_JUEGO_PARAMETROS_INVALIDOS','Partido o torneo inválido.');
  // actorId comes only from the verified auth result supplied by the route, never body.actor_id.
  if (typeof actorId!=='string' || !UUID.test(actorId)) throw fail(401,'FECHA_JUEGO_NO_AUTORIZADA','Inicia sesión para declarar la fecha.');
  return {p_torneo_id:tid,p_partido_id:pid,p_actor_id:actorId};
}
async function callRpc(supabase,name,params) {
  let reply;
  try { reply=await supabase.rpc(name,params); } catch { throw fail(503,'FECHA_JUEGO_NO_DISPONIBLE','No se pudo confirmar la operación. Reintenta con los mismos datos.'); }
  if (reply?.error) {
    const status=({'42501':403,P0002:404,'22023':400,'22007':400,'22008':400,'40001':409,'40P01':409})[reply.error.code]||503;
    const messages={400:'Comprueba la fecha, el resultado manual y el motivo de corrección.',403:'No tienes permiso para declarar la fecha de este partido.',404:'Partido o torneo no encontrado.',409:'Los datos cambiaron. Recarga el partido antes de corregirlos.',503:'No se pudo confirmar la operación. Reintenta con los mismos datos.'};
    throw fail(status,status===503?'FECHA_JUEGO_NO_DISPONIBLE':'FECHA_JUEGO_RECHAZADA',messages[status]);
  }
  return reply?.data;
}
async function save(supabase,params,deps,atomic) {
  const args=rpcParams(params),parsed=parsePlayedDate(params.body,deps);
  if (atomic && (params.resultado==null || typeof params.resultado!=='object' || Array.isArray(params.resultado))) {
    throw fail(400,'RESULTADO_MANUAL_INVALIDO','Indica un resultado manual válido.');
  }
  const data=await callRpc(supabase,'registrar_fecha_juego_manual',{
    ...args,p_fecha_juego:parsed.date,p_expected_revision:parsed.revision,p_motivo:parsed.reason,
    p_resultado:atomic ? params.resultado : null,
  });
  const date=publicDate(data);
  if (date.fecha_juego!==parsed.date || !date.vigente || positiveId(data.partido_id)!==args.p_partido_id
    || positiveId(data.torneo_id)!==args.p_torneo_id || !['finalized','idempotent'].includes(data.status)
    || (!atomic && data.status!=='idempotent')) throw fail(503,'FECHA_JUEGO_NO_CONFIRMADA','El servidor no confirmó la operación completa.');
  if (!atomic) return date;
  const result=data.resultado;
  if (!result || !((result.goles_a===2 && [0,1].includes(result.goles_b)) || (result.goles_b===2 && [0,1].includes(result.goles_a)))
    || !positiveId(data.ganador_equipo_id)) throw fail(503,'FECHA_JUEGO_NO_CONFIRMADA','El servidor no confirmó el resultado completo.');
  const publicResult={goles_a:result.goles_a,goles_b:result.goles_b};
  if (result.historial_sets!=null) {
    if (!Array.isArray(result.historial_sets)) throw fail(503,'FECHA_JUEGO_NO_CONFIRMADA','El servidor no confirmó el resultado completo.');
    publicResult.historial_sets=result.historial_sets.map(({set,a,b})=>({set,a,b}));
  }
  return {partido_id:args.p_partido_id,torneo_id:args.p_torneo_id,status:data.status,
    resultado:publicResult,ganador_equipo_id:positiveId(data.ganador_equipo_id),fecha_declarada:date};
}
export async function saveManualPlayedDate(supabase,params,deps={}) { return save(supabase,params,deps,false); }
/** One RPC commits sporting result, winner, declaration and audit together. No external side effects. */
export async function saveManualResultAndPlayedDate(supabase,params,deps={}) { return save(supabase,params,deps,true); }
export async function readManualPlayedDate(supabase,params) {
  const data=await callRpc(supabase,'leer_fecha_juego_manual',rpcParams(params));
  return data===null ? null : publicDate(data);
}
// Remains unmounted. Future server integration must supply its verified JWT guard.
export function mountManualPlayedDateRoutes(app,{supabaseAdmin,requireTorneoAdminByTorneoId,enabled=true}) {
  const path='/api/torneos/:torneoId/partidos/:partidoId/fecha-juego';
  const handler=write=>async(req,res)=>{
    try {
      const {torneoId,partidoId}=req.params;
      if (!positiveId(torneoId) || !positiveId(partidoId)) throw fail(400,'FECHA_JUEGO_PARAMETROS_INVALIDOS','Partido o torneo inválido.');
      const auth=await requireTorneoAdminByTorneoId(req,res,torneoId); if (!auth) return;
      if (enabled!==true) throw fail(409,'MANUAL_PLAYED_DATE_DISABLED','La fecha declarada todavía no está habilitada.');
      const params={torneoId,partidoId,actorId:auth.user?.id,body:req.body};
      const date=await (write ? saveManualPlayedDate(supabaseAdmin,params) : readManualPlayedDate(supabaseAdmin,params));
      res.json({ok:true,partido_id:Number(partidoId),torneo_id:Number(torneoId),fecha_declarada:date});
    } catch(err) { res.status(err.status||500).json({ok:false,code:err.code||'FECHA_JUEGO_ERROR',error:err.status ? err.message : 'No se pudo registrar la fecha.'}); }
  };
  app.get(path,handler(false)); app.put(path,handler(true));
}
