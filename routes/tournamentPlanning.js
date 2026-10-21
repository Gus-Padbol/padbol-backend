import {buildScoreboardInsertRow} from '../src/scoreboard/scoreboardTorneoService.js';
import {validateNationalLineup,lineupPlayerId,assertNationalLineupsReady} from '../lib/nationalTeamLineup.js';
import {persistTournamentPlan} from '../lib/torneos/tournamentPlanningService.js';
import {ensureScoreboardForCompletedBracketPartido} from '../lib/torneos/bracketScoreboardService.js';
import {assertTournamentTeamsSportReady} from '../lib/tournamentParticipantsReadiness.js';
import {sendHttpError} from '../lib/httpErrors.js';
import {isScoreboardTorneoPartidoActivo} from '../src/scoreboard/scoreboardTorneoPartidoResolver.js';

const invalid=(message,status=409)=>Object.assign(new Error(message),{status});
async function read(query){const {data,error}=await query;if(error)throw error;return data;}
const rosterSnapshot=teams=>[...teams].sort((a,b)=>Number(a.id)-Number(b.id)).map(({id,jugadores,inscripcion_estado})=>({id,jugadores,inscripcion_estado}));
export async function startPlannedTournament(db,{torneo,equipos,actorId}) {
 await assertTournamentTeamsSportReady(db,{torneo,equipos});
 const {data,error}=await db.rpc('iniciar_torneo_planificado',{p_torneo_id:Number(torneo.id),p_actor_id:actorId,p_roster:rosterSnapshot(equipos)});
 if(error)throw invalid('No se pudo iniciar: comprueba equipos confirmados y fixture pendiente.',error.code==='42501'?403:409);
 if(data?.ok!==true||data.estado!=='en_curso'||Number(data.torneo_id)!==Number(torneo.id))throw invalid('No se pudo comprobar el inicio del torneo.',503);
 return data;
}
export function mountTournamentPlanningRoutes(app,{db,requireTorneoAdmin,ensureScoreboard=ensureScoreboardForCompletedBracketPartido}) {
 const load=async(req,res)=>{
  const auth=await requireTorneoAdmin(req,res,req.params.id);if(!auth)return null;
  const torneo=await read(db.from('torneos').select('*').eq('id',Number(req.params.id)).single());
  if(torneo.plan_nations)throw invalid('Usa la programación y el sorteo propios de Nations Cup.');
  const equipos=await read(db.from('equipos').select('*').eq('torneo_id',Number(torneo.id)).order('id'));
  return {auth,torneo,equipos};
 };
 const route=(method,path,fn)=>app[method](path,async(req,res,next)=>{try{const c=await load(req,res);if(c && path.endsWith('/generar-partidos') && !['knockout','round_robin'].includes(c.torneo.tipo_torneo))return next();if(c)await fn(req,res,c);}catch(e){sendHttpError(res,e);}});
 for(const path of ['/api/torneos/:id/generar-partidos','/api/torneos/:id/planificar-fixture'])route('post',path,async(req,res,{auth,torneo,equipos})=>{
  res.json(await persistTournamentPlan(db,{torneo,equipos,actorId:auth.user.id,origin:req.body?.origen??'automatico',pairings:req.body?.cruces}));
 });
 route('post','/api/torneos/:id/iniciar',async(req,res,{auth,torneo,equipos})=>res.json(await startPlannedTournament(db,{torneo,equipos,actorId:auth.user.id})));
 route('get','/api/torneos/:id/partidos/:partidoId/operacion',async(req,res,{torneo,equipos})=>{
  const partido=await read(db.from('partidos').select('*').eq('id',Number(req.params.partidoId)).eq('torneo_id',Number(torneo.id)).single());
  if(partido.fecha_hora&&!/(Z|[+-]\d\d:\d\d)$/.test(partido.fecha_hora))partido.fecha_hora+='Z';
  const canchas=await read(db.from('canchas').select('id,nombre,deporte,estado').eq('sede_id',torneo.sede_id));
  const schedule=await read(db.from('torneo_partidos_programacion').select('court_id,inicio,duration_minutes').eq('partido_id',partido.id).maybeSingle());
  const sede=await read(db.from('sedes').select('timezone').eq('id',torneo.sede_id).single());
  // Never create or reset a marker when returning to an ongoing match.
  const markers=await read(db.from('scoreboard_partidos').select('id,estado,torneo_id,sede_id').eq('partido_torneo_id',partido.id));
  if(!Array.isArray(markers))throw invalid('No se pudo consultar el marcador existente.',503);
  const active=markers.filter(marker=>isScoreboardTorneoPartidoActivo(marker.estado));
  if(active.length>1 || active.some(marker=>Number(marker.torneo_id)!==Number(torneo.id)||Number(marker.sede_id)!==Number(torneo.sede_id)||!marker.id))throw invalid('El marcador vinculado requiere revisión antes de abrirlo.',409);
  const scoreboardId=active[0]?.id??null;
  const matchTeams=equipos.filter(e=>[Number(partido.equipo_a_id),Number(partido.equipo_b_id)].includes(Number(e.id)));
  let ready=matchTeams.length===2,requirements=[];try{await assertTournamentTeamsSportReady(db,{torneo,equipos:matchTeams});if(ready && torneo.modalidad_plantel==='selecciones')await assertNationalLineupsReady(db,partido);}catch(e){ready=false;requirements=[e.message];}
  res.json({ok:true,partido,timezone:sede.timezone||'America/Argentina/Buenos_Aires',canchas:canchas.filter(c=>c.estado!=='inactiva'&&(c.deporte||'padbol')===(torneo.deporte||'padbol')),schedule,scoreboard_id:scoreboardId,equipos:matchTeams.map(e=>({id:e.id,nombre:e.nombre,jugadores:(e.jugadores||[]).map(p=>({nombre:p.nombre,apellido:p.apellido,participante_id:p.participante_id}))})),can_open:['en_curso','activo'].includes(torneo.estado)&&ready,requirements:ready?[]:requirements});
 });
 route('put','/api/torneos/:id/partidos/:partidoId/programacion',async(req,res,{auth,torneo})=>{
  const b=req.body??{};if(!Number.isSafeInteger(Number(b.court_id))||Number(b.court_id)<=0||!Number.isSafeInteger(Number(b.duration_minutes))||Number(b.duration_minutes)<1||Number(b.duration_minutes)>720||typeof b.fecha_hora!=='string'||!/(Z|[+-]\d\d:\d\d)$/.test(b.fecha_hora)||!Number.isFinite(Date.parse(b.fecha_hora)))throw invalid('Completa fecha con zona horaria, cancha y duración válida.',400);
  const {data,error}=await db.rpc('programar_partido_torneo',{p_torneo_id:Number(torneo.id),p_partido_id:Number(req.params.partidoId),p_actor_id:auth.user.id,p_court_id:Number(b.court_id),p_inicio:b.fecha_hora,p_duration:Number(b.duration_minutes)});
  if(error)throw invalid('No se pudo programar: comprueba fecha, cancha disponible y partido pendiente.',error.code==='42501'?403:409);
  if(data?.ok!==true||Number(data.partido_id)!==Number(req.params.partidoId))throw invalid('Programación no confirmada.',503);
  res.json(data);
 });
 route('post','/api/torneos/:id/partidos/:partidoId/marcador',async(req,res,{auth,torneo,equipos})=>{
  if(!['en_curso','activo'].includes(torneo.estado))throw invalid('Primero revisa el fixture e inicia explícitamente el torneo.');
  const match=await read(db.from('partidos').select('*').eq('id',Number(req.params.partidoId)).eq('torneo_id',Number(torneo.id)).single());
  if(match.equipo_a_id==null||match.equipo_b_id==null)throw invalid('Faltan ganadores de los cruces anteriores.');
  const matchTeams=equipos.filter(e=>[Number(match.equipo_a_id),Number(match.equipo_b_id)].includes(Number(e.id)));
  if(matchTeams.length!==2)throw invalid('Los equipos del cruce no pertenecen al torneo o están incompletos.');
  await assertTournamentTeamsSportReady(db,{torneo,equipos:matchTeams});
  const courtId=Number(req.body?.court_id??match.cancha_id);
  if(!Number.isSafeInteger(courtId)||courtId<=0)throw invalid('Elige una cancha habilitada para abrir el marcador.',400);
  // Court allocation is independent of estimated schedule; SQL locks and checks the live court.
  const {data:allocation,error:allocationError}=await db.rpc('preparar_marcador_torneo_ahora',{p_torneo_id:Number(torneo.id),p_partido_id:Number(match.id),p_actor_id:auth.user.id,p_court_id:courtId});
  if(allocationError)throw invalid('No se pudo habilitar el marcador: comprueba permisos, cancha/pantalla ocupada y participantes.',allocationError.code==='42501'?403:409);
  if(allocation?.ok!==true||Number(allocation.partido_id)!==Number(match.id))throw invalid('No se confirmó la cancha del marcador.',503);
  let markerDeps={};
  if(torneo.modalidad_plantel==='selecciones') {
   const lineups=await read(db.from('torneo_partido_alineaciones').select('equipo_id,iniciales,suplentes').eq('partido_id',match.id));
   markerDeps={buildScoreboardInsertRow:params=>{
    const declared=team=>{const row=lineups.find(l=>Number(l.equipo_id)===Number(team.id));const valid=validateNationalLineup(row,team,{allowGeneric:true});const ids=new Set([...valid.iniciales,...valid.suplentes]);return {...team,jugadores:team.jugadores.filter(p=>ids.has(lineupPlayerId(p)))};};
    return buildScoreboardInsertRow({...params,equipoA:declared(params.equipoA),equipoB:declared(params.equipoB)});
   }};
  }
  const result=await ensureScoreboard(db,{partidoId:match.id},markerDeps);
  if(!result.scoreboard_id)throw invalid('No se pudo abrir el marcador vinculado. Comprueba equipos, integrantes y estado del cruce.');
  res.json({ok:true,partido_id:match.id,scoreboard_id:result.scoreboard_id});
 });
}
