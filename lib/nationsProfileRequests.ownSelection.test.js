import test from 'node:test';
import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createNationsProfileRequestsService} from './nationsProfileRequests.js';
import {selectionIdFor} from './nationsSelector.js';

const slug = 'nations-cup-napoli-2026';
const actor = {id: '10000000-0000-4000-8000-000000000001'};
const other = {id: '10000000-0000-4000-8000-000000000002'};
const pid = '20000000-0000-4000-8000-000000000001';
const otherPid = '20000000-0000-4000-8000-000000000002';
async function fixture() {
 const db = new PGlite();
 await db.exec(`
 create table nations_activation_events(torneo_id bigint,slug text,enabled boolean);
 create table torneo_participantes(id uuid,torneo_id bigint,nombre text);
 create table nations_activation_participants(participante_id uuid,torneo_id bigint,country text,minor boolean,age_status text);
 create table nations_profile_requests(request_id text,actor_user_id uuid,torneo_id bigint,selected_participante_id uuid,status text,age_status text,updated_at timestamptz,selection_status text,age_verification_status text);
 insert into nations_activation_events values(57,'${slug}',true),(58,'another-event',true);
 insert into torneo_participantes values('${pid}',57,'Jugador Canonico'),('${otherPid}',57,'Otro Jugador');
 insert into nations_activation_participants values('${pid}',57,'AR',false,'desconocido'),('${otherPid}',57,'IT',false,'adulto');
 insert into nations_profile_requests values('own-request','${actor.id}',57,'${pid}','pendiente','desconocido',now(),'verificacion_pendiente','pendiente'),('other-request','${other.id}',57,'${otherPid}','pendiente','adulto',now(),'declarada','verificada');
 `);
 return {db,svc:createNationsProfileRequestsService({pool:db})};
}
test('own status restores only the actor canonical public selection without cache or UUID',async()=>{
 const {db,svc}=await fixture();try{
  const result=await svc.ownStatus(slug,actor);
  assert.equal(result.requests.length,1);
  assert.deepEqual(result.requests[0].selection,{selectionId:selectionIdFor(57,pid),name:'Jugador Canonico',country:'AR'});
  assert.deepEqual(Object.keys(result.requests[0]).sort(),['request_id','status','age_status','updated_at','selection_status','age_verification_status','selection'].sort());
  const serialized=JSON.stringify(result);assert.ok(!serialized.includes(pid));assert.ok(!serialized.includes(otherPid));assert.ok(!serialized.includes('Otro Jugador'));assert.ok(!serialized.includes('other-request'));
  await assert.rejects(svc.ownStatus(slug,null),/AUTH_REQUIRED/);
 }finally{await db.close()}
});
test('disabled, explicit minor, invalid age and cross-event selections fail closed without leaking identity',async()=>{
 for(const alteration of [
  "update nations_activation_events set enabled=false where torneo_id=57",
  "update nations_activation_participants set minor=true",
  "update nations_activation_participants set age_status='menor'",
  "update nations_activation_participants set torneo_id=58",
  "update torneo_participantes set torneo_id=58",
  "update nations_profile_requests set selected_participante_id=null",
 ]){
  const {db,svc}=await fixture();try{await db.exec(alteration);const r=await svc.ownStatus(slug,actor);assert.equal(r.requests[0].selection,null,alteration)}finally{await db.close()}
 }
});
test('other slugs retain existing own-status DTO and never project a selection',async()=>{
 const {db,svc}=await fixture();try{
  await db.exec('update nations_profile_requests set torneo_id=58');
  const result=await svc.ownStatus('another-event',actor);
  assert.equal(result.requests.length,1);assert.equal(Object.hasOwn(result.requests[0],'selection'),false);
  assert.equal(JSON.stringify(result).includes('Jugador Canonico'),false);
 }finally{await db.close()}
});
test('DTO is whitelisted even if a driver row contains additional private fields',async()=>{
 const svc=createNationsProfileRequestsService({pool:{query:async()=>({rows:[{request_id:'own',status:'pendiente',actor_user_id:actor.id,selected_participante_id:pid,documento:'NEVER-RETURN',internal_note:'NEVER-RETURN',selection_torneo_id:57,selection_participant_id:pid,selection_name:'Jugador Canonico',selection_country:'ar'}]})}});
 const r=await svc.ownStatus(slug,actor);assert.equal(r.requests[0].selection.country,'AR');assert.ok(!JSON.stringify(r).includes('NEVER-RETURN'));assert.ok(!JSON.stringify(r).includes(pid));
});
