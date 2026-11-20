import express from 'express';
import {mountNationsCupRoutes} from './nationsCup.js';
import {mountNationalTeamRoutes} from './nationalTeams.js';
import {issueNationsControlToken} from '../src/scoreboard/nationsControlDelegation.js';
import {buildControlPath} from '../src/scoreboard/scoreboardControlToken.js';
import {cargarResultadoManualPartidoTorneo} from '../lib/torneos/cargarResultadoManualPartidoTorneoService.js';
import {assertNationsOperatorGrant,assertOperatorGrantAdministrator,canOperateNationsEvent,grantNationsOperator,revokeNationsOperator,operatorEventId,operatorError} from '../lib/torneos/nationsOperatorAccess.js';

const ROOT='/api/nations/operator';
const fail=(res,e)=>res.status(e?.status||503).json({ok:false,code:e?.status?e.code:'NATIONS_OPERATOR_UNAVAILABLE',error:e?.code==='NATIONS_OPERATOR_REGISTER_VERIFIED_ACCOUNT'?'La persona debe crear su cuenta y verificar su correo; después vuelve a habilitar el acceso.':e?.status===403?'No tienes acceso a la operación de este torneo.':'No se pudo confirmar la operación. Actualiza y reintenta.'});
const pick=(row,keys)=>Object.fromEntries(keys.map(key=>[key,row?.[key]??null]));
export function mountNationsOperatorRoutes(app,{pool,db,getAuthenticatedUser,getRole}={}){
 if(!pool||!db||typeof getAuthenticatedUser!=='function'||typeof getRole!=='function')throw Error('NATIONS_OPERATOR_PORTS_REQUIRED');
 const router=express.Router();router.use(express.json({limit:'32kb'}));router.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');res.set('Referrer-Policy','no-referrer');next();});
 async function user(req){const auth=await getAuthenticatedUser(req);if(!auth?.user?.id)throw operatorError('AUTH_REQUIRED',401);return auth.user;}
 async function scope(req,{q=pool,lock=false}={}){const actor=await user(req);operatorEventId(req.params.id);try{await assertNationsOperatorGrant(q,actor.id,57,{lock});}catch(e){if(e.code!=='NATIONS_OPERATOR_SCOPE')throw e;await assertOperatorGrantAdministrator(q,actor.id,{lock});}return actor;}
 const run=fn=>async(req,res)=>{try{await fn(req,res);}catch(e){fail(res,e);}};
 const guarded=handler=>async(req,res)=>{let c;try{c=await pool.connect();await c.query('BEGIN');await scope(req,{q:c,lock:true});
  if(req.body&&['actorId','actor_id','user_id','role','rol','sede_id','torneo_id','p_admin','p_actor_id'].some(key=>Object.hasOwn(req.body,key)))throw operatorError('NATIONS_OPERATOR_BODY_SCOPE',400);
  // Hold the real grant/user locks until all delegated service work finishes,
  // including scoreboard creation after its allocation RPC. Revocation waits.
  await handler(req,res);await c.query('COMMIT');
 }catch(e){if(c)await c.query('ROLLBACK').catch(()=>{});if(!res.headersSent)fail(res,e);}finally{c?.release();}};
 router.get('/access',run(async(req,res)=>{
  const actor=await user(req);let allowed=false;
  try{await assertNationsOperatorGrant(pool,actor.id,57);allowed=true;}catch(e){if(e.code!=='NATIONS_OPERATOR_SCOPE')throw e;try{await assertOperatorGrantAdministrator(pool,actor.id);allowed=true;}catch(e){if(e.code!=='NATIONS_OPERATOR_ADMIN_REQUIRED')throw e;}}
  const events=allowed?(await pool.query('SELECT id,nombre,estado,fecha_inicio,fecha_fin FROM public.torneos WHERE id=57')).rows:[];
  res.json({ok:true,torneos:events.map(event=>pick(event,['id','nombre','estado','fecha_inicio','fecha_fin']))});
 }));
 router.get('/torneos/:id',run(async(req,res)=>{
  await scope(req);
  const event=(await pool.query('SELECT id,nombre,estado,sede_id,fecha_inicio,fecha_fin,plan_nations FROM public.torneos WHERE id=57')).rows[0];if(!event)throw operatorError('NATIONS_OPERATOR_EVENT_NOT_FOUND',404);
  const [teams,matches,boards,courts,lineups]=await Promise.all([
   pool.query('SELECT id,nombre,jugadores FROM public.equipos WHERE torneo_id=57 ORDER BY id'),
   pool.query('SELECT to_jsonb(p) AS row FROM public.partidos p WHERE torneo_id=57 ORDER BY id'),
   pool.query('SELECT id,partido_torneo_id,estado FROM public.scoreboard_partidos WHERE torneo_id=57 ORDER BY updated_at DESC'),
   pool.query("SELECT id,nombre,orden FROM public.canchas WHERE sede_id=$1 AND coalesce(deporte,'padbol')='padbol' AND coalesce(estado,'') NOT IN('inactiva','inactivo','cerrada','mantenimiento') ORDER BY orden,id",[event.sede_id]),
   pool.query('SELECT partido_id,equipo_id,iniciales,suplentes,revision FROM public.torneo_partido_alineaciones WHERE torneo_id=57'),
  ]);
  res.json({ok:true,torneo:pick(event,['id','nombre','estado','fecha_inicio','fecha_fin']),revision:Number(event.plan_nations?.revision||0),timezone:event.plan_nations?.config?.timezone||'Europe/Rome',
   equipos:teams.rows.map(team=>({id:team.id,nombre:team.nombre,jugadores:(team.jugadores||[]).map(player=>({id:player.user_id||player.participante_id||player.id,nombre:String(player.nombre||''),estado:player.estado||'confirmado'}))})),
   partidos:matches.rows.map(({row})=>({...pick(row,['id','torneo_id','equipo_a_id','equipo_b_id','grupo','bracket_round','estado','fecha_hora','cancha','cancha_id']),scoreboards:boards.rows.filter(board=>String(board.partido_torneo_id)===String(row.id)).map(board=>pick(board,['id','estado']))})),
   canchas:courts.rows,alineaciones:lineups.rows,capabilities:{schedule:true,lineup:true,scoreboard:true,control:true}});
 }));
 const supported=(method,path)=>method==='put'&&path==='/api/torneos/:id/nations-cup/programacion'||method==='post'&&path==='/api/torneos/:id/nations-cup/partidos/:partidoId/marcador'
  ||method==='get'&&['/api/torneos/:id/selecciones','/api/torneos/:id/selecciones/:equipoId','/api/torneos/:id/partidos/:partidoId/equipos/:equipoId/alineacion'].includes(path)
  ||method==='put'&&path==='/api/torneos/:id/partidos/:partidoId/equipos/:equipoId/alineacion';
 const fixedAdapter=Object.fromEntries(['get','post','put'].map(method=>[method,(path,handler)=>{if(supported(method,path))router[method](path.replace('/api/torneos','/torneos'),guarded(handler));} ]));
 const authorizeEvent=(actor,event)=>canOperateNationsEvent(pool,actor,event);
 mountNationsCupRoutes(fixedAdapter,{db,getAuthenticatedUser,getRole,authorizeEvent,awardsPool:pool});
 mountNationalTeamRoutes(fixedAdapter,{db,getAuthenticatedUser,getRole,authorizeEvent});
 async function board(req,q=pool,{lock=false}={}){
  const id=Number(req.params.partidoId);if(!Number.isSafeInteger(id)||id<=0)throw operatorError('NATIONS_OPERATOR_MATCH_INVALID',400);
  const r=await q.query(`SELECT s.id,s.partido_torneo_id,s.torneo_id,s.sede_id,s.estado FROM public.scoreboard_partidos s JOIN public.partidos p ON p.id=s.partido_torneo_id JOIN public.torneos t ON t.id=p.torneo_id
   WHERE p.id=$1 AND p.torneo_id=57 AND s.torneo_id=57 AND s.sede_id=t.sede_id AND lower(coalesce(s.estado,'')) NOT IN('cancelado','cancelada') ORDER BY s.updated_at DESC ${lock?'FOR UPDATE OF s':''}`,[id]);
  if(r.rows.length!==1)throw operatorError('NATIONS_OPERATOR_BOARD_UNCONFIRMED',409);return r.rows[0];
 }
 router.post('/torneos/:id/partidos/:partidoId/control-token',guarded(run(async(req,res)=>{
  const actor=await user(req),current=await board(req);const issued=await issueNationsControlToken({pool,scoreboardId:current.id,issuerId:actor.id});
  if(!issued)throw operatorError('NATIONS_OPERATOR_BOARD_UNCONFIRMED',409);
  res.json({ok:true,torneo_id:57,partido_id:Number(req.params.partidoId),scoreboard_id:current.id,control_path:buildControlPath(issued.controlToken),control_token_created_at:issued.controlTokenCreatedAt});
 })));
 router.post('/torneos/:id/partidos/:partidoId/resultado',guarded(run(async(req,res)=>{
  const actor=await user(req);
  const result=await cargarResultadoManualPartidoTorneo(db,{torneoId:57,partidoId:req.params.partidoId,body:req.body??{},actorId:actor.id},{requireNationsScoreDetail:true});
  res.status(result.statusCode).json(result.body);
 })));
 router.post('/torneos/:id/partidos/:partidoId/revoke-control-token',guarded(run(async(req,res)=>{
  const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0))");const current=await board(req,c,{lock:true});await scope(req,{q:c,lock:true});
   await c.query('UPDATE public.scoreboard_partidos SET control_token_revoked_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1',[current.id]);await c.query('COMMIT');res.json({ok:true,scoreboard_id:current.id,revoked:true});
  }catch(e){await c.query('ROLLBACK').catch(()=>{});throw e;}finally{c.release();}
 })));
 app.use(ROOT,router);
 const admin=express.Router();admin.use(express.json({limit:'8kb'}));admin.use((_req,res,next)=>{res.set('Cache-Control','private, no-store');next();});
 admin.get('/',run(async(req,res)=>{const actor=await user(req);await assertOperatorGrantAdministrator(pool,actor.id);const result=await pool.query('SELECT g.id,g.torneo_id,g.expires_at,g.revoked_at,u.email FROM nations_operator.grants g JOIN auth.users u ON u.id=g.user_id WHERE g.torneo_id=57 ORDER BY g.created_at DESC');res.json({ok:true,grants:result.rows});}));
 admin.post('/',run(async(req,res)=>{const actor=await user(req);if(Object.keys(req.body||{}).some(key=>!['email','torneo_id','expires_at'].includes(key)))throw operatorError('NATIONS_OPERATOR_BODY_SCOPE',400);const grant=await grantNationsOperator({pool,actorId:actor.id,email:req.body?.email,torneoId:req.body?.torneo_id,expiresAt:req.body?.expires_at});res.status(201).json({ok:true,grant});}));
 admin.delete('/:grantId',run(async(req,res)=>{const actor=await user(req);res.json({ok:true,grant:await revokeNationsOperator({pool,actorId:actor.id,grantId:req.params.grantId})});}));
 app.use('/api/admin/nations/operator-grants',admin);
}
