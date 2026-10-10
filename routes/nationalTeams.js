import { isNationalRoster, nationalError, rosterPlayers, validateNationalLineup, validateNationalRoster, validateRevision, lineupDto } from '../lib/nationalTeamLineup.js';
import { resolveTorneoAdminAccess } from '../lib/torneos/torneoAdminAccessService.js';
const numeric = v => Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
const unlocked = m => ['pendiente','programado'].includes(String(m?.estado??'').toLowerCase());
async function read(db,table,fields,id){const {data,error}=await db.from(table).select(fields).eq('id',id).maybeSingle();if(error)throw error;if(!data)throw nationalError('No encontrado.',404);return data;}
function sendError(res,error){return res.status(error.status??503).json({error:error.status?error.message:'No se pudo confirmar el guardado. Reintenta.',code:error.code??'NATIONAL_STORAGE_UNAVAILABLE'});}
export function mountNationalTeamRoutes(app,{db,getAuthenticatedUser,getRole}) {
 async function context(req,{team=false,match=false}={}) {
  const result=await getAuthenticatedUser(req);if(!result.user)throw nationalError('Inicia sesión.',result.status??401,'AUTH_REQUIRED');
  const tid=numeric(req.params.id);if(!tid)throw nationalError('Torneo inválido.');
  const torneo=await read(db,'torneos','id,sede_id,deporte,modalidad_plantel,estado,costo_inscripcion,inscripcion_monto',tid);
  const equipo=team?await read(db,'equipos','id,torneo_id,creador_id,nombre,jugadores,solicitudes,cupo_maximo,equipo_abierto,plantel_revision,inscripcion_estado',numeric(req.params.equipoId)):null;
  if(equipo&&Number(equipo.torneo_id)!==tid)throw nationalError('Equipo de otro torneo.',404);
  const captain=equipo?.creador_id===result.user.id;
  const role=await getRole(result.user);
  const admin=resolveTorneoAdminAccess({user:result.user,role},torneo.sede_id).allowed;
  const partido=match?await read(db,'partidos','id,torneo_id,estado,equipo_a_id,equipo_b_id',numeric(req.params.partidoId)):null;
  if(partido&&(Number(partido.torneo_id)!==tid||![Number(partido.equipo_a_id),Number(partido.equipo_b_id)].includes(Number(equipo?.id))))throw nationalError('El equipo no pertenece a este partido.',404);
  return {torneo,equipo,partido,user:result.user,captain,admin};
 }
 function teamDto(c,row,status){if(!row||!numeric(row.id)||Number(row.torneo_id)!==Number(c.torneo.id)||(c.equipo&&Number(row.id)!==Number(c.equipo.id)))throw nationalError('Guardado sin confirmación.',503,'NATIONAL_RECEIPT_INVALID');return {ok:true,status,torneo_id:Number(row.torneo_id),equipo_id:Number(row.id),can_manage:Boolean(c.admin||c.captain||row.creador_id===c.user.id),can_add_profiles:Boolean(c.admin),inscripcion_estado:row.inscripcion_estado,can_confirm:(c.captain||c.admin||row.creador_id===c.user.id)&&['planificacion','proximo','inscripcion','abierto','inscripcion_abierta'].includes(c.torneo.estado)&&rosterPlayers(row).length>=4&&[c.torneo.costo_inscripcion,c.torneo.inscripcion_monto].some(v=>v!=null)&&[c.torneo.costo_inscripcion,c.torneo.inscripcion_monto].every(v=>v==null||Number(v)===0),plantel_revision:Number(row.plantel_revision),cupo_maximo:row.cupo_maximo,equipo_abierto:row.equipo_abierto===true,creador_id:row.creador_id,jugadores:rosterPlayers(row).map(p=>({...p,id:p.user_id})),solicitudes:(c.captain||c.admin)&&Array.isArray(row.solicitudes)?row.solicitudes.map(p=>({user_id:String(p.user_id??p.id),nombre:String(p.nombre??'')})):[]};}
 async function changeTeam(req,res,action) {try{
  const c=await context(req,{team:action!=='crear'});if(!isNationalRoster(c.torneo)||c.torneo.deporte!=='padbol')throw nationalError('El torneo no usa planteles de selecciones.',409);
  if(['plantel','confirmar'].includes(action)&&!c.captain&&!c.admin)throw nationalError('Solo el capitán o el administrador del torneo puede editar el plantel.',403);
  const body=req.body??{};
  if(action==='confirmar'&&([c.torneo.costo_inscripcion,c.torneo.inscripcion_monto].every(v=>v==null)||[c.torneo.costo_inscripcion,c.torneo.inscripcion_monto].some(v=>v!=null&&Number(v)!==0)))throw nationalError('Esta confirmación admite sólo inscripción gratuita. El pago requiere su circuito autorizado.',409,'NATIONAL_PAYMENT_FLOW_REQUIRED');
  const ids=action==='plantel'?validateNationalRoster(body.user_ids):[];
  const capacity=action==='crear'?body.cupo_maximo??8:null;if(action==='crear'&&(!Number.isInteger(capacity)||capacity<4||capacity>8))throw nationalError('La capacidad debe ser de 4 a 8 jugadores.');
  const name=String(body.nombre??'').trim();if(action==='crear'&&(!name||name.length>120))throw nationalError('Completa el nombre de la selección (máximo 120 caracteres).');
  const {data,error}=await db.rpc('guardar_plantel_seleccion',{p_torneo_id:Number(c.torneo.id),p_equipo_id:c.equipo?.id??null,p_actor_id:c.user.id,p_admin:c.admin,p_accion:action,p_nombre:name,p_cupo:capacity,p_abierto:body.equipo_abierto===true,p_user_ids:ids,p_revision:['plantel','confirmar'].includes(action)?validateRevision(body.expected_revision):null});
  if(error){if(['40001','23505'].includes(error.code))throw nationalError('El plantel cambió. Actualiza y reintenta.',409,'NATIONAL_TEAM_CONFLICT');if(error.code==='22023')throw nationalError('Revisa el plantel, los permisos y el estado del torneo.',400);throw error;}
  if(!data?.equipo||!['saved','idempotent'].includes(data.status))throw nationalError('Guardado sin confirmación.',503);
  return res.status(action==='crear'?201:200).json(teamDto(c,data.equipo,data.status));
 }catch(error){return sendError(res,error);}}
 app.post('/api/torneos/:id/selecciones',(req,res)=>changeTeam(req,res,'crear'));
 app.post('/api/torneos/:id/selecciones/:equipoId/confirmar',(req,res)=>changeTeam(req,res,'confirmar'));
 app.get('/api/torneos/:id/selecciones',async(req,res)=>{try{const c=await context(req);if(!isNationalRoster(c.torneo))throw nationalError('El torneo no usa selecciones.',409);const {data,error}=await db.from('equipos').select('id,nombre,cupo_maximo,equipo_abierto,creador_id,jugadores,inscripcion_estado,plantel_revision').eq('torneo_id',c.torneo.id).order('id');if(error)throw error;return res.json({ok:true,torneo_id:Number(c.torneo.id),equipos:(data??[]).map(e=>({id:e.id,nombre:e.nombre,can_manage:Boolean(c.admin||e.creador_id===c.user.id),cupo_maximo:e.cupo_maximo,equipo_abierto:e.equipo_abierto===true,creador_id:e.creador_id,inscripcion_estado:e.inscripcion_estado,plantel_revision:e.plantel_revision,jugadores:rosterPlayers(e)}))});}catch(e){return sendError(res,e);}});
 app.post('/api/torneos/:id/selecciones/:equipoId/solicitudes',(req,res)=>changeTeam(req,res,'solicitar'));
 app.put('/api/torneos/:id/selecciones/:equipoId/plantel',(req,res)=>changeTeam(req,res,'plantel'));
 app.get('/api/torneos/:id/selecciones/:equipoId',async(req,res)=>{try{const c=await context(req,{team:true});if(!c.captain&&!c.admin)throw nationalError('Sin permiso para consultar el plantel.',403);return res.json(teamDto(c,c.equipo));}catch(e){return sendError(res,e);}});
 async function lineup(req,res,write=false){try{
  const c=await context(req,{team:true,match:true});if(!c.captain&&!c.admin)throw nationalError('Solo el capitán o el administrador del torneo puede consultar esta alineación.',403);
  const required=isNationalRoster(c.torneo);
  let markerExists=false;
  if(required){const marker=await db.from('scoreboard_partidos').select('id').eq('partido_torneo_id',c.partido.id).limit(1);if(marker.error)throw marker.error;markerExists=(marker.data??[]).length>0;}
  const canEdit=!markerExists&&required&&unlocked(c.partido)&&['planificacion','proximo','inscripcion','abierto','inscripcion_abierta','en_curso'].includes(c.torneo.estado)&&c.equipo.inscripcion_estado==='confirmado';
  const base={ok:true,torneo_id:Number(c.torneo.id),partido_id:Number(c.partido.id),equipo_id:Number(c.equipo.id),modalidad_plantel:c.torneo.modalidad_plantel??'dobles',required,can_edit:canEdit,plantel:rosterPlayers(c.equipo),alternancia:required?'games_impares':null,manual_date_supported:!required};
  if(!required){if(write)throw nationalError('Las duplas no requieren esta alineación.',409);return res.json({...base,alineacion:null});}
  let row;
  if(write){if(!canEdit)throw nationalError('El partido ya no permite cambiar sus convocados.',409);
   const validated=validateNationalLineup(req.body,c.equipo);
   const {data,error}=await db.rpc('guardar_alineacion_seleccion',{p_torneo_id:Number(c.torneo.id),p_partido_id:Number(c.partido.id),p_equipo_id:Number(c.equipo.id),p_actor_id:c.user.id,p_admin:c.admin,p_iniciales:validated.iniciales,p_suplentes:validated.suplentes,p_revision:validateRevision(req.body.expected_revision)});
   if(error){if(error.code==='40001')throw nationalError('La alineación cambió. Actualiza y reintenta.',409);if(error.code==='22023')throw nationalError('Revisa los convocados y el estado del partido.',409);throw error;}row=data;
  }else{const result=await db.from('torneo_partido_alineaciones').select('torneo_id,partido_id,equipo_id,iniciales,suplentes,revision').eq('partido_id',c.partido.id).eq('equipo_id',c.equipo.id).maybeSingle();if(result.error)throw result.error;row=result.data;}
  if(row&&(Number(row.partido_id)!==Number(c.partido.id)||Number(row.equipo_id)!==Number(c.equipo.id)||Number(row.torneo_id)!==Number(c.torneo.id)))throw nationalError('Alineación sin confirmación.',503);
  if(row){validateNationalLineup(row,c.equipo);if(!Number.isSafeInteger(Number(row.revision))||Number(row.revision)<1)throw nationalError('Alineación sin revisión confirmada.',503);}
  if(write&&!row)throw nationalError('Alineación sin confirmación.',503);
  return res.json({...base,alineacion:lineupDto(row)});
 }catch(e){return sendError(res,e);}}
 app.get('/api/torneos/:id/partidos/:partidoId/equipos/:equipoId/alineacion',(req,res)=>lineup(req,res));
 app.put('/api/torneos/:id/partidos/:partidoId/equipos/:equipoId/alineacion',(req,res)=>lineup(req,res,true));
}
