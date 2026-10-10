const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export function nationalError(message, status=400, code='NATIONAL_TEAM_INVALID') { return Object.assign(new Error(message),{status,code}); }
export function isNationalRoster(torneo) { return torneo?.modalidad_plantel === 'selecciones'; }
export function validateRosterMode(body={}) {
 const mode=body.modalidad_plantel ?? 'dobles';
 if(!['dobles','selecciones'].includes(mode)) throw nationalError('Modalidad de plantel inválida.');
 if(mode==='selecciones' && (String(body.deporte??'padbol').toLowerCase()!=='padbol' || body.formato_equipo==='singles')) throw nationalError('Las selecciones requieren Padbol en dobles.');
 return mode;
}
export function playerId(player) { return String(player?.user_id ?? player?.id ?? '').toLowerCase(); }
export function rosterPlayers(team) {
 const rows=Array.isArray(team?.jugadores)?team.jugadores:[];
 return rows.map(p=>({user_id:playerId(p),nombre:String(p.nombre??'').trim(),estado:p.estado??'confirmado'})).filter(p=>UUID.test(p.user_id));
}
export function validateNationalRoster(ids,{minimum=1}={}) {
 if(!Array.isArray(ids)||ids.length<minimum||ids.length>8||ids.some(v=>typeof v!=='string'||!UUID.test(v))) throw nationalError(`El plantel debe tener entre ${minimum} y 8 jugadores registrados.`);
 const normalized=ids.map(v=>v.toLowerCase());if(new Set(normalized).size!==ids.length) throw nationalError('No se puede repetir un jugador.');return normalized;
}
export function validateNationalLineup(body, team) {
 if(!Array.isArray(body?.iniciales)||body.iniciales.length!==2||!Array.isArray(body?.suplentes)||body.suplentes.length!==2) throw nationalError('Presenta exactamente 2 iniciales y 2 suplentes.');
 const ids=validateNationalRoster([...body.iniciales,...body.suplentes],{minimum:4});
 const roster=rosterPlayers(team);if(!Array.isArray(team?.jugadores)||roster.length!==team.jugadores.length||roster.length<4||roster.length>8||new Set(roster.map(p=>p.user_id)).size!==roster.length) throw nationalError('El plantel registrado no es válido para una selección.',409);
 const members=new Set(roster.filter(p=>['confirmado','aceptado'].includes(p.estado)).map(p=>p.user_id));
 if(ids.some(id=>!members.has(id))) throw nationalError('Los cuatro convocados deben pertenecer al plantel confirmado.');
 return {iniciales:ids.slice(0,2),suplentes:ids.slice(2)};
}
export function validateRevision(value) { if(!Number.isSafeInteger(value)||value<0) throw nationalError('Actualiza la alineación antes de guardar.');return value; }
export function canAlternateAfterGame(game) { return Number.isSafeInteger(game)&&game>0&&game%2===1; }
export function lineupDto(row) { return row ? {iniciales:row.iniciales,suplentes:row.suplentes,revision:Number(row.revision)} : null; }
export async function assertNationalLineupsReady(db, match) {
 const {data:torneo,error}=await db.from('torneos').select('modalidad_plantel').eq('id',match.torneo_id).maybeSingle();
 if(error)throw error;if(!isNationalRoster(torneo))return;
 const {data:teams,error:teamError}=await db.from('equipos').select('id,jugadores').in('id',[match.equipo_a_id,match.equipo_b_id]);if(teamError)throw teamError;
 const {data:rows,error:lineupError}=await db.from('torneo_partido_alineaciones').select('equipo_id,iniciales,suplentes').eq('partido_id',match.id);if(lineupError)throw lineupError;
 for(const id of [match.equipo_a_id,match.equipo_b_id]) {const team=teams?.find(t=>Number(t.id)===Number(id));const row=rows?.find(r=>Number(r.equipo_id)===Number(id));if(!team||!row)throw nationalError('Guarda y confirma los cuatro convocados de ambos equipos antes del partido.',409,'NATIONAL_LINEUPS_REQUIRED');validateNationalLineup(row,team);}
}

/** Internal ranking keeps its existing team formula; only declared participants qualify. */
export function rankingPlayersForTeam(team) {
 const players=Array.isArray(team?.jugadores)?team.jugadores:[];
 if(!isNationalRoster(team))return players;
 if(!Array.isArray(team.participantes_ranking))return [];
 const declared=new Set(team.participantes_ranking.map(v=>String(v).toLowerCase()));
 return players.filter(p=>declared.has(playerId(p)));
}
export function rankingPlayerKey(team,player) {const uid=playerId(player);return UUID.test(uid)?uid:player.email||player.nombre;}
export async function closeNationalTournament(db,{torneo,equipos,puntosData,actorId}) {
 const {data,error}=await db.rpc('finalizar_torneo_seleccion',{p_torneo_id:Number(torneo.id),p_actor_id:actorId,p_puntos:puntosData});
 if(error)throw nationalError('No se pudo confirmar el cierre y sus convocados. Actualiza y reintenta.', ['22023','40001'].includes(error.code)?409:503,'NATIONAL_CLOSURE_UNCONFIRMED');
 if(data?.ok!==true||Number(data.torneo_id)!==Number(torneo.id)||!['finalized','idempotent'].includes(data.status)||!Array.isArray(data.equipos)||data.equipos.length!==equipos.length||!data.torneo)throw nationalError('Cierre sin confirmación.',503,'NATIONAL_CLOSURE_UNCONFIRMED');
 for(const team of data.equipos){const original=equipos.find(e=>Number(e.id)===Number(team.id));if(!original||!Array.isArray(team.participantes_ranking)||team.participantes_ranking.some(id=>!rosterPlayers(original).some(p=>p.user_id===String(id))))throw nationalError('Participación sin confirmación.',503,'NATIONAL_CLOSURE_UNCONFIRMED');}
 return data;
}
