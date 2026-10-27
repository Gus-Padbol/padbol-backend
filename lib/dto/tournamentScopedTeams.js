import {mapEquipoTorneoPublicRow} from './legacyPublic.js';
import {resolveTorneoAdminAccess} from '../torneos/torneoAdminAccessService.js';
/** Enrollment metadata is an administration capability, never a public/team-owner claim. */
export function mayReadTournamentEnrollment(auth,torneo){
 return Boolean(auth?.user&&resolveTorneoAdminAccess(auth,torneo?.sede_id).allowed);
}
export function mapTournamentTeamReadRow(row,{grupo=null,posicion=null,admin=false}={}){
 const dto=mapEquipoTorneoPublicRow(row,grupo,posicion);
 if(!dto||!admin)return dto;
 const jugadores=Array.isArray(row.jugadores)?row.jugadores.map(p=>({
  id:p.participante_id?(p.user_id??null):(p.user_id??p.id??null),user_id:p.participante_id?(p.user_id??null):(p.user_id??p.id??null),participante_id:p.participante_id??null,
  nombre:p.nombre??'',...(p.alias?{alias:p.alias}:{}),...(p.apellido?{apellido:p.apellido}:{}),...(p.foto_url?{foto_url:p.foto_url}:{}),...(p.avatar_url?{avatar_url:p.avatar_url}:{}),...(p.pais?{pais:p.pais}:{}),...(p.nacionalidad?{nacionalidad:p.nacionalidad}:{}),estado:p.estado??'confirmado',tipo_identidad:['cuenta','generico','plaza_pendiente'].includes(p.tipo_identidad)?p.tipo_identidad:null,
 })):[];
 return {...dto,inscripcion_estado:row.inscripcion_estado??null,modalidad_plantel:row.modalidad_plantel??'dobles',jugadores};
}
