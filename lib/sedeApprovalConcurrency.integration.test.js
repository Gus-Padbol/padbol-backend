import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import pg from 'pg';
import {createSedeApprovalRecovery,createSedeApprovalOutboxWorker} from './sedeApprovalRecovery.js';
import {createSedeApprovalDeliverer} from './sedeApprovalDeliverer.js';
const enabled=process.env.SEDE_APPROVAL_PG_CONFIG;
const owner='11111111-1111-4111-8111-111111111111';
let pool;
const fixtureSql=(await fs.readFile(new URL('./fixtures/sedeApprovalFixture.sql',import.meta.url),'utf8')).replace('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;','');
const migration=await fs.readFile(new URL('../sql/candidates/20261030143000_sede_approval_recovery.sql',import.meta.url),'utf8');
before(async()=>{
 if(!enabled)return;
 const c=JSON.parse(await fs.readFile(enabled,'utf8'));
 assert.equal(c.isolated_synthetic_only,true);assert.match(c.socket,/^\/tmp\/pbpg-[A-Za-z0-9_-]+$/);assert.equal(c.port,55483);
 const cfg={host:c.socket,port:c.port,user:c.username,database:'postgres'};
 const admin=new pg.Pool(cfg);
 try{for(const role of ['anon','authenticated','service_role']){if(!(await admin.query('SELECT 1 FROM pg_roles WHERE rolname=$1',[role])).rowCount)await admin.query('CREATE ROLE '+role);}
 if(!(await admin.query("SELECT 1 FROM pg_database WHERE datname='padbol_sede_recovery_qa'")).rowCount)await admin.query('CREATE DATABASE padbol_sede_recovery_qa');}finally{await admin.end();}
 pool=new pg.Pool({...cfg,database:'padbol_sede_recovery_qa',max:20});assert.equal((await pool.query('select current_database() as db')).rows[0].db,'padbol_sede_recovery_qa');
});
after(async()=>{if(pool)await pool.end();});
async function reset(){await pool.query('DROP SCHEMA public CASCADE;CREATE SCHEMA public;GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role');await pool.query(fixtureSql);await pool.query(migration);return createSedeApprovalRecovery({pool});}
async function counts(){const result={};for(const t of ['sedes','user_roles','sede_approval_operations','sede_approval_outbox'])result[t]=Number((await pool.query('SELECT count(*) as n FROM public.'+t)).rows[0].n);return result;}
const real=(name,fn)=>test(name,{skip:!enabled},fn);
real('PG17: twenty simultaneous approvals across real connections create one venue and one outbox set',async()=>{
 const s=await reset();const result=await Promise.all(Array.from({length:20},()=>s.approve({actorId:owner,requestId:7})));
 assert.equal(new Set(result.map(x=>String(x.sede_id))).size,1);assert.equal(result.filter(x=>!x.replayed).length,1);assert.deepEqual(await counts(),{sedes:1,user_roles:2,sede_approval_operations:1,sede_approval_outbox:5});
});
real('PG17: two separate requests for the same venue cannot create two venues',async()=>{
 const s=await reset();await pool.query("INSERT INTO sedes_pendientes SELECT (jsonb_populate_record(NULL::sedes_pendientes,to_jsonb(p)||'{\"id\":8,\"licenciatario_email\":\"second@example.invalid\"}'::jsonb)).* FROM sedes_pendientes p WHERE id=7");
 const r=await Promise.allSettled([7,8].map(requestId=>s.approve({actorId:owner,requestId})));assert.equal(r.filter(x=>x.status==='fulfilled').length,1);assert.equal((await counts()).sedes,1);assert.equal((await counts()).sede_approval_operations,1);
});
real('PG17: failure writing outbox rolls back venue, role, journal and pending status',async()=>{
 const s=await reset();await pool.query("CREATE FUNCTION reject_qa_outbox() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'QA_OUTBOX_FAILURE'; END $$;CREATE TRIGGER reject_qa_outbox BEFORE INSERT ON sede_approval_outbox FOR EACH ROW EXECUTE FUNCTION reject_qa_outbox()");
 await assert.rejects(s.approve({actorId:owner,requestId:7}),/QA_OUTBOX_FAILURE/);assert.deepEqual(await counts(),{sedes:0,user_roles:1,sede_approval_operations:0,sede_approval_outbox:0});assert.equal((await pool.query('select estado from sedes_pendientes where id=7')).rows[0].estado,'pendiente');await pool.query('DROP TRIGGER reject_qa_outbox ON sede_approval_outbox');await s.approve({actorId:owner,requestId:7});assert.equal((await counts()).sedes,1);
});
real('PG17: lost COMMIT acknowledgement replays the committed result without duplicating',async()=>{
 await reset();let lost=false;const wrapped={connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql,args)=>{const r=await c.query(sql,args);if(sql==='COMMIT'&&!lost){lost=true;throw Error('QA_COMMIT_ACK_LOST');}return r;}};}};
 const s=createSedeApprovalRecovery({pool:wrapped});await assert.rejects(s.approve({actorId:owner,requestId:7}),/QA_COMMIT_ACK_LOST/);assert.equal((await s.approve({actorId:owner,requestId:7})).replayed,true);assert.equal((await counts()).sedes,1);
});
real('PG17: parallel outbox workers never claim the same delivery',async()=>{
 const s=await reset();await s.approve({actorId:owner,requestId:7});const seen=[];const deliver=async j=>{seen.push(j.idempotencyKey);await new Promise(r=>setTimeout(r,15));return {accepted:true,reference:'synthetic:ack'};};const a=createSedeApprovalOutboxWorker({pool,deliver}),b=createSedeApprovalOutboxWorker({pool,deliver});for(let i=0;i<6;i++)await Promise.all([a.runOne(),b.runOne()]);assert.equal(seen.length,5);assert.equal(new Set(seen).size,5);assert.ok((await s.status({actorId:owner,requestId:7})).jobs.every(x=>x.state==='succeeded'));
});
real('PG17: unacknowledged provider result remains uncertain and is not sent again',async()=>{
 const s=await reset();await s.approve({actorId:owner,requestId:7});let count=0;const w=createSedeApprovalOutboxWorker({pool,deliver:async j=>{if(j.kind==='welcome_email'){count++;throw Error('synthetic uncertain network');}return {accepted:true};}});for(let i=0;i<12;i++)await w.runOne();assert.equal(count,1);assert.equal((await s.status({actorId:owner,requestId:7})).jobs.find(x=>x.kind==='welcome_email').state,'uncertain');
});
real('PG17: delivery remains bound to the approved recipient after request edits',async()=>{
 const s=await reset();await s.approve({actorId:owner,requestId:7});await pool.query("UPDATE sedes_pendientes SET licenciatario_email='changed@example.invalid',nombre='Changed after approval' WHERE id=7");let recipient;
 const deliver=createSedeApprovalDeliverer({pool,runtime:{outboundDeliveryEnabled:true},supabaseAdmin:{auth:{admin:{createUser:async p=>{recipient=p.email;return {error:{code:'email_exists'}};}}}}});await deliver({requestId:7,kind:'auth_user'});assert.equal(recipient,'venue@example.invalid');
});
real('PG17: registration webhook applies to newly provisioned users, never existing users',async()=>{
 const s=await reset();await s.approve({actorId:owner,requestId:7});let calls=0;const deliver=createSedeApprovalDeliverer({pool,runtime:{outboundDeliveryEnabled:true},sendRegistrationEvent:async(event,data)=>{calls++;assert.equal(event,'jugador_registrado');assert.equal(data.email,'venue@example.invalid');return {accepted:true};}});
 await pool.query("UPDATE sede_approval_outbox SET state='succeeded',provider_reference='auth:already-exists' WHERE kind='auth_user'");assert.equal((await deliver({requestId:7,kind:'registration_event'})).skipped,true);assert.equal(calls,0);await pool.query("UPDATE sede_approval_outbox SET provider_reference='auth:22222222-2222-4222-8222-222222222222' WHERE kind='auth_user'");assert.equal((await deliver({requestId:7,kind:'registration_event'})).accepted,true);assert.equal(calls,1);
});
real('PG17: international mapping retains Miami/Madrid inference and explicit time zones',async()=>{
 for(const [city,country,tz,expected] of [['Miami','USA',null,'America/New_York'],['Madrid','España',null,'Europe/Madrid'],['Paris','Francia','Europe/Paris','Europe/Paris']]){const s=await reset();await pool.query('UPDATE sedes_pendientes SET ciudad=$1,pais=$2,timezone=$3,moneda=$4,metodo_pago=$5 WHERE id=7',[city,country,tz,'EUR','stripe']);const r=await s.approve({actorId:owner,requestId:7});const row=(await pool.query('SELECT timezone,moneda,metodo_pago FROM sedes WHERE id=$1',[r.sede_id])).rows[0];assert.deepEqual(row,{timezone:expected,moneda:'EUR',metodo_pago:'stripe'});}
});
real('PG17: ordinary authenticated database role cannot read approval or delivery journals',async()=>{
 const s=await reset();await s.approve({actorId:owner,requestId:7});const c=await pool.connect();try{await c.query('SET ROLE authenticated');await assert.rejects(c.query('SELECT * FROM sede_approval_operations'),/permission denied/);await assert.rejects(c.query('SELECT * FROM sede_approval_outbox'),/permission denied/);}finally{await c.query('RESET ROLE');c.release();}
});

real('PG17: approval and rejection serialize in both orders without mixed state',async()=>{
 const {rejectPendingSede}=await import('./sedePendingRejection.js');
 for(const winner of ['approval','rejection']){
  const service=await reset();await pool.query('ALTER TABLE sedes_pendientes ADD COLUMN motivo_rechazo text');
  let entered,release;const enteredPromise=new Promise(r=>entered=r),releasePromise=new Promise(r=>release=r);
  const wrapped={query:(...a)=>pool.query(...a),connect:async()=>{const c=await pool.connect();return {release:()=>c.release(),query:async(sql,args)=>{const result=await c.query(sql,args);if(sql==='SELECT * FROM public.sedes_pendientes WHERE id=$1 FOR UPDATE'){entered();await releasePromise;}return result;}};}};
  const rejection=(client,gate=false)=>{const filters={};const q={update(){return q},eq(k,v){filters[k]=v;return q},select(){return q},async maybeSingle(){try{const r=await client.query("UPDATE public.sedes_pendientes SET estado='rechazada',motivo_rechazo=$2 WHERE id=$1 AND estado=$3 RETURNING id",[filters.id,'Synthetic rejection',filters.estado]);if(gate){entered();await releasePromise;}return {data:r.rows[0]||null,error:null};}catch{return {data:null,error:{message:'synthetic database error'}};}}};return rejectPendingSede({db:{from:()=>q},requestId:7,reason:'Synthetic rejection'});};
  if(winner==='approval'){
   const a=createSedeApprovalRecovery({pool:wrapped}).approve({actorId:owner,requestId:7});await enteredPromise;
   const b=rejection(pool);const settled=Promise.allSettled([a,b]);release();
   const results=await settled;assert.equal(results[0].status,'fulfilled');assert.equal(results[1].reason.code,'REQUEST_NO_LONGER_PENDING');
  }else{
   const c=await pool.connect();await c.query('BEGIN');
   try{const a=rejection(c,true);await enteredPromise;const b=service.approve({actorId:owner,requestId:7});const settled=Promise.allSettled([a,b]);release();await a;await c.query('COMMIT');const results=await settled;assert.equal(results[0].status,'fulfilled');assert.equal(results[1].reason.code,'REQUEST_REQUIRES_MANUAL_RECONCILIATION');}finally{c.release();}
  }
  const state=(await pool.query('SELECT estado FROM sedes_pendientes WHERE id=7')).rows[0].estado;
  assert.equal(state,winner==='approval'?'aprobada':'rechazada');const n=winner==='approval'?1:0;
  assert.equal((await counts()).sedes,n);assert.equal((await counts()).sede_approval_operations,n);assert.equal((await counts()).sede_approval_outbox,n*5);
 }
});

real('PG17: two recoveries racing for one organization slot link only one venue',async()=>{
 const service=await reset(),org='33333333-3333-4333-8333-333333333333',chain='22222222-2222-4222-8222-222222222222';
 await pool.query("INSERT INTO organizaciones VALUES($1,'activa',1,2)",[org]);
 await pool.query("INSERT INTO user_roles(user_id,email,role,alcance,organizacion_id) VALUES($1,'venue@example.invalid','admin_cadena','organizacion',$2)",[chain,org]);
 await pool.query("UPDATE sedes_pendientes SET organizacion_id=$1,created_by='venue@example.invalid',cantidad_canchas_solicitadas=1 WHERE id=7",[org]);
 await pool.query("INSERT INTO sedes_pendientes SELECT (jsonb_populate_record(NULL::sedes_pendientes,to_jsonb(p)||'{\"id\":8,\"nombre\":\"Second Club\"}'::jsonb)).* FROM sedes_pendientes p WHERE id=7");
 await pool.query("INSERT INTO sedes(nombre,pais,ciudad,cantidad_canchas) VALUES('Club QA','Argentina','La Plata',2),('Second Club','Argentina','La Plata',2)");
 const results=await Promise.allSettled([service.approve({actorId:owner,requestId:7,recoverySedeId:1}),service.approve({actorId:owner,requestId:8,recoverySedeId:2})]);
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1);assert.equal(results.find(r=>r.status==='rejected').reason.code,'ORGANIZATION_LIMIT_EXCEEDED');
 assert.equal((await pool.query('SELECT count(*)::int AS n FROM organizacion_sedes')).rows[0].n,1);assert.equal((await counts()).sede_approval_outbox,5);assert.equal((await counts()).sedes,2);
});
