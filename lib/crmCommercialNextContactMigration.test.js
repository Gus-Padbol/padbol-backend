import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
const actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',other='dddddddd-dddd-4ddd-8ddd-dddddddddddd',conv='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',wa='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
test('schedule persists per case with version, actor, pending-summary guards and audit; close clears date',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role service_role;create role anon;create role authenticated;
 create table crm_conversations(id uuid primary key,source_channel text,origin text);
 create table crm_commercial_advisors(user_id uuid primary key);
 create table crm_commercial_cases(id uuid primary key,conversation_id uuid,assigned_user_id uuid,assignment_version bigint default 0,status text default 'open',progress_state text default 'nuevo',commercial_next_step text);
 create table crm_commercial_form_cases(conversation_id uuid primary key,assigned_user_id uuid,assignment_version bigint default 0,progress_state text default 'nuevo',commercial_next_step text);
 create table crm_commercial_team_calls(conversation_id uuid,status text);
 create table crm_replies(conversation_id uuid,status text);
 create table crm_commercial_case_send_attempts(case_id uuid,status text);
 create table crm_commercial_form_send_attempts(conversation_id uuid,status text);
 create table crm_commercial_team_audit(actor_id uuid,action text,subject_id uuid,details jsonb);
 create function crm_commercial_team_case_allowed(uuid,boolean,uuid) returns boolean language sql as 'select $1 is not null and ($2 or $1=$3)';
 create function crm_commercial_form_is_allowed(uuid) returns boolean language sql as 'select exists(select 1 from crm_conversations where id=$1 and origin=''commercial'')';
 insert into crm_conversations values('${conv}','email','commercial'),('${wa}','whatsapp','whatsapp:1376102838911694');
 insert into crm_commercial_form_cases(conversation_id,assigned_user_id)values('${conv}','${actor}');
 insert into crm_commercial_cases(id,conversation_id,assigned_user_id)values('${wa}','${wa}','${actor}');
 `);
 const original=await readFile('sql/20261024000000_crm_commercial_team_workspace.sql','utf8');const start=original.indexOf('create function public.crm_commercial_team_progress(');const end=original.indexOf('revoke all on function public.crm_commercial_team_progress',start);await db.exec(original.slice(start,end));
 const migration=await readFile('sql/migrations/20261025203000_commercial_next_contact.sql','utf8');await db.exec(migration);await db.exec(migration);
 await db.exec('grant usage on schema public to service_role,anon,authenticated;grant select,insert,update on all tables in schema public to service_role;set role service_role;');
 const schedule=(type,id,version,state,date,who=actor)=>db.query('select public.crm_commercial_team_progress_scheduled($1,false,$2,$3,$4,$5,$6,$7,array[8,24]) value',[who,type,id,version,state,'Llamar',date]);
 const saved=await schedule('form',conv,0,'en_espera','2099-11-01T14:30:00Z');assert.equal(saved.rows[0].value.reminderHours.join(','),'24,8');assert.equal(saved.rows[0].value.version,1);
 const reload=await db.query('select public.crm_commercial_team_schedule_read($1,false,\'form\',$2) value',[actor,conv]);assert.equal(new Date(reload.rows[0].value.nextContactAt).toISOString(),'2099-11-01T14:30:00.000Z');
 await assert.rejects(schedule('form',conv,1,'en_espera','2099-11-02T14:30:00Z',other),/case unavailable/);
 await assert.rejects(schedule('form',conv,0,'en_espera','2099-11-02T14:30:00Z'),/assignment conflict/);
 await assert.rejects(schedule('form',conv,1,'en_espera','2000-01-01T14:30:00Z'),/schedule invalid/);
 await db.query('insert into crm_commercial_team_calls values($1,\'pending\')',[conv]);await assert.rejects(schedule('form',conv,1,'en_espera','2099-11-03T14:30:00Z'),/call summary required/);await db.exec('reset role;delete from crm_commercial_team_calls;set role service_role;');
 await schedule('whatsapp',wa,0,'en_espera','2099-11-05T14:30:00Z');const before=await db.query('select public.crm_commercial_team_schedule_list($1,false) value',[actor]);assert.equal(before.rows[0].value.length,2);
 await schedule('form',conv,1,'cerrado',null);const closed=await db.query('select next_contact_at from crm_commercial_form_cases');assert.equal(closed.rows[0].next_contact_at,null);assert.equal((await db.query('select next_contact_at is not null active from crm_commercial_cases')).rows[0].active,true);
 assert.equal((await db.query("select count(*)::int n from crm_commercial_team_audit where action='next_contact_updated'")).rows[0].n,3);
 const own=await db.query('select public.crm_commercial_team_schedule_list($1,false) value',[other]);assert.deepEqual(own.rows[0].value,[]);
 await db.exec('reset role;set role authenticated;');await assert.rejects(db.query('select public.crm_commercial_team_schedule_list($1,true)',[actor]),/permission denied/);
 }finally{await db.close();}
});
