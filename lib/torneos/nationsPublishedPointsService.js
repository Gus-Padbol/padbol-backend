import { rankingTournamentEligible } from './rankingTournamentEligibility.js';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const error=(message,code='NATIONAL_POINTS_DATA_INVALID',status=503)=>Object.assign(new Error(message),{code,status});
const positiveId=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const cleanText=value=>typeof value==='string'&&value.trim()?value.trim():null;
function optionsChecked({userId=null,now=new Date(),isRevealed}={}) {
 if(typeof isRevealed!=='function') throw error('Falta comprobar la fecha de publicación de los resultados.');
 if(userId!==null&&(!UUID.test(userId)||typeof userId!=='string')) throw error('Identidad de jugador inválida.','INVALID_PLAYER_ID',400);
 if(!(now instanceof Date)||!Number.isFinite(now.getTime())) throw error('Fecha de consulta inválida.');
 return {userId:userId?.toLowerCase()??null,now,isRevealed};
}

/** Public projection: eligibility is the recorded union of call-ups, never the whole roster. */
export function buildPublishedNationalPoints({torneos=[],equipos=[],puntos=[]}={},options={}) {
 const {userId,now,isRevealed}=optionsChecked(options);
 const visible=torneos.filter(t=>rankingTournamentEligible(t)&&t.deporte==='padbol'&&t.modalidad_plantel==='selecciones'&&t.estado==='finalizado'&&(!t.plan_nations||isRevealed(t,now)===true));
 if(visible.some(t=>!positiveId(t.id)))throw error('Un torneo publicado tiene una identidad inválida.');
 const events=new Map(visible.map(t=>[positiveId(t.id),t]));
 const teams=new Map(equipos.map(e=>[positiveId(e.id),e])),seenPoints=new Set(),seenPlayers=new Set(),items=[];
 for(const p of puntos) {
  const torneoId=positiveId(p.torneo_id),equipoId=positiveId(p.equipo_id),t=events.get(torneoId);
  if(!t)continue;
  const e=teams.get(equipoId);
  if(!e||Number(e.torneo_id)!==torneoId||e.modalidad_plantel!=='selecciones') throw error('No se pudo comprobar el equipo de los puntos publicados.');
  const key=`${torneoId}:${equipoId}`;
  if(seenPoints.has(key)||!Number.isSafeInteger(p.puntos)||p.puntos<0||p.puntos>2147483647||!Number.isSafeInteger(p.posicion)||p.posicion<1)throw error('Los puntos publicados tienen una clasificación incoherente.');
  seenPoints.add(key);
  if(!Array.isArray(e.jugadores)||!Array.isArray(e.participantes_ranking)) {
   if(!t.plan_nations)continue; // Existing selections without a verified participation union are never inferred from the roster.
   throw error('No se pudo comprobar la participación registrada.');
  }
  if(e.participantes_ranking.some(id=>typeof id!=='string'||!UUID.test(id)))throw error('Hay una identidad inválida en la participación registrada.');
  const declared=new Set(e.participantes_ranking.map(id=>id.toLowerCase()));
  if(declared.size<4||declared.size>8) {
   if(!t.plan_nations)continue;
   throw error('La participación registrada debe identificar entre cuatro y ocho jugadores.');
  }
  const matched=new Set();
  for(const player of e.jugadores) {
   const id=player?.user_id??player?.id;
   if(typeof id!=='string'||!UUID.test(id)||!declared.has(id.toLowerCase()))continue;
   const uid=id.toLowerCase();
   if(matched.has(uid))throw error('La misma identidad está repetida en el plantel.');
   matched.add(uid);
   const playerKey=`${torneoId}:${uid}`;
   if(seenPlayers.has(playerKey))throw error('La misma identidad tiene puntos en dos equipos del evento.');
   seenPlayers.add(playerKey);
   if(userId&&uid!==userId)continue;
   const name=[cleanText(player.nombre),cleanText(player.apellido)].filter(Boolean).join(' ')||cleanText(player.name)||'Jugador registrado';
   items.push({torneo_id:torneoId,equipo_id:equipoId,user_id:uid,nombre:name,pais:cleanText(player.pais),equipo_nombre:cleanText(e.nombre),torneo_nombre:cleanText(t.nombre),posicion:p.posicion,puntos:p.puntos,fecha:t.fecha_fin??null,nivel:t.nivel_torneo??null,ranking_origen:'padbol_match_interno',ranking_oficial:false});
  }
  if([...declared].some(id=>!matched.has(id)))throw error('La participación registrada no coincide con el plantel.');
 }
 return items.sort((a,b)=>a.torneo_id-b.torneo_id||a.posicion-b.posicion||a.user_id.localeCompare(b.user_id));
}

/** Service-role reads stay internal. Only the strictly whitelisted projection is returned. */
export async function loadPublishedNationalPoints(db,options={}) {
 const checked=optionsChecked(options);
 const {data:torneos,error:e1}=await db.from('torneos').select('id,nombre,estado,deporte,modalidad_plantel,plan_nations,fecha_inicio,fecha_fin,horas_revelar_equipos,nivel_torneo,sede_id,es_prueba').eq('estado','finalizado').eq('deporte','padbol').eq('modalidad_plantel','selecciones');
 if(e1||!Array.isArray(torneos))throw error('No se pudieron comprobar los torneos publicados.');
 const visible=torneos.filter(t=>rankingTournamentEligible(t)&&(!t.plan_nations||checked.isRevealed(t,checked.now)===true));
 if(!visible.length)return [];
 const ids=visible.map(t=>positiveId(t.id));
 if(ids.some(id=>!id))throw error('Un torneo publicado tiene una identidad inválida.');
 const results=await Promise.all([
  db.from('tabla_puntos').select('torneo_id,equipo_id,posicion,puntos').in('torneo_id',ids),
  db.from('equipos').select('id,torneo_id,nombre,jugadores,modalidad_plantel,participantes_ranking').in('torneo_id',ids),
 ]);
 if(results.some(r=>r.error||!Array.isArray(r.data)))throw error('No se pudieron comprobar los puntos y participantes publicados.');
 return buildPublishedNationalPoints({torneos:visible,puntos:results[0].data,equipos:results[1].data},checked);
}
