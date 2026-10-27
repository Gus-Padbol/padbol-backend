import {DateTime} from 'luxon';
import {resolveTorneoAdminAccess} from './torneoAdminAccessService.js';
export function nationsRevealInstant(torneo){const config=torneo?.plan_nations?.config;if(!config)return null;if(config.reveal_at){const d=DateTime.fromISO(config.reveal_at,{setZone:true});return d.isValid?d.toMillis():null;}const hours=torneo.horas_revelar_equipos==null?48:Number(torneo.horas_revelar_equipos);if(!Number.isFinite(hours)||hours<0||!config.timezone)return null;const start=DateTime.fromISO(String(torneo.fecha_inicio??''),{zone:config.timezone}).set({hour:12});return start.isValid?start.minus({hours}).toMillis():null;}
export function isNationsPublicRevealed(torneo,now=Date.now()){if(!torneo?.plan_nations)return true;const at=nationsRevealInstant(torneo);return at!=null&&Number(now)>=at;}
export async function resolveNationsReadAudience(req,{db,getAuthenticatedUser,getRole},torneo){const auth=await getAuthenticatedUser(req);const role=auth.user?await getRole(auth.user):null;const admin=Boolean(auth.user&&resolveTorneoAdminAccess({user:auth.user,role},torneo.sede_id).allowed);const {data:teams,error}=await db.from('equipos').select('id,creador_id,jugadores').eq('torneo_id',torneo.id);if(error)throw error;const captainIds=auth.user?(teams??[]).filter(t=>t.creador_id===auth.user.id).map(t=>Number(t.id)):[];const memberIds=auth.user?(teams??[]).filter(t=>Array.isArray(t.jugadores)&&t.jugadores.some(p=>(p.user_id??p.id)===auth.user.id)).map(t=>Number(t.id)):[];return {user:auth.user,admin,captainIds,memberIds,revealed:isNationsPublicRevealed(torneo)};}

export async function assertNationsScoreboardAudience(req,row,{db,getAuthenticatedUser,getRole}) {
    if(!row?.partido_torneo_id)return true;
    const match=await db.from('partidos').select('id,torneo_id,equipo_a_id,equipo_b_id').eq('id',row.partido_torneo_id).maybeSingle();
    if(match.error)throw match.error;if(!match.data)return true;
    const event=await db.from('torneos').select('id,sede_id,plan_nations,fecha_inicio,horas_revelar_equipos').eq('id',match.data.torneo_id).maybeSingle();
    if(event.error)throw event.error;if(!event.data?.plan_nations)return true;
    const audience=await resolveNationsReadAudience(req,{db,getAuthenticatedUser,getRole},event.data);
    if(audience.admin||audience.revealed||[...audience.captainIds,...audience.memberIds].some(id=>[Number(match.data.equipo_a_id),Number(match.data.equipo_b_id)].includes(id)))return true;
    throw Object.assign(new Error('El sorteo todavía no está publicado.'),{status:403,code:'NATIONS_REVEAL_PENDING'});
  }

export function sanitizeNationsScoreboardPlayers(row) {
 const out={...row};for(const key of Object.keys(out))if(key.startsWith('control_token'))delete out[key];
 for(const side of ['equipo_a_jugadores','equipo_b_jugadores'])out[side]=Array.isArray(row[side])?row[side].map(p=>Object.fromEntries(['nombre','apellido','jersey','numero'].filter(k=>p[k]!=null).map(k=>[k,p[k]]))):[];
 return out;
}
export async function safeNationsScoreboardProjection(db,row) {
 if(!row?.partido_torneo_id)return row;
 const match=await db.from('partidos').select('torneo_id').eq('id',row.partido_torneo_id).maybeSingle();if(match.error)throw match.error;if(!match.data)return row;
 const event=await db.from('torneos').select('plan_nations').eq('id',match.data.torneo_id).maybeSingle();if(event.error)throw event.error;
 return event.data?.plan_nations?sanitizeNationsScoreboardPlayers(row):row;
}

export function projectNationsMatch(m) {
 const out=Object.fromEntries(['id','torneo_id','equipo_a_id','equipo_b_id','grupo','bracket_round','bracket_position','estado','fecha_hora','cancha','cancha_id','ganador_equipo_id','partido_siguiente_id','partido_siguiente_slot'].map(k=>[k,m[k]??null]));
 for(const side of ['equipo_a','equipo_b'])out[side]=m[side]?{id:m[side].id,nombre:m[side].nombre}:null;
 out.resultado=m.resultado?{goles_a:m.resultado.goles_a,goles_b:m.resultado.goles_b,historial_sets:Array.isArray(m.resultado.historial_sets)?m.resultado.historial_sets.map(s=>({a:s.a,b:s.b})):null}:null;
 return out;
}

export function rejectLegacyNationsStandings(res,context) {
 if(!context?.event?.plan_nations)return false;
 res.status(409).json({ok:false,code:'NATIONS_AUTHORITATIVE_STATE_REQUIRED',error:'Consulta la clasificación aprobada en Nations Cup.',endpoint:`/api/torneos/${Number(context.event.id)}/nations-cup${context.audience?.admin?'':'/publico'}`});
 return true;
}

export function rejectConfiguredNationsDeletion(res,event) {
 if(!event?.plan_nations)return false;
 res.status(409).json({ok:false,code:'NATIONS_EVENT_DELETE_NOT_SUPPORTED',error:'Este evento conserva su plan e historial. Usa la cancelación para dejarlo sin efecto, sin borrar sus registros.'});
 return true;
}
