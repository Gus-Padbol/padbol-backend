import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlayedDate,saveManualPlayedDate,saveManualResultAndPlayedDate,readManualPlayedDate,
  matchesManualDateEvidence,getManualDateParticipantIds,mountManualPlayedDateRoutes } from './torneos/manualPlayedDateService.js';
const actor='10000000-0000-4000-8000-000000000001';
const players=Array.from({length:4},(_,i)=>`20000000-0000-4000-8000-00000000000${i+1}`);
const now=new Date('2026-09-10T23:00:00Z');
const result={goles_a:2,goles_b:0,historial_sets:[{set:1,a:6,b:2},{set:2,a:6,b:4}]};
const date={fecha_juego:'2026-08-21',procedencia:'declaracion_operador',revision:1,vigente:true,registrado_at:'2026-09-10T22:00:00+00:00',actualizado_at:'2026-09-10T22:00:00+00:00'};
const reply={...date,partido_id:1,torneo_id:1,status:'finalized',resultado:result,ganador_equipo_id:10};
const params={torneoId:1,partidoId:1,actorId:actor,body:{fecha_juego:'2026-08-21'},resultado:result};
const match={id:1,torneo_id:1,sede_id:1,estado:'finalizado',equipo_a_id:10,equipo_b_id:11,ganador_equipo_id:10,resultado:{...result,fuente_resultado:'manual_admin'}};
const tournament={id:1,sede_id:1,deporte:'padbol',formato_equipo:'dobles'};
const evidence={...date,partido_id:1,torneo_id:1,sede_id:1,equipo_a_id:10,equipo_b_id:11,ganador_equipo_id:10,resultado_snapshot:match.resultado,participantes_a:players.slice(0,2),participantes_b:players.slice(2),participantes_procedencia:'plantel_al_registrar_resultado'};
function client(data=reply,error=null) {
  const calls=[];return {calls,rpc:async(...args)=>{calls.push(args);return {data,error};}};
}
test('calendar date rejects invalid/future/null, supports leap day and optional legacy',()=>{
 for(const value of ['2026-02-29','2024-02-30','2026-09-11','0000-01-01','2026-1-01',null,undefined,42]) assert.throws(()=>parsePlayedDate({fecha_juego:value},{now}),e=>e.status===400);
 assert.equal(parsePlayedDate({fecha_juego:'2024-02-29'},{now}).date,'2024-02-29');
 assert.equal(parsePlayedDate({},{now,optional:true}),null);
});
test('revision and correction reason validation',()=>{
 for(const revision of [-1,1.5,'1',Number.MAX_SAFE_INTEGER+1])assert.throws(()=>parsePlayedDate({...params.body,revision_esperada:revision},{now}));
 for(const reason of ['',null,' four ', 'x'.repeat(301)])assert.throws(()=>parsePlayedDate({...params.body,revision_esperada:1,motivo_correccion:reason},{now}));
 assert.equal(parsePlayedDate({...params.body,revision_esperada:1,motivo_correccion:' Corregir mes '},{now}).reason,'Corregir mes');
});
test('atomic operation exactly one RPC; actor comes from trusted auth argument',async()=>{
 const db=client({...reply,actor_id:'private',motivo:'private',participantes_a:players});
 const actual=await saveManualResultAndPlayedDate(db,{...params,body:{...params.body,actor_id:'spoofed',registrado_at:'1900-01-01',participantes_a:['spoofed']}},{now});
 assert.equal(db.calls.length,1);assert.equal(db.calls[0][0],'registrar_fecha_juego_manual');
 assert.equal(db.calls[0][1].p_actor_id,actor);assert.deepEqual(db.calls[0][1].p_resultado,result);
 assert.deepEqual(actual,{partido_id:1,torneo_id:1,status:'finalized',resultado:result,ganador_equipo_id:10,fecha_declarada:date});
});
test('date-only ignores body result and private spoofing',async()=>{
 const db=client({...reply,status:'idempotent'});
 assert.deepEqual(await saveManualPlayedDate(db,{...params,body:{...params.body,resultado:{goles_a:0,goles_b:2}}},{now}),date);
 assert.equal(db.calls[0][1].p_resultado,null);
});
test('read uses authorized RPC and returns minimal private-free DTO',async()=>{
 const db=client({...date,actor_id:'secret',motivo:'secret',participantes_a:players});
 assert.deepEqual(await readManualPlayedDate(db,params),date);assert.equal(db.calls[0][0],'leer_fecha_juego_manual');assert.equal(db.calls[0][1].p_actor_id,actor);
 assert.equal(await readManualPlayedDate(client(null),params),null);
});
for (const invalid of [0,-1,1.5,'1e2','0x10',[],true,Number.MAX_SAFE_INTEGER+1]) test(`IDs fail before I/O ${JSON.stringify(invalid)}`,async()=>{
 const db=client();await assert.rejects(saveManualPlayedDate(db,{...params,partidoId:invalid},{now}),e=>e.status===400);assert.equal(db.calls.length,0);
});
test('unverified actor fails before I/O',async()=>{
 for(const actorId of [null,undefined,'someone@example.invalid',42]){const db=client();await assert.rejects(saveManualPlayedDate(db,{...params,actorId},{now}),e=>e.status===401);assert.equal(db.calls.length,0);}
});
for(const [code,status] of Object.entries({'42501':403,P0002:404,'22023':400,'40001':409,'40P01':409,'23514':503}))test('SQL error mapped without leaking '+code,async()=>{
 await assert.rejects(saveManualResultAndPlayedDate(client(null,{code,message:'secret_database_detail'}),params,{now}),e=>e.status===status && !e.message.includes('secret_database_detail'));
});
test('network uncertainty never reports successful commit',async()=>{
 await assert.rejects(saveManualResultAndPlayedDate({rpc:async()=>{throw new Error('secret token');}},params,{now}),e=>e.status===503 && !e.message.includes('secret'));
});
test('malformed RPC replies cannot confirm complete operation',async()=>{
 for(const bad of [null,{}, {...reply,revision:0},{...reply,revision:'1'},{...reply,procedencia:'verified'}, {...reply,actualizado_at:'invalid'}, {...reply,registrado_at:'2026-09-11T00:00:00Z'}, {...reply,fecha_juego:'2026-08-20'}, {...reply,vigente:false},{...reply,partido_id:2},{...reply,torneo_id:2},{...reply,status:'partial'},{...reply,resultado:{goles_a:2,goles_b:2}},{...reply,ganador_equipo_id:null}]) {
  await assert.rejects(saveManualResultAndPlayedDate(client(bad),params,{now}),e=>e.status===503);
 }
});
test('date-only cannot report sporting mutation',async()=>{
 await assert.rejects(saveManualPlayedDate(client(reply),params,{now}),e=>e.status===503);
});
test('public result nested history strips private fields',async()=>{
 const privateReply={...reply,resultado:{...result,actor_id:actor,historial_sets:result.historial_sets.map(s=>({...s,actor_id:actor}))}};
 const data=await saveManualResultAndPlayedDate(client(privateReply),params,{now});assert.deepEqual(data.resultado,result);
});
test('snapshot evidence validates IDs, scope, state, timestamp and exact result',()=>{
 assert.equal(matchesManualDateEvidence(evidence,match,tournament),true);
 for(const patch of [{vigente:false},{partido_id:2},{torneo_id:2},{sede_id:null},{equipo_a_id:null},{resultado_snapshot:{...result}},{registrado_at:'nonsense'},{fecha_juego:'2026-02-30'}])assert.equal(matchesManualDateEvidence({...evidence,...patch},match,tournament),false);
 for(const patch of [{estado:'pendiente'},{torneo_id:2},{sede_id:2},{ganador_equipo_id:11}])assert.equal(matchesManualDateEvidence(evidence,{...match,...patch},tournament),false);
});
test('historical participants come only from immutable UUID snapshot',()=>{
 assert.deepEqual(getManualDateParticipantIds(evidence,match,tournament),players);
 for(const patch of [{participantes_procedencia:'sin_evidencia_historica'},{participantes_a:null},{participantes_b:players.slice(0,2)},{participantes_a:['not-uuid',players[1]]},{vigente:false}]) assert.deepEqual(getManualDateParticipantIds({...evidence,...patch},match,tournament),[]);
 // Extra current-team information cannot substitute or enlarge the snapshot.
 assert.deepEqual(getManualDateParticipantIds({...evidence,jugadores:['someone-else']},match,tournament),players);
});
function routeFixture(auth,db) {
 const handlers={};const app={get:(p,h)=>handlers.get=h,put:(p,h)=>handlers.put=h};
 mountManualPlayedDateRoutes(app,{supabaseAdmin:db,requireTorneoAdminByTorneoId:auth});return handlers;
}
function res(){return {statusCode:200,status(n){this.statusCode=n;return this;},json(body){this.body=body;return this;}};}
test('route JWT result overrides spoofed body actor and correction cannot write result',async()=>{
 const db=client({...reply,status:'idempotent'});const handlers=routeFixture(async()=>({user:{id:actor}}),db);const response=res();
 await handlers.put({params:{torneoId:'1',partidoId:'1'},body:{...params.body,actor_id:'spoofed',resultado:result}},response);
 assert.equal(response.statusCode,200);assert.equal(db.calls[0][1].p_actor_id,actor);assert.equal(db.calls[0][1].p_resultado,null);assert.deepEqual(response.body.fecha_declarada,date);
});
test('route denied auth prevents any read or write',async()=>{
 const db=client();const handlers=routeFixture(async(req,response)=>{response.status(403).json({ok:false});return null;},db);
 for(const method of ['get','put']){const response=res();await handlers[method]({params:{torneoId:'1',partidoId:'1'}},response);assert.equal(response.statusCode,403);}
 assert.equal(db.calls.length,0);
});
test('route late revocation handled by SQL authorization',async()=>{
 const db=client(null,{code:'42501'});const handlers=routeFixture(async()=>({user:{id:actor}}),db);const response=res();
 await handlers.get({params:{torneoId:'1',partidoId:'1'}},response);assert.equal(response.statusCode,403);assert.equal(response.body.ok,false);
});

test('disabled route authenticates first and never calls the date RPC',async()=>{
 let authenticated=0;const db=client();const handlers={};
 mountManualPlayedDateRoutes({get:(path,h)=>handlers.get=h,put:(path,h)=>handlers.put=h},
 {supabaseAdmin:db,requireTorneoAdminByTorneoId:async()=>{authenticated++;return {user:{id:actor}};},enabled:false});
 for(const method of ['get','put']){const response=res();await handlers[method]({params:{torneoId:'1',partidoId:'1'},body:params.body},response);assert.equal(response.statusCode,409);assert.equal(response.body.code,'MANUAL_PLAYED_DATE_DISABLED');}
 assert.equal(authenticated,2);assert.equal(db.calls.length,0);
});
