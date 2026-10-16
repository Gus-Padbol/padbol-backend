import {buildKnockoutBracketMatches,assertKnockoutBracketTeamCount} from './knockoutBracketService.js';

const fail = message => {throw Object.assign(new Error(message),{status:409,code:'TOURNAMENT_PLAN_INVALID'});};
export function buildTournamentFixturePlan(torneo,equipos,{origin='automatico',pairings}={}) {
 if(torneo.plan_nations)fail('Nations Cup conserva su propio sorteo y reglas.');
 if(!['abierto','inscripcion','inscripcion_abierta','proximo','planificacion'].includes(torneo.estado))fail('Sólo se puede planificar antes de iniciar el torneo.');
 if(!['knockout','round_robin'].includes(torneo.tipo_torneo))fail('Este planificador admite eliminación directa o todos contra todos.');
 if(!Array.isArray(equipos)||equipos.length<2)fail('Confirma al menos dos equipos antes de planificar.');
 if(equipos.some(e=>e.inscripcion_estado!=='confirmada'))fail('Todos los equipos deben estar confirmados antes del fixture.');
 if(!['automatico','manual'].includes(origin))fail('Origen de fixture inválido.');
 if(torneo.tipo_torneo==='round_robin') {
  if(origin==='manual')fail('La carga de cruces externos corresponde a eliminación directa. En todos contra todos se programan todos los enfrentamientos.');
  return equipos.flatMap((a,i)=>equipos.slice(i+1).map(b=>({torneo_id:Number(torneo.id),sede_id:torneo.sede_id,equipo_a_id:Number(a.id),equipo_b_id:Number(b.id),estado:'pendiente',ronda:1,grupo:null})));
 }
 assertKnockoutBracketTeamCount(equipos.length);
 let ordered=equipos;
 if(origin==='manual') {
  if(!Array.isArray(pairings)||pairings.length!==equipos.length/2)fail('Carga todos los cruces iniciales.');
  const ids=pairings.flatMap(p=>[Number(p.equipo_a_id),Number(p.equipo_b_id)]);
  if(ids.some(id=>!Number.isSafeInteger(id)||!equipos.some(e=>Number(e.id)===id))||new Set(ids).size!==equipos.length)fail('Cada equipo debe aparecer exactamente una vez: sin omisiones, duplicados ni enfrentamientos consigo mismo.');
  ordered=ids.map(id=>equipos.find(e=>Number(e.id)===id));
 }
 return buildKnockoutBracketMatches({equipos:ordered,torneoId:torneo.id,sedeId:torneo.sede_id,shuffle:origin==='automatico'});
}

export async function persistTournamentPlan(db,{torneo,equipos,actorId,origin='automatico',pairings}) {
 const matches=buildTournamentFixturePlan(torneo,equipos,{origin,pairings});
 const {data,error}=await db.rpc('planificar_fixture_torneo',{p_torneo_id:Number(torneo.id),p_actor_id:actorId,p_equipo_ids:equipos.map(e=>Number(e.id)),p_origen:origin,p_partidos:matches});
 if(error)throw Object.assign(new Error('No se pudo guardar el plan. Comprueba equipos, permisos y que aún no exista un fixture.'),{status:['40001','23505','55000','22023'].includes(error.code)?409:error.code==='42501'?403:503,code:'TOURNAMENT_PLAN_UNCONFIRMED'});
 if(data?.ok!==true||Number(data.torneo_id)!==Number(torneo.id)||!Array.isArray(data.partidos)||data.partidos.length!==matches.length)throw Object.assign(new Error('No se pudo comprobar el fixture guardado.'),{status:503});
 return data;
}
