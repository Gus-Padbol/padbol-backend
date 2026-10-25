import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const signatures=['crm_commercial_team_manage(uuid,boolean)','crm_commercial_advisor_add(uuid,boolean,text)','crm_commercial_team_role(uuid,boolean)','crm_commercial_team_case_allowed(uuid,boolean,uuid)','crm_commercial_team_advisors_list(uuid,boolean)','crm_commercial_team_claim_reply(uuid,uuid,boolean,uuid,text)','crm_commercial_team_form_claim_reply(uuid,boolean,uuid,uuid,text)'];
test('scoped definers permit server identity validation without granting auth table access',async()=>{
 const db=new PGlite();
 try {
  await db.exec('create role service_role; create role anon; create role authenticated; create schema auth; grant usage on schema public,auth to service_role,anon,authenticated; create table auth.users(id uuid); insert into auth.users values (gen_random_uuid()); revoke all on auth.users from public,service_role,anon,authenticated;');
  for(const f of signatures)await db.exec(`create function public.${f} returns integer language sql set search_path=pg_catalog,public as 'select count(*)::int from auth.users';`);
  await db.exec('set role service_role');
  await assert.rejects(db.query("select public.crm_commercial_team_manage(null,true)"),/permission denied/);
  await db.exec('reset role');
  const migration=await readFile('sql/migrations/20261025190000_commercial_identity_function_scope.sql','utf8');await db.exec(migration);await db.exec(migration);
  for(const f of signatures){const r=await db.query(`select prosecdef,proconfig,pg_get_userbyid(proowner) owner from pg_proc where oid='public.${f}'::regprocedure`);assert.equal(r.rows[0].prosecdef,true);assert.equal(r.rows[0].owner,'postgres');assert.deepEqual(r.rows[0].proconfig,['search_path=pg_catalog, public']);}
  await db.exec('set role service_role');
  assert.equal((await db.query('select public.crm_commercial_team_manage(null,true) value')).rows[0].value,1);
  await assert.rejects(db.query('select * from auth.users'),/permission denied/);
  await db.exec('reset role');
  for(const role of ['anon','authenticated']){await db.exec(`set role ${role}`);await assert.rejects(db.query('select public.crm_commercial_team_manage(null,true)'),/permission denied/);await assert.rejects(db.query('select * from auth.users'),/permission denied/);await db.exec('reset role');}
 }finally{await db.close();}
});
