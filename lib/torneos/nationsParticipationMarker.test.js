import test from 'node:test'; import assert from 'node:assert/strict';
import {createMarkerState, appendMarkerEvent, computeParticipation} from './nationsParticipationMarker.js';
const p1='11111111-1111-4111-8111-111111111111',p2='22222222-2222-4222-8222-222222222222',p3='33333333-3333-4333-8333-333333333333',p4='44444444-4444-4444-8444-444444444444';
const lineup={iniciales:[p1,p2],suplentes:[p3,p4]};
function state(){return createMarkerState({lineup,startedAt:1000});}
function ev(s,type,payload,rev=s.revision,now=2000){return appendMarkerEvent(s,{type,...payload,idempotencyKey:payload.key??`${type}-${now}`},{expectedRevision:rev,actorId:'server',now});}

test('substitucion valida mantiene 2 activos y tiempos',()=>{
 let s=state(); ({state:s}=ev(s,'substitution',{eventId:'e1',outId:p1,inId:p3,author:'a',key:'k1'},0,2000));
 assert.deepEqual(s.active,[p3,p2]);
 ({state:s}=ev(s,'close',{eventId:'e2',author:'a',key:'k2'},1,6000));
 const c=computeParticipation(s,lineup); assert.equal(c.status,'confirmed');
 assert.equal(c.players.find(x=>x.id===p1).activeMs,1000); assert.equal(c.players.find(x=>x.id===p3).activeMs,4000);
});
test('idempotencia: mismo key+mismo contenido dedup; distinto contenido conflicto',()=>{
 let s=state(); const a=ev(s,'pause',{eventId:'e1',author:'a',key:'same'},0,1500); s=a.state;
 const b=appendMarkerEvent(s,{type:'pause',eventId:'e1',author:'a',idempotencyKey:'same'},{expectedRevision:s.revision,actorId:'server',now:9999});
 assert.equal(b.deduplicated,true); assert.equal(b.state.events.length,1);
 assert.throws(()=>appendMarkerEvent(s,{type:'pause',eventId:'e1',reason:'different',idempotencyKey:'same'},{expectedRevision:s.revision,actorId:'server',now:9999}),{code:'IDEMPOTENCY_CONFLICT'});
});
test('CAS: dos appends con misma revision => segundo conflicto',()=>{
 const s=state(); const a=appendMarkerEvent(s,{type:'pause',eventId:'a',idempotencyKey:'a',author:'x'},{expectedRevision:0,actorId:'server',now:1500});
 assert.throws(()=>appendMarkerEvent(s,{type:'pause',eventId:'b',idempotencyKey:'b',author:'x'},{expectedRevision:1,actorId:'server',now:1500}),{code:'REVISION_CONFLICT'});
 assert.equal(a.state.revision,1);
});
test('out no activo / in ya activo / pausa invalida',()=>{
 let s=state();
 assert.throws(()=>ev(s,'substitution',{eventId:'e',outId:p4,inId:p3,author:'x',key:'x'},0),{code:'OUT_NOT_ACTIVE'});
 assert.throws(()=>ev(s,'substitution',{eventId:'e',outId:p1,inId:p2,author:'x',key:'x'},0),{code:'IN_ALREADY_ACTIVE'});
 ({state:s}=ev(s,'pause',{eventId:'p',author:'x',key:'p'},0,1500));
 assert.throws(()=>ev(state(),'resume',{eventId:'r',author:'x',key:'r'},0,1600),{code:'RESUME_INVALID'});
});
test('entrante fuera del lineup rechazado; suplente valido aceptado',()=>{
 let s=state(); const outsider='99999999-9999-4999-8999-999999999999';
 assert.throws(()=>ev(s,'substitution',{eventId:'x',outId:p1,inId:outsider,author:'a',key:'x'},0),{code:'IN_NOT_IN_LINEUP'});
 const r=ev(s,'substitution',{eventId:'ok',outId:p1,inId:p3,author:'a',key:'ok'},0); assert.deepEqual(r.state.active,[p3,p2]);
});
test('pausa no suma tiempo',()=>{
 let s=state(); ({state:s}=ev(s,'pause',{eventId:'p',author:'x',key:'p'},0,2000)); ({state:s}=ev(s,'resume',{eventId:'r',author:'x',key:'r'},1,5000)); ({state:s}=ev(s,'close',{eventId:'c',author:'x',key:'c'},2,7000));
 const c=computeParticipation(s,lineup); assert.equal(c.status,'confirmed');
 assert.equal(c.players.find(x=>x.id===p1).activeMs,3000); assert.equal(c.players.find(x=>x.id===p2).activeMs,3000);
});
test('sin cierre => unconfirmed, no cero',()=>{
 const s=state(); const c=computeParticipation(s,lineup); assert.equal(c.status,'unconfirmed'); assert.equal(c.players,null);
});
test('suplente que nunca jugo => 0 solo con cierre valido',()=>{
 let s=state(); ({state:s}=ev(s,'close',{eventId:'c',author:'x',key:'c'},0,3000));
 const c=computeParticipation(s,lineup); assert.equal(c.status,'confirmed'); assert.equal(c.players.find(x=>x.id===p3).activeMs,0);
});
test('correccion aplica patch, exige target/motivo y conserva original',()=>{
 let s=state(); ({state:s}=ev(s,'pause',{eventId:'p1',author:'x',key:'p'},0,1500));
 ({state:s}=ev(s,'close',{eventId:'c',author:'x',key:'c'},1,2000));
 assert.throws(()=>ev(s,'correction',{eventId:'cor',targetEventId:'nope',reason:'r',patch:{serverAt:1200},key:'cor'},2,2500),{code:'CORRECTION_TARGET_INVALID'});
 const orig=s.events.find(e=>e.eventId==='p1');
 ({state:s}=ev(s,'correction',{eventId:'cor',targetEventId:'c',reason:'cierre mal',patch:{serverAt:1700},key:'cor'},2,2500));
 assert.equal(s.events.find(e=>e.eventId==='c').serverAt,2000); assert.equal(s.corrections[0].patch.serverAt,1700);
 assert.equal(s.events.find(e=>e.eventId==='p1').actorId,'server');
 const c=computeParticipation(s); assert.equal(c.status,'confirmed');
});
test('reloj servidor obligatorio y orden monotono',()=>{
 const s=state();
 assert.throws(()=>appendMarkerEvent(s,{type:'pause',idempotencyKey:'x',author:'a'},{expectedRevision:0,actorId:'server',now:null}),{code:'SERVER_CLOCK_REQUIRED'});
 let t=ev(s,'pause',{eventId:'p',author:'a',key:'p'},0,2000).state;
 assert.throws(()=>ev(t,'resume',{eventId:'r',author:'a',key:'r'},1,1900),{code:'OUT_OF_ORDER'});
});
test('restart: estado serializado produce mismo calculo',()=>{
 let s=state(); ({state:s}=ev(s,'substitution',{eventId:'s',outId:p2,inId:p4,author:'a',key:'s'},0,2000)); ({state:s}=ev(s,'close',{eventId:'c',author:'a',key:'c'},1,5000));
 const c1=computeParticipation(s,lineup); const restored=JSON.parse(JSON.stringify(s)); const c2=computeParticipation(restored,lineup);
 assert.deepEqual(c1,c2);
});

test('cerrado -> correccion valida de close -> tiempos recalculados y confirmados',()=>{
 let s=state(); ({state:s}=ev(s,'substitution',{eventId:'s',outId:p1,inId:p3,author:'x',key:'s'},0,2000)); ({state:s}=ev(s,'close',{eventId:'c',author:'x',key:'c'},1,4000));
 assert.equal(computeParticipation(s).status,'confirmed');
 ({state:s}=ev(s,'correction',{eventId:'cor',targetEventId:'c',reason:'cierre antes',patch:{serverAt:3000},key:'cor'},2,5000));
 assert.equal(s.status,'corrected');
 const c=computeParticipation(s); assert.equal(c.status,'confirmed'); assert.equal(c.players.find(x=>x.id===p3).activeMs,1000);
 assert.equal(s.events.find(e=>e.eventId==='c').serverAt,4000, 'original conservado');
});
test('correccion falsa (patch invalido) no confirma',()=>{
 let s=state(); ({state:s}=ev(s,'close',{eventId:'c',author:'x',key:'c'},0,2000));
 ({state:s}=ev(s,'correction',{eventId:'cor',targetEventId:'c',reason:'romper',patch:{serverAt:500},key:'cor'},1,3000));
 assert.equal(computeParticipation(s).status,'unconfirmed');
});
test('porcentaje = activeMs/effectiveMatchMs; 100%, 50/50, suplente 0 y pausas excluidas',()=>{
 let s=state(); ({state:s}=ev(s,'close',{eventId:'c',author:'x',key:'c'},0,6000));
 let c=computeParticipation(s,lineup); assert.equal(c.status,'confirmed'); assert.equal(c.effectiveMatchMs,5000);
 assert.equal(c.players.find(x=>x.id===p1).percentage,100); assert.equal(c.players.find(x=>x.id===p3).percentage,0);
 let t=state(); ({state:t}=ev(t,'substitution',{eventId:'s',outId:p1,inId:p3,author:'x',key:'s'},0,3500)); ({state:t}=ev(t,'close',{eventId:'c2',author:'x',key:'c2'},1,6000));
 const d=computeParticipation(t,lineup); assert.equal(d.effectiveMatchMs,5000); assert.equal(d.players.find(x=>x.id===p1).percentage,50); assert.equal(d.players.find(x=>x.id===p3).percentage,50);
 let u=state(); ({state:u}=ev(u,'pause',{eventId:'p',author:'x',key:'p'},0,2000)); ({state:u}=ev(u,'resume',{eventId:'r',author:'x',key:'r'},1,5000)); ({state:u}=ev(u,'close',{eventId:'c3',author:'x',key:'c3'},2,7000));
 const e=computeParticipation(u,lineup); assert.equal(e.effectiveMatchMs,3000); assert.equal(e.players.find(x=>x.id===p1).percentage,100);
});
test('porcentaje desconocido sin cierre; duracion cero no es 0%',()=>{
 let s=state(); const open=computeParticipation(s,lineup); assert.equal(open.status,'unconfirmed'); assert.equal(open.players,null); assert.equal(open.percentage,undefined);
 ({state:s}=ev(s,'close',{eventId:'c',author:'x',key:'c'},0,1000)); const zero=computeParticipation(s,lineup); assert.equal(zero.status,'unconfirmed'); assert.equal(zero.reason,'DURATION_ZERO'); assert.equal(zero.players.find(x=>x.id===p1).activeMs,0); assert.equal(zero.players.find(x=>x.id===p1).percentage,undefined);
});
test('A y B comparten denominador efectivo',()=>{
 let a=state(); let b=state(); ({state:a}=ev(a,'close',{eventId:'ca',author:'x',key:'ca'},0,6000)); ({state:b}=ev(b,'close',{eventId:'cb',author:'x',key:'cb'},0,6000));
 assert.equal(computeParticipation(a,lineup).effectiveMatchMs,computeParticipation(b,lineup).effectiveMatchMs);
});
test('cierre estando pausado excluye la pausa final del denominador',()=>{
 let s=state(); ({state:s}=ev(s,'pause',{eventId:'p',author:'x',key:'p'},0,2000)); ({state:s}=ev(s,'close',{eventId:'c',author:'x',key:'c'},1,6000));
 const c=computeParticipation(s,lineup); assert.equal(c.status,'confirmed'); assert.equal(c.effectiveMatchMs,1000);
 assert.equal(c.players.find(x=>x.id===p1).activeMs,1000); assert.equal(c.players.find(x=>x.id===p1).percentage,100); assert.equal(c.players.find(x=>x.id===p3).percentage,0);
});
test('roster real de 2 o 3 jugadores inicia solo con pareja titular explicita y cierra',()=>{
 const close=(lineup,at)=>{let s=createMarkerState({lineup,startedAt:1000});s=appendMarkerEvent(s,{type:'close',eventId:'close-'+lineup.iniciales[0],idempotencyKey:'close-'+lineup.iniciales[0]},{expectedRevision:0,actorId:'server',now:at}).state;return s;};
 const two={iniciales:[p1,p2],suplentes:[]};let c=computeParticipation(close(two,3000),two);assert.equal(c.status,'confirmed');assert.equal(c.players.length,2);
 const three={iniciales:[p1,p2],suplentes:[p3]};let s=createMarkerState({lineup:three,startedAt:1000});
 s=appendMarkerEvent(s,{type:'substitution',eventId:'s3',outId:p1,inId:p3,idempotencyKey:'s3'},{expectedRevision:0,actorId:'server',now:2000}).state;
 s=appendMarkerEvent(s,{type:'close',eventId:'c3',idempotencyKey:'c3'},{expectedRevision:1,actorId:'server',now:4000}).state;
 c=computeParticipation(s,three);assert.equal(c.status,'confirmed');assert.equal(c.players.length,3);
 assert.throws(()=>createMarkerState({lineup:{iniciales:[p1],suplentes:[p2]},startedAt:1000}),{code:'LINEUP_INVALID'});
});
test('vacante no es sustitucion valida ni se mide',()=>{
 const three={iniciales:[p1,p2],suplentes:[p3]};const s=createMarkerState({lineup:three,startedAt:1000});
 assert.throws(()=>appendMarkerEvent(s,{type:'substitution',eventId:'v',outId:p1,inId:p4,idempotencyKey:'v'},{expectedRevision:0,actorId:'server',now:2000}),{code:'IN_NOT_IN_LINEUP'});
});
