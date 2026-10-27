import { participantSportingReadiness, tournamentParticipantLimits } from '../lib/tournamentParticipantsReadiness.js';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const ACTION_PATHS = [
 ['get','/api/torneos/:id/participantes','listar'],
 ['post','/api/torneos/:id/participantes','crear_participante'],
 ['patch','/api/torneos/:id/participantes/:participanteId','editar_participante'],
 ['post','/api/torneos/:id/inscripciones-participantes','inscribir'],
 ['post','/api/torneos/:id/participantes/:participanteId/vinculacion','solicitar_vinculacion'],
 ['post','/api/torneos/:id/vinculaciones/:solicitudId/resolver','resolver_vinculacion'],
 ['post','/api/torneos/:id/homologacion','acreditacion:homologar'],
 ['post','/api/torneos/:id/participantes/:participanteId/acreditacion','acreditacion:solicitar'],
 ['post','/api/torneos/:id/acreditaciones/:acreditacionId/resolver','acreditacion:resolver'],
];
function decorateTeam(team, torneo, catalog = []) {
 const roster=(team.jugadores || team.participants || []).map(p=>{
  const current=catalog.find(c=>c.id===p.participante_id);
  return {...current,...p,id:current?.id || p.participante_id || p.id || null,
   can_edit:current?.can_edit===true,can_claim:current?.can_claim===true,
   can_request_accreditation:current?.can_request_accreditation===true,
   estado_vinculacion:current?.estado_vinculacion ?? p.estado_vinculacion,
   ranking_oficial_elegible:current?.ranking_oficial_elegible ?? p.ranking_oficial_elegible ?? false};
 });
 return { ...team, habilitacion_deportiva: participantSportingReadiness(torneo,roster),
  participants: roster, ranking_oficial_elegible: roster.length>0 && roster.every(p=>p.ranking_oficial_elegible===true) };
}
export function mountTournamentParticipantsRoutes(app, { db, getAuthenticatedUser }) {
 for (const [method,path,action] of ACTION_PATHS) app[method](path,async(req,res)=>{
  try {
   const auth=await getAuthenticatedUser(req);if(!auth.user)return res.status(auth.status||401).json({ok:false,error:'Inicia sesión.',code:'AUTH_REQUIRED'});
   const tid=Number(req.params.id),body=req.body||{};
   if(!Number.isSafeInteger(tid)||tid<=0)return res.status(400).json({ok:false,error:'Torneo inválido.'});
   if(method!=='get'&&!UUID.test(body.request_id||''))return res.status(400).json({ok:false,error:'Identificador de operación requerido.'});
   for(const key of ['participanteId','solicitudId','acreditacionId'])if(req.params[key]&&!UUID.test(req.params[key]))return res.status(400).json({ok:false,error:'Participante o solicitud inválida.'});
   const payload={...body};delete payload.actor_id;delete payload.user_id;delete payload.ranking_oficial_elegible;
   if(req.params.participanteId)payload.participante_id=req.params.participanteId;
   if(req.params.solicitudId)payload.solicitud_id=req.params.solicitudId;
   if(req.params.acreditacionId)payload.acreditacion_id=req.params.acreditacionId;
   const {data,error}=await db.rpc(action.startsWith('acreditacion:')?'gestionar_acreditacion_participante':'gestionar_participantes_torneo',{p_torneo_id:tid,p_actor_id:auth.user.id,p_accion:action.replace('acreditacion:',''),p_payload:payload});
   if(error){const code=error.code;const status=code==='42501'?403:code==='P0002'?404:['23505','40001','55000'].includes(code)?409:['22023','22P02'].includes(code)?400:503;return res.status(status).json({ok:false,code:'PARTICIPANTS_UNCONFIRMED',error:status===403?'No tienes permiso sobre estos participantes.':status===409?'El equipo, la vinculación o el estado cambió. Actualiza y revisa los requisitos.':status===400?'Revisa nombres, plazas y límites del equipo.':'No se pudo confirmar la operación.'});}
   if(data?.ok!==true||Number(data.torneo_id)!==tid)return res.status(503).json({ok:false,error:'No se recibió confirmación del servidor.'});
   if (action==='listar' && (!Array.isArray(data.participants)||!Array.isArray(data.teams)||!Array.isArray(data.link_requests))) return res.status(503).json({ok:false,error:'Catálogo sin verificar.'});
   if (action==='inscribir' && (!Number.isSafeInteger(Number(data.equipo?.id))||Number(data.equipo?.torneo_id)!==tid||!Array.isArray(data.equipo?.jugadores)||!['created','idempotent'].includes(data.status))) return res.status(503).json({ok:false,error:'No se confirmó el equipo.'});
   if (['crear_participante','editar_participante'].includes(action) && (!UUID.test(data.participante?.id||'')||Number(data.participante?.torneo_id)!==tid)) return res.status(503).json({ok:false,error:'No se confirmó el participante.'});
   if (['solicitar_vinculacion','resolver_vinculacion','acreditacion:solicitar','acreditacion:resolver'].includes(action) && (!UUID.test(data.solicitud?.id||'')||!UUID.test(data.solicitud?.participante_id||''))) return res.status(503).json({ok:false,error:'No se confirmó la revisión.'});
   if (action==='acreditacion:homologar' && (data.homologacion?.estado!=='aprobada'||!data.homologacion?.referencia_oficial)) return res.status(503).json({ok:false,error:'No se confirmó la homologación.'});
   const torneo=data.torneo||{};const result={...data};delete result.torneo;
   if(result.teams)result.teams=result.teams.map(t=>decorateTeam(t,torneo,result.participants));
   if(result.equipo)result.equipo=decorateTeam(result.equipo,torneo);
   if(action==='listar')result.limits=tournamentParticipantLimits(torneo);
   return res.status(method==='post'&&data.status==='created'?201:200).json(result);
  }catch{return res.status(503).json({ok:false,error:'No se pudo verificar la operación.'});}
 });
}
