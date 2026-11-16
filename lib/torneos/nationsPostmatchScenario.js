import {registrarPunto} from '../../utils/scoreboardLogic.js';
import {appendMarkerEvent} from './nationsParticipationMarker.js';
import {NAPOLI_GROUPS_POLICY} from '../../src/scoreboard/napoliScoringPolicy.js';
const T0=Date.parse('2026-11-20T10:00:00.000Z');
const namesA=['Marco Rossi','Luca Bianchi','Paolo Conti','Andrea Ricci'];
const namesB=['Javier López','Carlos Martín','Diego Ruiz','Pablo García'];
const ids=(prefix,n)=>Array.from({length:n},(_,i)=>`${prefix}${i+1}`);
const team=(prefix,names)=>ids(prefix,4).map((id,i)=>({id,name:names[i]}));
function starterState(prefix){
 const roster=ids(prefix,4);
 return {revision:0,status:'open',startedAt:T0,active:roster.slice(0,2),lineup:{iniciales:roster.slice(0,2),suplentes:roster.slice(2)},roster,corrections:[],events:[]};
}
function addSub(state,eventId,outId,inId,at){const r=appendMarkerEvent(state,{eventId,type:'substitution',idempotencyKey:eventId,outId,inId},{expectedRevision:state.revision,now:at,actorId:'synthetic'});return r.state;}
function close(state,at){return appendMarkerEvent(state,{eventId:`${state.roster[0]}-close`,type:'close',idempotencyKey:`${state.roster[0]}-close`},{expectedRevision:state.revision,now:at,actorId:'synthetic'}).state;}
export function buildNationsPostmatchScenario(){
 const partido={id:'synthetic-scenario',estado:'en_curso',score_a:0,score_b:0,games_a:0,games_b:0,sets_a:0,sets_b:0,historial_sets:[],historial_puntos:[],es_tiebreak:false,saque_actual:'A',sets_a:0,sets_b:0};
 // 6-3, 3-6, 6-4: 28 games x 4 points = 112 real registrarPunto calls.
 const sets=[['A','A','A','B','A','B','A','B','A'],['B','B','A','B','B','A','B','A','B']];
 const points=[];
  for(const set of sets) for(const winner of set){for(let p=0;p<4;p++){registrarPunto(partido,winner,NAPOLI_GROUPS_POLICY);points.push({timestamp:new Date(T0+points.length*1000).toISOString(),equipo:winner});}}
 // Deciding super tie-break to 10, win by 1: pass 9-9, A closes 10-9; never 11.
 for(const winner of [...Array(9).fill('A'),...Array(9).fill('B'),'A']){registrarPunto(partido,winner,NAPOLI_GROUPS_POLICY);points.push({timestamp:new Date(T0+points.length*1000).toISOString(),equipo:winner});}
 try{registrarPunto(partido,'B',NAPOLI_GROUPS_POLICY);throw new Error('SCENARIO_DID_NOT_END');}catch(error){if(error.message==='SCENARIO_DID_NOT_END')throw error;if(!/termin/i.test(error.message)&&error.status!==400)throw error;}
 // substitutions only after complete sets (9 games / 18 games), never mid-set.
 let a=starterState('a');let b=starterState('b');
 const at1=T0+points.length*1000+1000; // after final point
 // Use actual positions after set1/set2 are 36/72 points; at1 must be after 36, not after all points.
 const subAt1=T0+35*1000+500, subAt2=T0+71*1000+500, closeAt=T0+points.length*1000+1000;
 a=addSub(a,'a-between-1-2','a1','a3',subAt1);b=addSub(b,'b-between-1-2','b1','b3',subAt1);
 a=addSub(a,'a-between-2-3','a2','a4',subAt2);b=addSub(b,'b-between-2-3','b2','b4',subAt2);
 a=close(a,closeAt);b=close(b,closeAt);
 const scenario={board:{...partido,equipo_a_nombre:'Italia',equipo_b_nombre:'España'},context:{membership:{A:'101',B:'102'},teams:{101:{players:team('a',namesA)},102:{players:team('b',namesB)}}},aggregate:{states:{101:a,102:b}},finalAt:closeAt,points};
 return scenario;
}
