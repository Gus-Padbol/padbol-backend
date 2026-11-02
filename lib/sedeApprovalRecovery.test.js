import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import vm from 'node:vm';
import {PGlite} from '/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical/node_modules/@electric-sql/pglite/dist/index.js';
import {createSedeApprovalRecovery,createSedeApprovalOutboxWorker} from './sedeApprovalRecovery.js';
import {createSedeApprovalDeliverer} from './sedeApprovalDeliverer.js';

const OWNER='11111111-1111-4111-8111-111111111111';
const OTHER='22222222-2222-4222-8222-222222222222';
const ORG='33333333-3333-4333-8333-333333333333';
const migration=await fs.readFile(new URL('../sql/candidates/20261030143000_sede_approval_recovery.sql',import.meta.url),'utf8');
const preflightSql=await fs.readFile(new URL('../sql/candidates/sede_approval_preflight_readonly.sql',import.meta.url),'utf8');
// Esquema sintético de contrato: NO se presenta como DDL de producción.
const fixtureSql=`
CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
CREATE TABLE public.sedes(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,nombre text NOT NULL,pais text,ciudad text,provincia text,direccion text,timezone text,latitud numeric,longitud numeric,horario_apertura text,horario_cierre text,precio_turno numeric,precio_por_reserva integer,moneda text,metodo_pago text,stripe_account_id text,mp_access_token text,mp_public_key text,pago_manual_instrucciones text,telefono text,email_contacto text,cantidad_canchas integer,numero_licencia text,fecha_licencia date,licencia_activa boolean,franjas_horarias jsonb,fotos_destacadas jsonb,whatsapp_contacto text);
CREATE TABLE public.user_roles(user_id uuid,email text,role text,alcance text,sede_id bigint REFERENCES public.sedes(id),pais text,provincia text,ciudad text,nombre text,torneos_oficiales_habilitados boolean DEFAULT false,organizacion_id uuid);
CREATE TABLE public.sedes_pendientes(id bigint PRIMARY KEY,estado text,nombre text,pais text,ciudad text,provincia text,direccion text,timezone text,latitud numeric,longitud numeric,horario_apertura text,horario_cierre text,precio_base integer,moneda text,metodo_pago text,stripe_account_id text,mp_access_token text,mp_public_key text,pago_manual_instrucciones text,whatsapp text,email_contacto text,cantidad_canchas_solicitadas integer,numero_licencia text,fecha_contrato date,licenciatario_email text,licenciatario_nombre text,licenciatario_pais text,created_by text,tipo_licencia text,ciudad_representa text,provincia_representa text,pais_representa text,organizacion_id uuid);
CREATE TABLE public.organizaciones(id uuid PRIMARY KEY,estado text,limite_sedes int,limite_canchas_total int);
CREATE TABLE public.organizacion_sedes(organizacion_id uuid REFERENCES public.organizaciones(id),sede_id bigint REFERENCES public.sedes(id),PRIMARY KEY(organizacion_id,sede_id));
INSERT INTO public.user_roles(user_id,email,role,alcance) VALUES('${OWNER}','owner@example.invalid','super_admin','global');
INSERT INTO public.sedes_pendientes(id,estado,nombre,pais,ciudad,horario_apertura,horario_cierre,precio_base,moneda,whatsapp,cantidad_canchas_solicitadas,licenciatario_email,created_by) VALUES(7,'pendiente','Club QA','Argentina','La Plata','08:00','23:00',100,'ARS','+540000000000',2,'venue@example.invalid','manager@example.invalid');
`;

async function fixture(){
 const db=new PGlite();await db.exec(fixtureSql);await db.exec(migration);
 // PGlite tiene una sesión: este mutex simula conexiones transaccionales
 // concurrentes sin entrelazar BEGIN/COMMIT. QA real deberá probar locks MVCC.
 let queue=Promise.resolve(),injected=null,afterCommit=false;
 const acquire=async()=>{let release;const ticket=new Promise(r=>release=r),prev=queue;queue=ticket;await prev;return release;};
 const execute=async(sql,args)=>{
  if(injected?.test(sql)){injected=null;throw new Error('SIMULATED_FAILURE');}
  const result=await db.query(sql,args);
  if(afterCommit&&sql==='COMMIT'){afterCommit=false;throw new Error('COMMIT_ACK_LOST');}
  return result;
 };
 const pool={connect:async()=>{const unlock=await acquire();return {query:execute,release:unlock};},query:async(sql,args)=>{const unlock=await acquire();try{return await execute(sql,args);}finally{unlock();}}};
 const service=createSedeApprovalRecovery({pool});
 return {db,pool,service,inject:r=>injected=r,loseCommitAck:()=>afterCommit=true,close:()=>db.close(),counts:async()=>{
  const c={};for(const table of ['sedes','user_roles','organizacion_sedes','sede_approval_operations','sede_approval_outbox'])c[table]=Number((await db.query(`SELECT count(*) AS n FROM public.${table}`)).rows[0].n);
  c.estado=(await db.query('SELECT estado FROM public.sedes_pendientes WHERE id=7')).rows[0].estado;return c;
 }};
}

test('migración bloquea esquema desconocido antes de crear journal',async()=>{
 const db=new PGlite();await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;');
 await assert.rejects(db.exec(migration),e=>e.code==='42P01'&&e.message==='relation \"public.sedes_pendientes\" does not exist');await db.exec('ROLLBACK');
 assert.equal((await db.query("SELECT to_regclass('public.sede_approval_operations') AS x")).rows[0].x,null);await db.close();
});
test('preflight de solo lectura es ejecutable y no altera el estado del fixture',async()=>{
 const f=await fixture();try{const before=await f.counts();const result=await f.db.exec(preflightSql);assert.equal(Number(result.at(-1).rows[0].ambiguous_normalized_email_groups),0);assert.ok(result[0].rows.every(x=>x.check_status!=='MISSING'));assert.deepEqual(await f.counts(),before);}finally{await f.close();}
});
test('aprobación atomiza sede, rol, estado, relación y cinco jobs',async()=>{
 const f=await fixture();try{const r=await f.service.approve({actorId:OWNER,requestId:7});assert.equal(r.ok,true);assert.equal(r.replayed,false);assert.deepEqual(await f.counts(),{sedes:1,user_roles:2,organizacion_sedes:0,sede_approval_operations:1,sede_approval_outbox:5,estado:'aprobada'});
 const role=(await f.db.query("SELECT role,sede_id FROM public.user_roles WHERE email='venue@example.invalid'")).rows[0];assert.equal(role.role,'admin_club');assert.equal(String(role.sede_id),String(r.sede_id));
 const state=await f.service.status({actorId:OWNER,requestId:7});assert.equal(state.jobs.length,5);assert.ok(state.jobs.every(j=>j.state==='pending'));}finally{await f.close();}
});
test('repetición y diez llamadas concurrentes simuladas devuelven la misma sede',async()=>{
 const f=await fixture();try{const results=await Promise.all(Array.from({length:10},()=>f.service.approve({actorId:OWNER,requestId:7})));assert.equal(new Set(results.map(x=>String(x.sede_id))).size,1);assert.equal(results.filter(x=>!x.replayed).length,1);assert.equal((await f.counts()).sedes,1);assert.equal((await f.counts()).sede_approval_outbox,5);}finally{await f.close();}
});
test('confirmación de commit perdida se recupera por journal sin duplicación',async()=>{
 const f=await fixture();try{f.loseCommitAck();await assert.rejects(f.service.approve({actorId:OWNER,requestId:7}),/COMMIT_ACK_LOST/);const r=await f.service.approve({actorId:OWNER,requestId:7});assert.equal(r.replayed,true);assert.equal((await f.counts()).sedes,1);}finally{await f.close();}
});
for(const [label,pattern] of [
 ['sede',/^INSERT INTO public\.sedes /],['rol',/^INSERT INTO public\.user_roles /],
 ['estado',/^UPDATE public\.sedes_pendientes/],['journal',/^INSERT INTO public\.sede_approval_operations/],
 ['outbox',/^INSERT INTO public\.sede_approval_outbox/],['commit antes de aceptar',/^COMMIT$/],
])test(`fallo en ${label} revierte todos los pasos y permite reintento`,async()=>{
 const f=await fixture();try{const before=await f.counts();f.inject(pattern);await assert.rejects(f.service.approve({actorId:OWNER,requestId:7}),/SIMULATED_FAILURE/);assert.deepEqual(await f.counts(),before);await f.service.approve({actorId:OWNER,requestId:7});assert.equal((await f.counts()).sedes,1);}finally{await f.close();}
});
test('rol privilegiado o de otra sede no se reemplaza',async()=>{
 const f=await fixture();try{await f.db.query("INSERT INTO public.user_roles(user_id,email,role,alcance) VALUES($1,'venue@example.invalid','super_admin','global')",[OTHER]);const before=await f.counts();await assert.rejects(f.service.approve({actorId:OWNER,requestId:7}),e=>e.code==='EXISTING_ROLE_CONFLICT');assert.deepEqual(await f.counts(),before);assert.equal((await f.db.query('SELECT role FROM public.user_roles WHERE user_id=$1',[OTHER])).rows[0].role,'super_admin');}finally{await f.close();}
});
test('rol territorial compatible se conserva con identidad y nombre originales',async()=>{
 const f=await fixture();try{await f.db.exec("UPDATE public.sedes_pendientes SET tipo_licencia='master_pais',pais_representa='Argentina' WHERE id=7;");await f.db.query("INSERT INTO public.user_roles(user_id,email,role,alcance,pais,nombre,torneos_oficiales_habilitados) VALUES($1,'venue@example.invalid','admin_nacional','pais','Argentina','Nombre previo',true)",[OTHER]);await f.service.approve({actorId:OWNER,requestId:7});const row=(await f.db.query('SELECT * FROM public.user_roles WHERE user_id=$1',[OTHER])).rows[0];assert.equal(row.nombre,'Nombre previo');assert.equal(row.role,'admin_nacional');assert.equal(row.sede_id,null);const op=(await f.db.query('SELECT role_preserved FROM public.sede_approval_operations')).rows[0];assert.equal(op.role_preserved,true);}finally{await f.close();}
});
test('geografía incompleta y configuración obligatoria ausente no mutan datos',async()=>{
 const f=await fixture();try{await f.db.exec("UPDATE public.sedes_pendientes SET tipo_licencia='master_ciudad',provincia=NULL WHERE id=7;");let before=await f.counts();await assert.rejects(f.service.approve({actorId:OWNER,requestId:7}),e=>e.code==='ADMIN_TERRITORY_INCOMPLETE');assert.deepEqual(await f.counts(),before);await f.db.exec("UPDATE public.sedes_pendientes SET tipo_licencia='club_afiliado',precio_base=NULL WHERE id=7;");await assert.rejects(f.service.approve({actorId:OWNER,requestId:7}),e=>e.code==='SEDE_REQUIRED_CONFIGURATION');assert.deepEqual(await f.counts(),before);}finally{await f.close();}
});
test('creador de cadena conserva admin_cadena y el vínculo se crea en la misma transacción',async()=>{
 const f=await fixture();try{await f.db.query('INSERT INTO public.organizaciones VALUES($1,\'activa\',3,8)',[ORG]);await f.db.query("UPDATE public.sedes_pendientes SET organizacion_id=$1,created_by='venue@example.invalid' WHERE id=7",[ORG]);await f.db.query("INSERT INTO public.user_roles(user_id,email,role,alcance,organizacion_id) VALUES($1,'venue@example.invalid','admin_cadena','organizacion',$2)",[OTHER,ORG]);f.inject(/^INSERT INTO public\.organizacion_sedes/);const before=await f.counts();await assert.rejects(f.service.approve({actorId:OWNER,requestId:7}));assert.deepEqual(await f.counts(),before);await f.service.approve({actorId:OWNER,requestId:7});assert.equal((await f.counts()).organizacion_sedes,1);assert.equal((await f.db.query('SELECT role FROM public.user_roles WHERE user_id=$1',[OTHER])).rows[0].role,'admin_cadena');}finally{await f.close();}
});
test('límite de cadena se verifica dentro de aprobación',async()=>{
 const f=await fixture();try{await f.db.query('INSERT INTO public.organizaciones VALUES($1,\'activa\',0,0)',[ORG]);await f.db.query('UPDATE public.sedes_pendientes SET organizacion_id=$1 WHERE id=7',[ORG]);const before=await f.counts();await assert.rejects(f.service.approve({actorId:OWNER,requestId:7}),e=>e.code==='ORGANIZATION_LIMIT_EXCEEDED');assert.deepEqual(await f.counts(),before);}finally{await f.close();}
});
test('solicitudes duplicadas de un mismo club no crean dos sedes',async()=>{
 const f=await fixture();try{await f.db.exec("INSERT INTO public.sedes_pendientes SELECT 8,estado,nombre,pais,ciudad,provincia,direccion,timezone,latitud,longitud,horario_apertura,horario_cierre,precio_base,moneda,metodo_pago,stripe_account_id,mp_access_token,mp_public_key,pago_manual_instrucciones,whatsapp,email_contacto,cantidad_canchas_solicitadas,numero_licencia,fecha_contrato,'second@example.invalid',licenciatario_nombre,licenciatario_pais,created_by,tipo_licencia,ciudad_representa,provincia_representa,pais_representa,organizacion_id FROM public.sedes_pendientes WHERE id=7;");await f.service.approve({actorId:OWNER,requestId:7});await assert.rejects(f.service.approve({actorId:OWNER,requestId:8}),e=>e.code==='POSSIBLE_LEGACY_PARTIAL_APPROVAL');assert.equal((await f.counts()).sedes,1);}finally{await f.close();}
});
test('recuperación legacy necesita selección explícita y conserva sede/rol existentes',async()=>{
 const f=await fixture();try{await f.db.exec("INSERT INTO public.sedes(nombre,pais,ciudad) VALUES('Club QA','Argentina','La Plata');");await f.db.query("INSERT INTO public.user_roles(user_id,email,role,alcance,sede_id,pais) VALUES($1,'venue@example.invalid','admin_club','sede',1,'Argentina')",[OTHER]);await assert.rejects(f.service.approve({actorId:OWNER,requestId:7}),e=>e.code==='EXISTING_ROLE_CONFLICT');const r=await f.service.approve({actorId:OWNER,requestId:7,recoverySedeId:1});assert.equal(r.recovered,true);assert.equal((await f.counts()).sedes,1);assert.equal((await f.counts()).user_roles,2);assert.equal((await f.service.approve({actorId:OWNER,requestId:7,recoverySedeId:1})).replayed,true);await assert.rejects(f.service.approve({actorId:OWNER,requestId:7,recoverySedeId:2}),e=>e.code==='RECOVERY_LINK_CONFLICT');}finally{await f.close();}
});
test('actor sin superadmin no lee estado ni aprueba',async()=>{
 const f=await fixture();try{const before=await f.counts();await assert.rejects(f.service.approve({actorId:OTHER,requestId:7}),e=>e.status===403);await assert.rejects(f.service.status({actorId:OTHER,requestId:7}),e=>e.status===403);assert.deepEqual(await f.counts(),before);}finally{await f.close();}
});
test('outbox entrega una vez lo confirmado y respeta dependencia de bienvenida',async()=>{
 const f=await fixture();try{await f.service.approve({actorId:OWNER,requestId:7});const seen=[];const worker=createSedeApprovalOutboxWorker({pool:f.pool,deliver:async job=>{seen.push(job);return {accepted:true,reference:'provider-qa'};}});for(let i=0;i<6;i++)await worker.runOne();assert.equal(seen.length,5);assert.equal(seen[0].kind,'auth_user');assert.equal(seen[1].kind,'welcome_email');assert.equal(new Set(seen.map(x=>x.idempotencyKey)).size,5);assert.ok((await f.service.status({actorId:OWNER,requestId:7})).jobs.every(x=>x.state==='succeeded'));}finally{await f.close();}
});
test('entrega con resultado ambiguo no se reenvía automáticamente',async()=>{
 const f=await fixture();try{await f.service.approve({actorId:OWNER,requestId:7});let calls=0;const w=createSedeApprovalOutboxWorker({pool:f.pool,deliver:async job=>{calls++;if(job.kind==='welcome_email')throw new Error('timeout-after-provider-may-have-accepted');return {accepted:true};}});for(let i=0;i<8;i++)await w.runOne();assert.equal(calls,5);assert.equal((await f.service.status({actorId:OWNER,requestId:7})).jobs.find(x=>x.kind==='welcome_email').state,'uncertain');assert.equal((await f.counts()).sedes,1);}finally{await f.close();}
});
test('rechazo inequívoco antes de aceptación permite reintento acotado',async()=>{
 const f=await fixture();try{await f.service.approve({actorId:OWNER,requestId:7});let calls=0;const w=createSedeApprovalOutboxWorker({pool:f.pool,deliver:async()=>{calls++;if(calls===1)throw Object.assign(new Error('pre-send rejected'),{safeToRetry:true});return {accepted:true};}});assert.equal((await w.runOne()).state,'retryable');await f.db.exec("UPDATE public.sede_approval_outbox SET next_attempt_at=now()-interval '1 second';");assert.equal((await w.runOne()).state,'succeeded');assert.equal(calls,2);}finally{await f.close();}
});
test('lease vencida de correo pasa a incierta; no produce doble envío',async()=>{
 const f=await fixture();try{await f.service.approve({actorId:OWNER,requestId:7});await f.db.exec("UPDATE public.sede_approval_outbox SET state='succeeded' WHERE kind='auth_user'; UPDATE public.sede_approval_outbox SET state='running',lease_until=now()-interval '1 second' WHERE kind='welcome_email';");const seen=[];const w=createSedeApprovalOutboxWorker({pool:f.pool,deliver:async j=>{seen.push(j.kind);return {accepted:true};}});for(let i=0;i<4;i++)await w.runOne();assert.ok(!seen.includes('welcome_email'));assert.equal((await f.service.status({actorId:OWNER,requestId:7})).jobs.find(x=>x.kind==='welcome_email').state,'uncertain');}finally{await f.close();}
});
test('dos workers concurrentes simulados no reclaman la misma entrega',async()=>{
 const f=await fixture();try{await f.service.approve({actorId:OWNER,requestId:7});const seen=[];const make=()=>createSedeApprovalOutboxWorker({pool:f.pool,deliver:async j=>{seen.push(j.idempotencyKey);return {accepted:true};}});const a=make(),b=make();for(let i=0;i<4;i++)await Promise.all([a.runOne(),b.runOne()]);assert.equal(seen.length,5);assert.equal(new Set(seen).size,5);}finally{await f.close();}
});
test('reconciliación explícita registra evidencia y permite reintento sin repetir sede',async()=>{
 const f=await fixture();try{await f.service.approve({actorId:OWNER,requestId:7});await f.db.exec("UPDATE public.sede_approval_outbox SET state='uncertain' WHERE kind='welcome_email';");await assert.rejects(f.service.reconcileDelivery({actorId:OTHER,requestId:7,kind:'welcome_email',outcome:'confirmed_not_sent',evidenceReference:'QA-provider-review-1'}),e=>e.status===403);const r=await f.service.reconcileDelivery({actorId:OWNER,requestId:7,kind:'welcome_email',outcome:'confirmed_not_sent',evidenceReference:'QA-provider-review-1'});assert.equal(r.state,'pending');const reviews=(await f.db.query('SELECT * FROM public.sede_approval_delivery_reviews')).rows;assert.equal(reviews.length,1);assert.equal(reviews[0].actor_user_id,OWNER);assert.equal((await f.counts()).sedes,1);await assert.rejects(f.service.reconcileDelivery({actorId:OWNER,requestId:7,kind:'welcome_email',outcome:'confirmed_not_sent',evidenceReference:'QA-duplicate'}),e=>e.code==='DELIVERY_NOT_RECONCILABLE');}finally{await f.close();}
});
test('adaptador conserva cuenta Auth existente y nunca cambia su contraseña',async()=>{
 const f=await fixture();try{await f.service.approve({actorId:OWNER,requestId:7});let creates=0,resets=0;const deliver=createSedeApprovalDeliverer({pool:f.pool,runtime:{outboundDeliveryEnabled:true},frontendUrl:'https://qa.example.invalid',supabaseAdmin:{auth:{admin:{createUser:async()=>{creates++;return {error:{code:'email_exists'}};}},resetPasswordForEmail:async()=>{resets++;return {error:null};}}},lookupCreatorWhatsapp:async()=>null,sendWhatsapp:async()=>{throw Error('must not send');}});assert.equal((await deliver({requestId:7,kind:'auth_user'})).reference,'auth:already-exists');assert.equal(creates,1);assert.equal(resets,0);assert.equal((await deliver({requestId:7,kind:'whatsapp_creator'})).skipped,true);}finally{await f.close();}
});
test('runtime deshabilitado no llama Auth, correo ni WhatsApp',async()=>{
 let touched=0;const deliver=createSedeApprovalDeliverer({pool:{query:async()=>{touched++;}},runtime:{outboundDeliveryEnabled:false}});await assert.rejects(deliver({requestId:7,kind:'auth_user'}),e=>e.blocked===true);assert.equal(touched,0);
});
test('tablas de aprobación y outbox no son legibles por rol autenticado',async()=>{
 const f=await fixture();try{await f.db.exec('SET ROLE authenticated');await assert.rejects(f.db.query('SELECT * FROM public.sede_approval_operations'),/permission denied/);await assert.rejects(f.db.query('SELECT * FROM public.sede_approval_outbox'),/permission denied/);await f.db.exec('RESET ROLE');}finally{await f.close();}
});
test('replay informa entregas completadas sin crear jobs nuevos',async()=>{
 const f=await fixture();try{await f.service.approve({actorId:OWNER,requestId:7});await f.db.exec("UPDATE public.sede_approval_outbox SET state='succeeded';");const r=await f.service.approve({actorId:OWNER,requestId:'7'});assert.equal(r.notifications_pending,false);assert.equal(r.replayed,true);assert.equal((await f.counts()).sede_approval_outbox,5);}finally{await f.close();}
});
test('adaptador no considera correo o WhatsApp ambiguos como entregados',async()=>{
 const f=await fixture();try{await f.service.approve({actorId:OWNER,requestId:7});const deliver=createSedeApprovalDeliverer({pool:f.pool,runtime:{outboundDeliveryEnabled:true},frontendUrl:'https://qa.example.invalid',supabaseAdmin:{auth:{resetPasswordForEmail:async()=>({error:{message:'timeout'}})}},lookupCreatorWhatsapp:async()=>null,sendWhatsapp:async()=>({disabled:true})});await assert.rejects(deliver({requestId:7,kind:'welcome_email'}),/WELCOME_DELIVERY_UNCERTAIN/);await assert.rejects(deliver({requestId:7,kind:'whatsapp_license'}),/WHATSAPP_ACK_UNCERTAIN/);}finally{await f.close();}
});
test('lectura de contexto fallida es reintentable antes de contactar proveedores',async()=>{
 const deliver=createSedeApprovalDeliverer({pool:{query:async()=>{throw Error('db unavailable');}},runtime:{outboundDeliveryEnabled:true}});await assert.rejects(deliver({requestId:7,kind:'auth_user'}),e=>e.safeToRetry===true);
});

test('conciliar Auth exige UUID y procedencia, conserva evidencia aparte y permite el evento correcto',async()=>{
 for(const origin of ['created','existing']){
  const f=await fixture();try{
   await f.service.approve({actorId:OWNER,requestId:7});await f.db.exec("UPDATE public.sede_approval_outbox SET state='uncertain' WHERE kind='auth_user'");
   const input={actorId:OWNER,requestId:7,kind:'auth_user',outcome:'confirmed_delivered',evidenceReference:'supabase-audit-123'};
   await assert.rejects(f.service.reconcileDelivery(input),e=>e.code==='AUTH_RECONCILIATION_IDENTITY_REQUIRED');
   assert.equal((await f.db.query('SELECT count(*)::int AS n FROM public.sede_approval_delivery_reviews')).rows[0].n,0);
   await f.service.reconcileDelivery({...input,authUserId:OTHER,authOrigin:origin});
   const receipt=(await f.db.query("SELECT provider_reference FROM public.sede_approval_outbox WHERE kind='auth_user'")).rows[0].provider_reference;
   assert.equal(receipt,origin==='created'?`auth:${OTHER}`:`auth:existing:${OTHER}`);
   assert.equal((await f.db.query('SELECT evidence_reference FROM public.sede_approval_delivery_reviews')).rows[0].evidence_reference,'supabase-audit-123');
   let calls=0;const deliver=createSedeApprovalDeliverer({pool:f.pool,runtime:{outboundDeliveryEnabled:true},sendRegistrationEvent:async()=>{calls++;return {accepted:true};}});
   const result=await deliver({requestId:7,kind:'registration_event'});assert.equal(origin==='created'?result.accepted:result.skipped,true);assert.equal(calls,origin==='created'?1:0);
   await f.db.query("UPDATE public.sedes_pendientes SET licenciatario_email='edited@example.invalid' WHERE id=7");
   assert.equal((await f.service.status({actorId:OWNER,requestId:7})).operation.approved_recipient_email,'venue@example.invalid');
  }finally{await f.close();}
 }
});
test('email existente tras lease Auth incierta exige procedencia y no omite el evento nuevo',async()=>{
 const f=await fixture();try{
  await f.service.approve({actorId:OWNER,requestId:7});
  await f.db.exec("UPDATE public.sede_approval_outbox SET state='skipped' WHERE kind NOT IN ('auth_user','registration_event');UPDATE public.sede_approval_outbox SET state='running',attempts=1,lease_until=now()-interval '1 second' WHERE kind='auth_user'");
  let events=0;const deliver=createSedeApprovalDeliverer({pool:f.pool,runtime:{outboundDeliveryEnabled:true},supabaseAdmin:{auth:{admin:{createUser:async()=>({error:{code:'email_exists'}})}}},sendRegistrationEvent:async()=>{events++;return {accepted:true};}});
  const worker=createSedeApprovalOutboxWorker({pool:f.pool,deliver});assert.equal((await worker.runOne()).state,'blocked');assert.equal(events,0);
  assert.equal((await f.service.status({actorId:OWNER,requestId:7})).jobs.find(j=>j.kind==='registration_event').state,'pending');
  await f.service.reconcileDelivery({actorId:OWNER,requestId:7,kind:'auth_user',outcome:'confirmed_delivered',authUserId:OTHER,authOrigin:'created',evidenceReference:'synthetic-new-auth-audit'});
  assert.equal((await worker.runOne()).state,'succeeded');assert.equal(events,1);
 }finally{await f.close();}
});
test('lease Auth vencida al quinto intento queda incierta y conciliable',async()=>{
 const f=await fixture();try{
  await f.service.approve({actorId:OWNER,requestId:7});await f.db.exec("UPDATE public.sede_approval_outbox SET state='skipped' WHERE kind<>'auth_user';UPDATE public.sede_approval_outbox SET state='running',attempts=5,lease_until=now()-interval '1 second' WHERE kind='auth_user'");
  const worker=createSedeApprovalOutboxWorker({pool:f.pool,deliver:async()=>{throw Error('must not send');}});assert.equal((await worker.runOne()).processed,false);
  assert.equal((await f.service.status({actorId:OWNER,requestId:7})).jobs.find(j=>j.kind==='auth_user').state,'uncertain');
  await f.service.reconcileDelivery({actorId:OWNER,requestId:7,kind:'auth_user',outcome:'confirmed_not_sent',evidenceReference:'synthetic-no-account-created'});
  const job=(await f.service.status({actorId:OWNER,requestId:7})).jobs.find(j=>j.kind==='auth_user');assert.equal(job.state,'pending');assert.equal(job.attempts,0);
 }finally{await f.close();}
});
async function prepareOrganizationRecovery(f,{linked=false}={}){
 await f.db.query('INSERT INTO public.organizaciones VALUES($1,\'activa\',0,0)',[ORG]);
 await f.db.exec("INSERT INTO public.sedes(nombre,pais,ciudad,cantidad_canchas) VALUES('Club QA','Argentina','La Plata',3)");
 await f.db.query("INSERT INTO public.user_roles(user_id,email,role,alcance,organizacion_id) VALUES($1,'venue@example.invalid','admin_cadena','organizacion',$2)",[OTHER,ORG]);
 await f.db.query("UPDATE public.sedes_pendientes SET organizacion_id=$1,created_by='venue@example.invalid',cantidad_canchas_solicitadas=1 WHERE id=7",[ORG]);
 if(linked)await f.db.query('INSERT INTO public.organizacion_sedes VALUES($1,1)',[ORG]);
}
test('recuperar nuevo vínculo valida cupo de sedes y canchas reales, con rollback completo',async()=>{
 const f=await fixture();try{
  await prepareOrganizationRecovery(f);const before=await f.counts();const input={actorId:OWNER,requestId:7,recoverySedeId:1};
  await assert.rejects(f.service.approve(input),e=>e.code==='ORGANIZATION_LIMIT_EXCEEDED');assert.deepEqual(await f.counts(),before);
  await f.db.exec('UPDATE public.organizaciones SET limite_sedes=1,limite_canchas_total=2');
  await assert.rejects(f.service.approve(input),e=>e.code==='ORGANIZATION_LIMIT_EXCEEDED');assert.deepEqual(await f.counts(),before);
  await f.db.exec('UPDATE public.organizaciones SET limite_canchas_total=3');assert.equal((await f.service.approve(input)).ok,true);assert.equal((await f.counts()).organizacion_sedes,1);
 }finally{await f.close();}
});
test('recuperar vínculo ya existente no consume cupo nuevamente',async()=>{
 const f=await fixture();try{await prepareOrganizationRecovery(f,{linked:true});assert.equal((await f.service.approve({actorId:OWNER,requestId:7,recoverySedeId:1})).ok,true);assert.equal((await f.counts()).organizacion_sedes,1);}finally{await f.close();}
});
test('fallo de lectura del teléfono del creador se reintenta antes de contactar transporte',async()=>{
 const f=await fixture();try{
  await f.service.approve({actorId:OWNER,requestId:7});await f.db.exec("UPDATE public.sede_approval_outbox SET state='skipped' WHERE kind<>'whatsapp_creator'");
  const source=await fs.readFile(new URL('../routes/commercialRelease.js',import.meta.url),'utf8');const start=source.indexOf('async function fetchJugadorWhatsappPorEmail('),end=source.indexOf('\nasync function upsertUserRoleAdminClub',start);
  let failed='returned';const q={select(){return q},eq(){return q},async maybeSingle(){if(failed==='thrown')throw Error('synthetic thrown read failure');return failed?{data:null,error:{message:'synthetic read failure'}}:{data:{whatsapp:'+540000000000'},error:null};}};
  const lookup=vm.runInNewContext('('+source.slice(start,end).trim()+')',{supabase:{from:()=>q}});
  let sends=0;const deliver=createSedeApprovalDeliverer({pool:f.pool,runtime:{outboundDeliveryEnabled:true},lookupCreatorWhatsapp:email=>lookup(email,{strict:true}),sendWhatsapp:async()=>{sends++;return {sid:'synthetic-sid'};}});
  const worker=createSedeApprovalOutboxWorker({pool:f.pool,deliver});assert.equal((await worker.runOne()).state,'retryable');assert.equal(sends,0);
  failed='thrown';await f.db.exec("UPDATE public.sede_approval_outbox SET next_attempt_at=now()-interval '1 second'");assert.equal((await worker.runOne()).state,'retryable');assert.equal(sends,0);
  failed=false;await f.db.exec("UPDATE public.sede_approval_outbox SET next_attempt_at=now()-interval '1 second'");assert.equal((await worker.runOne()).state,'succeeded');assert.equal(sends,1);
 }finally{await f.close();}
});
