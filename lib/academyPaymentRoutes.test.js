import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { ACADEMY_PAYMENT_PRODUCTS,claimAcademyPayments,registerAcademyPaymentRoutes } from './academyPaymentRoutes.js';

const migration=await readFile(new URL('../supabase/migrations/20261105202616_academy_payment_grants.sql',import.meta.url),'utf8');
const id='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const secret='test-inbound-only';
const paid={sessionId:'cs_live_exampleSession',eventId:'evt_exampleEvent',productCode:'coach_jugadores',email:'student@example.com',amountTotal:35000,currency:'usd',paymentStatus:'paid',livemode:true};
async function fixture({confirmed=true,hasUser=true}={}) {
  const pg=new PGlite();
  await pg.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);
    create table public.academy_enrollments(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),course_id integer not null,product_id integer,created_at timestamptz default now(),unique(user_id,course_id));
    alter table public.academy_enrollments enable row level security;
    grant select,insert,update,delete on public.academy_enrollments to service_role;
    grant usage on schema auth to service_role;`);
  if(hasUser)await pg.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,$3)',[id,paid.email,confirmed?'2026-01-01T00:00:00Z':null]);
  await pg.exec(migration);
  const calls=[];
  const db={async rpc(name,args){
    calls.push({name,args});
    const keys=name==='academy_record_payment_grant'?['p_session_id','p_event_id','p_product_code','p_email','p_amount_total','p_currency','p_payment_status','p_livemode']:['p_user_id','p_email'];
    try {const result=await pg.query(`select public.${name}(${keys.map((_,i)=>'$'+(i+1)).join(',')}) as data`,keys.map(key=>args[key]));return {data:result.rows[0].data,error:null};}
    catch(error){return {data:null,error};}
  }};
  return {pg,db,calls,close:()=>pg.close()};
}
async function invoke(db,body=paid,authorization=`Bearer ${secret}`,inboundSecret=secret) {
  let route;
  registerAcademyPaymentRoutes({post(path,handler){assert.equal(path,'/api/inbound/academy/payment');route=handler;}},{db,inboundSecret,logger:{error(){}}});
  const response={statusCode:200,headers:{},set(k,v){this.headers[k]=v;return this;},status(code){this.statusCode=code;return this;},json(value){this.body=value;return this;}};
  await route({headers:{authorization},body},response);
  return response;
}
const count=async(pg,table)=>Number((await pg.query(`select count(*) as n from public.${table}`)).rows[0].n);

test('only the shared server credential can reach payment persistence',async()=>{
  let calls=0;const db={rpc:async()=>{calls++;return {data:{status:'granted'}};}};
  for(const header of ['', 'Bearer wrong', 'Bearer student-user-token', ['Bearer '+secret], 'Basic '+secret])assert.equal((await invoke(db,paid,header)).statusCode,401);
  assert.equal((await invoke(db,paid,'Bearer '+secret,'')).statusCode,503);
  assert.equal(calls,0);
});
test('test mode, unpaid, wrong currency, malformed IDs and unsupported products cannot grant',async()=>{
  let calls=0;const db={rpc:async()=>{calls++;return {data:{status:'granted'}};}};
  for(const patch of [{sessionId:'cs_test_abc'},{eventId:'not-an-event'},{paymentStatus:'unpaid'},{paymentStatus:'no_payment_required'},{livemode:false},{livemode:'true'},{currency:'eur'},{currency:'USD'},{productCode:'__proto__'},{productCode:['coach_jugadores']},{amountTotal:35.5},{email:'bad'},{email:'a@b.com\nextra'}])assert.equal((await invoke(db,{...paid,...patch})).statusCode,400);
  assert.equal(calls,0);
});
test('SQL catalog exactly matches prices and both language variants for every product',async()=>{
  const f=await fixture();try{
    for(const [productCode,product]of Object.entries(ACADEMY_PAYMENT_PRODUCTS)){
      const sql=(await f.pg.query('select * from public.academy_payment_product($1)',[productCode])).rows[0];
      assert.equal(Number(sql.amount),product.amount);assert.deepEqual(sql.course_ids,product.courseIds);
      const response=await invoke(f.db,{...paid,sessionId:'cs_live_'+productCode.replaceAll('_',''),productCode,amountTotal:product.amount});
      assert.equal(response.statusCode,200);assert.equal(response.body.status,'granted');
      for(const course of product.courseIds)assert.equal(Number((await f.pg.query('select count(*) as n from academy_enrollments where user_id=$1 and course_id=$2',[id,course])).rows[0].n),1);
    }
    assert.equal(await count(f.pg,'academy_enrollments'),8);
    assert.equal(await count(f.pg,'academy_payment_grants'),7);
  }finally{await f.close();}
});
test('confirmed account receives two courses atomically; retries and different events do not duplicate',async()=>{
  const f=await fixture();try{
    await f.pg.exec(migration);
    assert.equal((await invoke(f.db,{...paid,email:'Student@Example.com'})).body.status,'granted');
    assert.equal((await invoke(f.db,paid)).body.status,'granted');
    assert.equal((await invoke(f.db,{...paid,eventId:'evt_anotherEvent'})).body.status,'granted');
    assert.equal(await count(f.pg,'academy_enrollments'),2);assert.equal(await count(f.pg,'academy_payment_grants'),1);
    assert.equal((await f.pg.query('select user_id from academy_payment_grants')).rows[0].user_id,id);
    for(const patch of [{email:'someone@example.com'},{productCode:'coach_formador',amountTotal:60000},{amountTotal:35001}])assert.equal((await invoke(f.db,{...paid,...patch})).statusCode,409);
    assert.equal(await count(f.pg,'academy_enrollments'),2);
    assert.equal((await invoke(f.db,{...paid,sessionId:'cs_live_wrongAmount',amountTotal:35001})).statusCode,400);
    assert.equal(await count(f.pg,'academy_payment_grants'),1);
    await f.pg.exec('delete from academy_enrollments where course_id=94439;');
    assert.equal((await invoke(f.db,paid)).body.status,'granted');
    await claimAcademyPayments(f.db,{id,email:paid.email,email_confirmed_at:'2026-01-01'});
    assert.equal(await count(f.pg,'academy_enrollments'),1,'receipt retries cannot undo a later manual revocation');
  }finally{await f.close();}
});
test('unknown account stays pending, then only verified matching identity can claim idempotently',async()=>{
  const f=await fixture({hasUser:false});try{
    assert.deepEqual((await invoke(f.db,paid)).body,{ok:true,status:'pending'});
    assert.equal(await count(f.pg,'academy_enrollments'),0);
    assert.equal((await f.pg.query('select user_id from academy_payment_grants')).rows[0].user_id,null);
    await f.pg.query('insert into auth.users(id,email,email_confirmed_at) values($1,$2,null),($3,$4,now())',[id,paid.email,other,'other@example.com']);
    await assert.rejects(claimAcademyPayments(f.db,{id,email:paid.email}),e=>e.status===403);
    await assert.rejects(claimAcademyPayments(f.db,{id,email:paid.email,email_confirmed_at:'forged-confirmation'}),e=>e.status===403);
    assert.deepEqual(await claimAcademyPayments(f.db,{id:other,email:'other@example.com',email_confirmed_at:'2026-01-01'}),{claimedPayments:0,courseIds:[]});
    await assert.rejects(claimAcademyPayments(f.db,{id:other,email:paid.email,email_confirmed_at:'2026-01-01'}),e=>e.status===403);
    await f.pg.query('update auth.users set email_confirmed_at=now() where id=$1',[id]);
    const user={id,email:paid.email,email_confirmed_at:'2026-01-01'};
    assert.deepEqual(await claimAcademyPayments(f.db,user),{claimedPayments:1,courseIds:[94411,94439]});
    assert.deepEqual(await claimAcademyPayments(f.db,user),{claimedPayments:0,courseIds:[]});assert.equal(await count(f.pg,'academy_enrollments'),2);
  }finally{await f.close();}
});
test('unconfirmed existing account remains pending and enrollment failure rolls back payment consumption',async()=>{
  const f=await fixture({confirmed:false});try{
    assert.equal((await invoke(f.db,paid)).body.status,'pending');
    assert.equal(await count(f.pg,'academy_enrollments'),0);
    await f.pg.query('update auth.users set email_confirmed_at=now() where id=$1',[id]);
    await f.pg.exec("create function deny_second_course() returns trigger language plpgsql as $$begin if new.course_id=94439 then raise exception 'simulated storage failure';end if;return new;end$$;create trigger fail_enrollment before insert on academy_enrollments for each row execute function deny_second_course();");
    assert.equal((await invoke(f.db,paid)).statusCode,503);
    assert.equal(await count(f.pg,'academy_enrollments'),0);
    assert.equal((await f.pg.query('select user_id from academy_payment_grants')).rows[0].user_id,null);
    const user={id,email:paid.email,email_confirmed_at:'2026-01-01'};
    await assert.rejects(claimAcademyPayments(f.db,user),e=>e.status===503);
    assert.equal(await count(f.pg,'academy_enrollments'),0);
    await f.pg.exec('drop trigger fail_enrollment on academy_enrollments;');
    await claimAcademyPayments(f.db,user);assert.equal(await count(f.pg,'academy_enrollments'),2);
  }finally{await f.close();}
});
test('new live payment is not acknowledged or persisted after a partial enrollment failure',async()=>{
  const f=await fixture();try{
    await f.pg.exec("alter table academy_enrollments add constraint simulate_failure check(course_id<>94439);");
    assert.equal((await invoke(f.db,paid)).statusCode,503);
    assert.equal(await count(f.pg,'academy_payment_grants'),0);assert.equal(await count(f.pg,'academy_enrollments'),0);
    await f.pg.exec('alter table academy_enrollments drop constraint simulate_failure;');
    assert.equal((await invoke(f.db,paid)).body.status,'granted');
    assert.equal(await count(f.pg,'academy_payment_grants'),1);assert.equal(await count(f.pg,'academy_enrollments'),2);
  }finally{await f.close();}
});
test('payment rows and all grant RPCs are denied to public clients, allowed to service_role',async()=>{
  const f=await fixture();try{
    for(const role of ['anon','authenticated']){
      await f.pg.exec(`set role ${role};`);
      await assert.rejects(f.pg.exec('select * from public.academy_payment_grants'),e=>e.code==='42501');
      await assert.rejects(f.pg.exec(`select public.academy_claim_payment_grants('${id}','${paid.email}')`),e=>e.code==='42501');
      await assert.rejects(f.pg.exec("select * from public.academy_payment_product('coach_jugadores')"),e=>e.code==='42501');
      const allowed=(await f.pg.query("select has_function_privilege(current_user,'public.academy_record_payment_grant(text,text,text,text,bigint,text,text,boolean)','EXECUTE') as allowed")).rows[0].allowed;
      assert.equal(allowed,false);await f.pg.exec('reset role;');
    }
    await f.pg.exec('set role service_role;');
    assert.equal((await invoke(f.db,paid)).body.status,'granted');
    assert.equal(await count(f.pg,'academy_payment_grants'),1);
  }finally{await f.close();}
});
