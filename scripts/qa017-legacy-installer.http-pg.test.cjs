const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {start}=require('./qa017-http-pg.fixture.cjs');
const ROOT=path.resolve(__dirname,'..');
const read=n=>fs.readFileSync(path.join(ROOT,n),'utf8');
const sha=s=>crypto.createHash('sha256').update(s).digest('hex');
const body=(s,n)=>s.split('-- BODY-BEGIN '+n+'\n')[1].split('-- BODY-END '+n)[0];
const client=f=>async(actor,method,url,body)=>{const r=await fetch(f.baseUrl+url,{method,signal:AbortSignal.timeout(5000),headers:{...(actor?{authorization:'Bearer '+actor}:{}),...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
const rows=async(p,t)=>(await p.query('SELECT row_to_json(t) row FROM '+t+' t ORDER BY id')).rows.map(r=>r.row);
test('QA017 preserves frozen installer, nine exact bodies, eleven boundaries and safety envelope',()=>{
 const old=read('sql/candidates/20261123_qa_integrated_install_bundle.sql'),next=read('sql/candidates/20261124_qa_legacy_compat017_install_bundle.sql');
 assert.equal(sha(old),'7d82cf4fcaef2825ad6cead18b6fe50b7057b51f8e96969e6c0ab69f5377945c');
 for(let n=1;n<=11;n++)if(![5,6].includes(n))assert.equal(body(next,n),body(old,n));
 const locks=s=>s.match(/LOCK TABLE[\s\S]*?IN ACCESS EXCLUSIVE MODE;/)[0];assert.equal(locks(old),locks(next));
 for(const setting of ["BEGIN ISOLATION LEVEL READ COMMITTED;","SET LOCAL lock_timeout = '3s';","SET LOCAL statement_timeout = '30s';","SET LOCAL idle_in_transaction_session_timeout = '60s';"])assert.ok(next.includes(setting));
 assert.ok(next.indexOf('DO $legacy_compat_precheck$')>next.indexOf('IN ACCESS EXCLUSIVE MODE;'));
 assert.ok(next.indexOf('END $legacy_compat_precheck$;')<next.indexOf('-- BODY-BEGIN 1'));
 assert.deepEqual(next.match(/^(?:REVOKE|GRANT).*$/gm),old.match(/^(?:REVOKE|GRANT).*$/gm));
 assert.match(next,/COMMIT;\s*$/);assert.equal((next.match(/-- BODY-BEGIN /g)||[]).length,11);
});
test('empty fixture exact QA017 install: real HTTP prepare/enroll/QR with capacity, retry and authorization', {timeout:30000},async()=>{
 let f;try{f=await start();const call=client(f),slot={fecha:f.context.fecha,hora_inicio:'18:00'};
 const prep=await call(90,'POST','/api/admin/clases/1/ocurrencias',slot);assert.equal(prep.status,201);
 const retry=await call(90,'POST','/api/admin/clases/1/ocurrencias',slot);assert.equal(retry.status,200);assert.equal(retry.body.ocurrencia_id,prep.body.ocurrencia_id);
 const a=await call(1,'POST','/api/clases/inscribir',{clase_id:1,...slot});assert.equal(a.status,201);
 assert.equal((await call(1,'POST','/api/clases/inscribir',{clase_id:1,...slot})).status,409);
 const full=await call(2,'POST','/api/clases/inscribir',{clase_id:1,...slot});assert.equal(full.status,409);assert.equal(full.body.code,'CLASE_OCURRENCIA_COMPLETA');
 const qr=await call(1,'POST',`/api/clases/inscripcion/${a.body.id}/acceso`,{});assert.equal(qr.status,200);assert.equal(qr.body.tipo,'clase');assert.match(qr.body.qr_code,/^[0-9a-f]{64}$/);
 assert.equal((await call(2,'POST',`/api/clases/inscripcion/${a.body.id}/acceso`,{})).status,403);
 assert.equal((await call(1,'POST','/api/admin/clases/2/ocurrencias',slot)).status,403);
 assert.equal((await call(0,'POST','/api/clases/inscribir',{clase_id:1,...slot})).status,401);
 const mine=await call(1,'GET','/api/jugador/mis-clases');assert.equal(mine.status,200);assert.equal(mine.body.length,1);assert.equal(String(mine.body[0].id),String(a.body.id));
 assert.equal((await rows(f.pool,'clases_ocurrencias')).length,1);console.log('EMPTY_INSTALL_HTTP_PG_CAPACITY_RETRY_AUTH_PASS');
 }finally{await f?.stop();}
});
test('legacy fixture exact QA017 install preserves rows, own GET/cancel/retry, occupancy and quarantine; new class remains usable', {timeout:30000},async()=>{
 let f;try{f=await start({legacy:true});const call=client(f),p=f.pool,legacy=(await rows(p,'inscripciones_clases')).find(i=>i.clase_id===2),booking=(await rows(p,'reservas'))[0];assert.equal(legacy.ocurrencia_id,null);
 const mine=await call(2,'GET','/api/jugador/mis-clases');assert.equal(mine.status,200);assert.equal(mine.body.length,1);assert.equal(String(mine.body[0].id),String(legacy.id));assert.equal(mine.body[0].ocurrencia_id,null);
 const slot={fecha:f.context.fecha,hora_inicio:'18:00'};
 const blocked=await call(90,'POST','/api/admin/clases/2/ocurrencias',slot);assert.equal(blocked.status,409);assert.equal(blocked.body.code,'CLASE_HORARIO_LEGACY_REQUIERE_REVISION');assert.match(blocked.body.error,/inscripciones anteriores/);
 const noQr=await call(2,'POST',`/api/clases/inscripcion/${legacy.id}/acceso`,{});assert.equal(noQr.status,409);assert.equal(noQr.body.qr_code,undefined);
 await assert.rejects(p.query('UPDATE clases SET duracion_minutos=90 WHERE id=2'),/CLASE_LEGACY_FOOTPRINT_BLOQUEADO/);
 assert.equal((await call(90,'POST','/api/admin/clases/1/ocurrencias',slot)).status,201);
 const a=await call(1,'POST','/api/clases/inscribir',{clase_id:1,...slot});assert.equal(a.status,201);
 const q=await call(1,'POST',`/api/clases/inscripcion/${a.body.id}/acceso`,{});assert.equal(q.status,200);
 const overlap=await call(90,'POST','/api/admin/clases/1/ocurrencias',{...slot,fecha:legacy.fecha});assert.equal(overlap.status,409);
 assert.deepEqual((await rows(p,'inscripciones_clases')).find(i=>i.id===legacy.id),legacy);assert.deepEqual((await rows(p,'reservas')).find(i=>i.id===booking.id),booking);
 assert.equal((await call(1,'DELETE',`/api/clases/inscripcion/${legacy.id}`)).status,403);
 const cancel=await call(2,'DELETE',`/api/clases/inscripcion/${legacy.id}`);assert.equal(cancel.status,200);assert.equal(cancel.body.ok,true);
 const again=await call(2,'DELETE',`/api/clases/inscripcion/${legacy.id}`);assert.equal(again.status,200);assert.equal(again.body.ya_cancelada,true);
 assert.equal((await call(2,'GET','/api/jugador/mis-clases')).body.length,0);
 assert.deepEqual((await rows(p,'reservas')).find(i=>i.id===booking.id),booking); // no implicit release of legacy occupancy
 // Same legacy tuple remains historical, never adopted into the Amodel.

 const prior=(await rows(p,'inscripciones_clases')).find(i=>i.clase_id===1&&i.user_id===f.user(2).id);
 const adopt=await call(2,'POST','/api/clases/inscribir',{clase_id:1,...slot});assert.equal(adopt.status,409);assert.equal(adopt.body.code,'CLASE_INSCRIPCION_LEGACY_REQUIERE_REVISION');assert.match(adopt.body.error,/no se modificó/);
 assert.deepEqual((await rows(p,'inscripciones_clases')).find(i=>i.id===prior.id),prior);console.log('LEGACY_PRESERVED_CANCEL_IS_ENROLLMENT_ONLY_OCCUPANCY_RETAINED_NEW_QR_PASS');
 }finally{await f?.stop();}
});
test('ambiguous legacy booking rejects under installer lock and rolls back before bodies', {timeout:30000},async()=>{
 await assert.rejects(start({invalidLegacy:true}),/QA017_LEGACY_BOOKING_REVIEW_REQUIRED/);
});
test('late failure after eleven bodies rolls back all new objects and original registration body', {timeout:30000},async()=>{
 await assert.rejects(start({legacy:true,lateFailure:true}),/QA017_LATE_FAULT/);
});

test('missing unchanged overlap dependency aborts before bodies and preserves baseline',{timeout:30000},async()=>{await assert.rejects(start({missingGuardDependency:true}),/QA017_OVERLAP_GUARD_MISSING/);});
