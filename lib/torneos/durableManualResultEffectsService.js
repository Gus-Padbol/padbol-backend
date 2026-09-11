import { buildScoreboardInsertRow } from '../../src/scoreboard/scoreboardTorneoService.js';
const SOURCE_SELECT='id,torneo_id,sede_id,estado,resultado,equipo_a_id,equipo_b_id,ganador_equipo_id,grupo,partido_siguiente_id,partido_siguiente_slot';
const TARGET_SELECT='id,torneo_id,sede_id,cancha,estado,equipo_a_id,equipo_b_id';
const id=value=>Number.isSafeInteger(Number(value))&&Number(value)>0?Number(value):null;
const fail=(code)=>Object.assign(new Error('No se pudieron confirmar los efectos del resultado.'),{code});
async function one(db,table,columns,key,value){const {data,error}=await db.from(table).select(columns).eq(key,value).maybeSingle();if(error||!data)throw fail(error?.code||'P0002');return data;}
async function prepare(db,{partidoId,torneoId,actorId,resultado,revision}){
 const source=await one(db,'partidos',SOURCE_SELECT,'id',partidoId);
 if(Number(source.torneo_id)!==Number(torneoId))throw fail('P0002');
 const args={p_partido_id:Number(partidoId),p_torneo_id:Number(torneoId),p_actor_id:actorId,
   p_expected_resultado:resultado,p_expected_revision:revision,p_destino_hint:source.partido_siguiente_id??null,
   p_expected_context:null,p_scoreboard_template:null};
 if(String(source.grupo??'').trim() || source.partido_siguiente_id==null)return args;
 const target=await one(db,'partidos',TARGET_SELECT,'id',source.partido_siguiente_id);
 const slot=String(source.partido_siguiente_slot??'').trim().toUpperCase();
 if(!['A','B'].includes(slot)||!id(source.ganador_equipo_id))throw fail('22023');
 const column=slot==='A'?'equipo_a_id':'equipo_b_id';
 const proposed={...target,[column]:source.ganador_equipo_id};
 args.p_expected_context={destination:{id:target.id,torneo_id:target.torneo_id,sede_id:target.sede_id,
   cancha:target.cancha??null,equipo_a_id:proposed.equipo_a_id??null,equipo_b_id:proposed.equipo_b_id??null}};
 if(proposed.equipo_a_id==null||proposed.equipo_b_id==null)return args;
 const tournament=await one(db,'torneos','id,nombre,sede_id','id',torneoId);
 const {data:teams,error}=await db.from('equipos').select('id,nombre,jugadores').in('id',[proposed.equipo_a_id,proposed.equipo_b_id]);
 if(error)throw fail(error.code||'XX000');
 const teamA=teams?.find(t=>Number(t.id)===Number(proposed.equipo_a_id));
 const teamB=teams?.find(t=>Number(t.id)===Number(proposed.equipo_b_id));
 if(!teamA||!teamB)throw fail('P0002');
 args.p_expected_context={...args.p_expected_context,tournament,team_a:teamA,team_b:teamB};
 args.p_scoreboard_template=buildScoreboardInsertRow({partido:proposed,torneo:tournament,equipoA:teamA,equipoB:teamB,cancha:target.cancha??null});
 return args;
}
/** Database transaction owns both slot advancement and active-scoreboard uniqueness.
 * The template uses the existing production builder; SQL rechecks its persisted inputs under locks.
 * No token rotation, external action or in-memory lock is used. */
export async function applyDurableManualResultEffects(db,params){
 if(!id(params?.partidoId)||!id(params?.torneoId)||typeof params.actorId!=='string'
   ||!Number.isSafeInteger(params.revision)||params.revision<1)throw fail('22023');
 for(let attempt=0;attempt<2;attempt++){
  let reply;
  try{reply=await db.rpc('aplicar_efectos_resultado_manual_durable',await prepare(db,params));}
  catch(error){if(attempt===0&&['40001','40P01'].includes(error?.code))continue;throw fail(error?.code||'XX000');}
  if(reply?.error){if(attempt===0&&['40001','40P01'].includes(reply.error.code))continue;throw fail(reply.error.code);}
  const data=reply?.data;
  if(data?.ok!==true||Number(data.partido_id)!==Number(params.partidoId)||Number(data.torneo_id)!==Number(params.torneoId)
     ||!['advanced','skipped'].includes(data.advance?.status))throw fail('DURABLE_EFFECTS_UNCONFIRMED');
  const fields=['status','reason','partido_id','destino_partido_id','slot','ganador_equipo_id','scoreboard_id'];
  const dto=effect=>effect==null?null:Object.fromEntries(fields.filter(k=>Object.hasOwn(effect,k)).map(k=>[k,effect[k]]));
  return {ok:true,partido_id:Number(params.partidoId),torneo_id:Number(params.torneoId),fuente:'manual_admin',
    advance:dto(data.advance),scoreboard:dto(data.scoreboard)};
 }
 throw fail('40001');
}
