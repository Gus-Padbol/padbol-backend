import { DateTime } from 'luxon';
import { createHash } from 'node:crypto';
import { buildKnockoutBracketMatches } from './knockoutBracketService.js';
export const NATIONS_CRITERIA=['puntos','diferencia_sets','sets_favor','diferencia_games','games_favor'];
export const nationsError=(message,code='NATIONS_INVALID_INPUT',status=400,details={})=>Object.assign(new Error(message),{code,status,...details});
const id=v=>Number.isSafeInteger(Number(v))&&Number(v)>0?Number(v):null;
export function canonicalJson(value){if(Array.isArray(value))return `[${value.map(canonicalJson).join(',')}]`;if(value&&typeof value==='object')return `{${Object.keys(value).sort().map(k=>`${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;return JSON.stringify(value);}
export const digest=value=>createHash('sha256').update(canonicalJson(value)).digest('hex');
export function validateNationsConfig(input,teams){
 if(input?.format!=='nations_3x5'||input?.rules?.placement_policy!=='group_seed')throw nationsError('Aprueba el formato 3 zonas de 5 y la política deportiva de posiciones.');
 try{new Intl.DateTimeFormat('en',{timeZone:input.timezone}).format();}catch{throw nationsError('Zona horaria IANA inválida.');}
 if(!input.timezone)throw nationsError('Selecciona la zona horaria del evento.');
 let reveal;if(input.reveal_at!=null&&input.reveal_at!==''){const parsed=DateTime.fromISO(String(input.reveal_at),{setZone:true});if(!parsed.isValid||!/(Z|[+-]\d{2}:\d{2})$/.test(input.reveal_at))throw nationsError('La revelación pública requiere fecha y hora válidas con zona.');reveal=parsed.toUTC().toISO();}
 const rest=input.rules.minimum_rest_minutes??0;if(!Number.isInteger(rest)||rest<0||rest>1440)throw nationsError('El descanso adicional debe ser de 0 a 1440 minutos.');
 const mapping=input.country_by_team;
 if(!mapping||typeof mapping!=='object'||Array.isArray(mapping)||Object.keys(mapping).length!==teams.length)throw nationsError('Asigna un país distinto a cada selección.');
 const countries=teams.map(t=>mapping[t.id]);
 const validCountries=new Set('AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW'.split(' '));
 if(countries.some(c=>!validCountries.has(c))||new Set(countries).size!==countries.length)throw nationsError('Usa códigos de país ISO de dos letras, sin repetirlos.');
 if(input.rules.standings&&canonicalJson(input.rules.standings)!==canonicalJson(['points','set_difference','sets_for','game_difference','games_for']))throw nationsError('Los criterios deben coincidir con el reglamento mostrado.');
 return {format:'nations_3x5',timezone:input.timezone,...(reveal?{reveal_at:reveal}:{}),rules:{standings:['points','set_difference','sets_for','game_difference','games_for'],placement_policy:'group_seed',minimum_rest_minutes:rest,residual_tie:'operator_approved_order'},country_by_team:Object.fromEntries(teams.map(t=>[t.id,mapping[t.id]]))};
}
export function validateDraw(groups,teams,torneoId,sedeId){
 const ready=teams.filter(t=>t.inscripcion_estado==='confirmado'&&Array.isArray(t.jugadores)&&t.jugadores.length>=4&&t.jugadores.length<=8);
 if(teams.length!==15||ready.length!==15)throw nationsError('Se requieren exactamente 15 selecciones confirmadas con 4 a 8 jugadores.', 'NATIONS_TEAMS_NOT_READY',409);
 if(!Array.isArray(groups)||groups.length!==3||groups.some(g=>!Array.isArray(g)||g.length!==5))throw nationsError('El sorteo requiere 3 zonas de 5 selecciones.');
 const flat=groups.flat().map(id);if(flat.some(x=>!x)||new Set(flat).size!==15||flat.some(x=>!teams.some(t=>Number(t.id)===x)))throw nationsError('Cada selección debe aparecer exactamente una vez.');
 const rows=[],labels=['A','B','C'];
 groups.forEach((g,index)=>{for(let a=0;a<5;a++)for(let b=a+1;b<5;b++)rows.push({torneo_id:Number(torneoId),sede_id:sedeId??null,equipo_a_id:Number(g[a]),equipo_b_id:Number(g[b]),grupo:labels[index],ronda:1,estado:'pendiente',bracket_round:null,bracket_position:null});});
 return {groups:groups.map((g,i)=>({label:labels[i],team_ids:g.map(Number)})),matches:rows};
}
// Game detail is compulsory for this opt-in format; missing games never become invented zeroes.
export function nationsScore(match){
 const r=match.resultado;if(!r||typeof r!=='object')throw nationsError('Falta el resultado detallado.', 'NATIONS_SCORE_INCOMPLETE',409);
 const raw=r.historial_sets??r.sets??[r.set1,r.set2,r.set3].filter(Boolean);
 if(!Array.isArray(raw)||![2,3].includes(raw.length))throw nationsError('Registra los games de cada set antes de clasificar.', 'NATIONS_SCORE_INCOMPLETE',409);
 const sets=raw.map(s=>{if(typeof s==='string'){const m=/^(\d+)\s*[-:]\s*(\d+)$/.exec(s.trim());return m?{a:Number(m[1]),b:Number(m[2])}:null;}return s&&{a:Number(s.a??s.games_a??s.gamesA??s.local),b:Number(s.b??s.games_b??s.gamesB??s.visitante)};});
 if(sets.some(s=>!s||!Number.isInteger(s.a)||!Number.isInteger(s.b)||s.a<0||s.b<0||s.a===s.b))throw nationsError('Hay sets incompletos o empatados.', 'NATIONS_SCORE_INCOMPLETE',409);
 const sa=sets.filter(s=>s.a>s.b).length,sb=sets.length-sa;
 if(Math.max(sa,sb)!==2||Math.min(sa,sb)>1||sets.slice(0,-1).filter(s=>s.a>s.b).length===2||sets.slice(0,-1).filter(s=>s.b>s.a).length===2)throw nationsError('El partido debe terminar 2–0 o 2–1, sin sets posteriores al cierre.');
 const winner=sa>sb?Number(match.equipo_a_id):Number(match.equipo_b_id);
 if(Number(match.ganador_equipo_id)!==winner||(r.goles_a!=null&&Number(r.goles_a)!==sa)||(r.goles_b!=null&&Number(r.goles_b)!==sb))throw nationsError('Los sets y el ganador no coinciden.', 'NATIONS_SCORE_INCOMPLETE',409);
 return {sa,sb,ga:sets.reduce((n,s)=>n+s.a,0),gb:sets.reduce((n,s)=>n+s.b,0),winner};
}
function sportCompare(a,b){for(const k of NATIONS_CRITERIA){const d=b[k]-a[k];if(d)return d;}return 0;}
function ordered(rows,scope,resolutions,ties){
 const sorted=[...rows].sort(sportCompare),out=[];
 for(let i=0;i<sorted.length;){let j=i+1;while(j<sorted.length&&sportCompare(sorted[i],sorted[j])===0)j++;
  const block=sorted.slice(i,j);if(block.length>1){const ids=block.map(r=>r.equipo_id),tieScope=`${scope}:${[...ids].sort((a,b)=>a-b).join('-')}`,resolution=resolutions.find(r=>r.scope===tieScope&&Array.isArray(r.team_ids)&&r.team_ids.length===ids.length&&ids.every(x=>r.team_ids.includes(x)));
   if(resolution){const order=resolution.ordered_team_ids;if(!Array.isArray(order)||order.length!==ids.length||new Set(order).size!==ids.length||order.some(x=>!ids.includes(x))||typeof resolution.reason!=='string'||resolution.reason.trim().length<10)throw nationsError('El desempate aprobado debe ordenar todos los equipos y explicar su motivo.');block.sort((a,b)=>order.indexOf(a.equipo_id)-order.indexOf(b.equipo_id));}
   else ties.push({scope:tieScope,team_ids:ids,criteria:[...NATIONS_CRITERIA]});
  }out.push(...block);i=j;
 }return out;
}
export function buildNationsClassification({groups,teams,matches,resolutions=[]}){
 if(!Array.isArray(groups)||groups.length!==3)throw nationsError('Confirma primero el sorteo.', 'NATIONS_DRAW_REQUIRED',409);
 const groupMatches=matches.filter(m=>m.grupo&&m.bracket_round==null);
 if(groupMatches.length!==30||groupMatches.some(m=>m.estado!=='finalizado'))throw nationsError('Finaliza los 30 partidos de las zonas.', 'NATIONS_GROUPS_INCOMPLETE',409);
 const ties=[],standings=[];
 for(const group of groups){const rows=group.team_ids.map(teamId=>({equipo_id:teamId,nombre:teams.find(t=>Number(t.id)===teamId)?.nombre??'',group:group.label,puntos:0,diferencia_sets:0,sets_favor:0,diferencia_games:0,games_favor:0,jugados:0})),map=new Map(rows.map(r=>[r.equipo_id,r])),pairs=new Set();
  const gm=groupMatches.filter(m=>m.grupo===group.label);if(gm.length!==10)throw nationsError('La zona no tiene sus diez partidos.', 'NATIONS_FIXTURE_INVALID',409);
  for(const m of gm){const a=map.get(Number(m.equipo_a_id)),b=map.get(Number(m.equipo_b_id)),pair=[Number(m.equipo_a_id),Number(m.equipo_b_id)].sort((x,y)=>x-y).join(':');if(!a||!b||a===b||pairs.has(pair))throw nationsError('Hay cruces duplicados o fuera de su zona.', 'NATIONS_FIXTURE_INVALID',409);pairs.add(pair);const s=nationsScore(m);
   for(const [r,sets,against,games,ga] of [[a,s.sa,s.sb,s.ga,s.gb],[b,s.sb,s.sa,s.gb,s.ga]]){r.jugados++;r.sets_favor+=sets;r.diferencia_sets+=sets-against;r.games_favor+=games;r.diferencia_games+=games-ga;if(r.equipo_id===s.winner)r.puntos+=3;}
  }standings.push({group:group.label,rows:ordered(rows,`group:${group.label}`,resolutions,ties).map((r,i)=>({...r,position:i+1}))});
 }
 // No use of unresolved group positions to decide qualifiers.
 if(ties.length)return {standings,thirds:[],qualified:[],ties};
 const thirds=ordered(standings.map(g=>g.rows[2]),'thirds',resolutions,ties);
 if(ties.length)return {standings,thirds,qualified:[],ties};
 const qualifiers=[...standings.flatMap(g=>g.rows.slice(0,2)),...thirds.slice(0,2)];
 // Group winners seed before runners-up, who seed before qualified thirds.
 const qualified=[1,2,3].flatMap(position=>ordered(qualifiers.filter(r=>r.position===position),`seeds:${position}`,resolutions,ties)).map((r,i)=>({...r,seed:i+1}));
 return {standings,thirds,qualified:ties.length?[]:qualified,ties};
}
export function buildNationsBracket(qualified,torneoId,sedeId){if(qualified.length!==8)throw nationsError('Se requieren ocho clasificados aprobados.');return buildKnockoutBracketMatches({equipos:[1,8,4,5,2,7,3,6].map(seed=>({id:qualified.find(r=>r.seed===seed).equipo_id})),torneoId,sedeId,shuffle:false});}
export function sourceSnapshot(matches){return matches.map(m=>({id:Number(m.id),equipo_a_id:m.equipo_a_id,equipo_b_id:m.equipo_b_id,grupo:m.grupo,bracket_round:m.bracket_round,bracket_position:m.bracket_position,estado:m.estado,resultado:m.resultado,ganador_equipo_id:m.ganador_equipo_id,partido_siguiente_id:m.partido_siguiente_id,partido_siguiente_slot:m.partido_siguiente_slot})).sort((a,b)=>a.id-b.id);}
export function buildNationsPlacements(plan,matches){
 if(matches.length!==37||matches.some(m=>m.estado!=='finalizado'))throw nationsError('Finaliza los 37 partidos antes del cierre.', 'NATIONS_MATCHES_INCOMPLETE',409);
 if(canonicalJson(plan.classification_source)!==canonicalJson(sourceSnapshot(matches.filter(m=>m.grupo&&m.bracket_round==null))))throw nationsError('Los resultados de las zonas no coinciden con la clasificación aprobada.','NATIONS_APPROVED_SOURCE_CHANGED',409);
 const q=plan.qualified;if(!Array.isArray(q)||q.length!==8)throw nationsError('La siembra no está aprobada.', 'NATIONS_FIXTURE_INVALID',409);
 const rounds=[1,2,3].map(round=>matches.filter(m=>Number(m.bracket_round)===round).sort((a,b)=>a.bracket_position-b.bracket_position));
 if(rounds[0].length!==4||rounds[1].length!==2||rounds[2].length!==1)throw nationsError('El cuadro no coincide con los siete cruces.', 'NATIONS_FIXTURE_INVALID',409);
 const expected=buildNationsBracket(q,matches[0].torneo_id,matches[0].sede_id).filter(m=>m.bracket_round===1);
 rounds[0].forEach((m,i)=>{if(Number(m.equipo_a_id)!==expected[i].equipo_a_id||Number(m.equipo_b_id)!==expected[i].equipo_b_id)throw nationsError('Los cuartos no coinciden con la siembra aprobada.');});
 for(let r=0;r<2;r++)rounds[r].forEach((m,i)=>{const next=rounds[r+1][Math.floor(i/2)],slot=i%2?'B':'A';if(Number(m.partido_siguiente_id)!==Number(next.id)||m.partido_siguiente_slot!==slot||Number(next[slot==='A'?'equipo_a_id':'equipo_b_id'])!==Number(m.ganador_equipo_id))throw nationsError('El avance del cuadro no coincide con los ganadores.');});
 const loser=m=>Number(m.ganador_equipo_id)===Number(m.equipo_a_id)?Number(m.equipo_b_id):Number(m.equipo_a_id),seed=id=>q.find(r=>r.equipo_id===id)?.seed;
 rounds.flat().forEach(nationsScore);
 const final=rounds[2][0],ranking=[Number(final.ganador_equipo_id),loser(final),...rounds[1].map(loser).sort((a,b)=>seed(a)-seed(b)),...rounds[0].map(loser).sort((a,b)=>seed(a)-seed(b))];
 const non=plan.standings.flatMap(g=>g.rows).filter(r=>!q.some(t=>t.equipo_id===r.equipo_id));
 const ties=[],rest=[3,4,5].flatMap(position=>ordered(non.filter(r=>r.position===position),`placements:${position}`,plan.tie_resolutions??[],ties));
 if(ties.length)throw nationsError('Aprueba los desempates pendientes de las posiciones finales.', 'NATIONS_TIE_APPROVAL_REQUIRED',409,{ties});
 return [...ranking,...rest.map(r=>r.equipo_id)].map((equipo_id,i)=>({equipo_id,posicion:i+1}));
}
export function validateSchedule(input,matches,timezone){
 if(!Array.isArray(input)||!input.length||input.length>37)throw nationsError('Selecciona los partidos que vas a programar.');
 const seen=new Set();return input.map(row=>{const mid=id(row.partido_id),match=matches.find(m=>Number(m.id)===mid);if(!mid||seen.has(mid)||!match||!['pendiente','programado'].includes(match.estado))throw nationsError('Partido repetido o ya iniciado.');seen.add(mid);
  const parsedDate=DateTime.fromISO(String(row.fecha_hora??''),{setZone:true}),date=parsedDate.toMillis(),court=id(row.court_id),minutes=row.duration_minutes;if(!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?(Z|[+-]\d{2}:\d{2})$/.test(row.fecha_hora??'')||!parsedDate.isValid||!Number.isFinite(date)||!court||!Number.isInteger(minutes)||minutes<1||minutes>720)throw nationsError('Completa la hora con zona y la duración prevista (1–720 minutos).');
  return {partido_id:mid,fecha_hora:new Date(date).toISOString(),court_id:court,duration_minutes:minutes,timezone};});
}
