import {fileURLToPath} from 'node:url';
const {PGlite}=await import(process.env.PADBOL_PGLITE_MODULE || '@electric-sql/pglite');
import fs from 'node:fs';import assert from 'node:assert/strict';
const root=fileURLToPath(new URL('../../', import.meta.url)).replace(/\/$/,'');
const db=new PGlite();
await db.exec(`create role anon;create role authenticated;create role service_role;
create table crm_conversations(id uuid primary key,contact_id uuid not null,estado text,operador text,updated_at timestamptz);
create table crm_activities(id bigint generated always as identity primary key,contact_id uuid not null,conversation_id uuid not null,activity_type text not null,summary text not null check(summary <> 'FAIL'),outcome text,next_step text,follow_up_at timestamptz,author text);
insert into crm_conversations values('11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222','nuevo',null,now());
grant select,insert,update on crm_conversations,crm_activities to service_role;grant usage,select on all sequences in schema public to service_role;`);
await db.exec(fs.readFileSync(root+'/sql/20261019160000_crm_activity_state_atomic.sql','utf8'));
const base={conversation_id:'11111111-1111-4111-8111-111111111111',contact_id:'22222222-2222-4222-8222-222222222222',activity_type:'note',summary:'QA peer',next_step:'Call',author:'qa@example.invalid'};
const call=(p,s)=>db.query('select crm_register_activity_with_state($1::jsonb,$2::text)',[JSON.stringify(p),s]);
const snapshot=async()=>JSON.stringify((await db.query('select estado,operador,(select count(*)::int from crm_activities) n from crm_conversations')).rows);
await db.exec('set role service_role');await call(base,'cerrado');assert.equal((await db.query('select estado from crm_conversations')).rows[0].estado,'cerrado');
for(const [p,s,label] of [[base,'invalid','invalid'],[{...base,contact_id:'33333333-3333-4333-8333-333333333333'},'nuevo','contact mismatch'],[{...base,contact_id:null},'nuevo','null contact'],[{...base,conversation_id:'44444444-4444-4444-8444-444444444444'},'nuevo','missing conversation'],[{...base,summary:'FAIL'},'nuevo','insert failure']]){const before=await snapshot();await assert.rejects(()=>call(p,s),undefined,label);assert.equal(await snapshot(),before,label+' atomic');}
await db.exec(`reset role;create function reject_state() returns trigger language plpgsql as $$begin if NEW.estado='derivado' then raise exception 'update failed';end if;return NEW;end$$;create trigger reject_state before update on crm_conversations for each row execute function reject_state();set role service_role;`);
const before=await snapshot();await assert.rejects(()=>call(base,'derivado'));assert.equal(await snapshot(),before,'update rollback restores inserted activity');
await db.exec('reset role');for(const role of ['anon','authenticated']){await db.exec('set role '+role);await assert.rejects(()=>call(base,'nuevo'),e=>e.code==='42501');await db.exec('reset role');}
const flags=(await db.query(`select prosecdef,proconfig from pg_proc where proname='crm_register_activity_with_state'`)).rows[0];assert.equal(flags.prosecdef,false);assert.ok(flags.proconfig.includes('search_path=public'));
await db.exec(fs.readFileSync(root+'/sql/20261019160000_crm_activity_state_atomic.rollback.sql','utf8'));assert.equal((await db.query(`select count(*)::int n from pg_proc where proname='crm_register_activity_with_state'`)).rows[0].n,0);assert.equal(await snapshot(),before,'rollback retains data');
console.log('PASS: service role, exact state+note+next step, invalid/null/mismatch/missing, insert/update atomic rollback, anonymous/authenticated denied, invoker+search_path, DDL rollback retains data');await db.close();
