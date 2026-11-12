// Real SQL/ACL behavior on local PGlite, no hosted database or provider.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';
const sql=await readFile(new URL('../sql/migrations/20261111200000_crm_welcome_ledger.sql',import.meta.url),'utf8');
async function dbFixture(){const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create table crm_contacts(id uuid primary key);insert into crm_contacts values('11111111-1111-4111-8111-111111111111');`);return db;}
const aclSql=`select coalesce(r.rolname,'PUBLIC') as role,a.privilege_type,a.is_grantable from pg_class c cross join lateral aclexplode(coalesce(c.relacl,acldefault('r',c.relowner))) a left join pg_roles r on r.oid=a.grantee where c.oid='public.crm_welcome_ledger'::regclass order by role,privilege_type`;
async function preserved(db){return {defaults:(await db.query('select defaclrole,defaclnamespace,defaclobjtype,defaclacl::text from pg_default_acl order by oid')).rows,contacts:(await db.query('select * from crm_contacts order by id')).rows};}

test('fresh migration resets inherited ALL only on new ledger; exact service SIU and no public/anon/auth privileges',async()=>{
 const db=await dbFixture();try{
  await db.exec('alter default privileges in schema public grant all on tables to service_role,anon,authenticated,public;create table existing_unrelated(id integer);');
  const before=await preserved(db);const otherBefore=(await db.query("select relacl::text from pg_class where oid='existing_unrelated'::regclass")).rows;
  await db.exec(sql);
  const a=(await db.query(aclSql)).rows;
  assert.deepEqual(a.filter(x=>x.role==='service_role').map(x=>x.privilege_type),['INSERT','SELECT','UPDATE']);
  assert.ok(a.filter(x=>x.role==='service_role').every(x=>x.is_grantable===false));
  assert.equal(a.some(x=>['PUBLIC','anon','authenticated'].includes(x.role)),false);
  for(const role of ['anon','authenticated'])assert.equal((await db.query(`select has_table_privilege('${role}','public.crm_welcome_ledger','SELECT') as allowed`)).rows[0].allowed,false);
  const meta=(await db.query("select pg_get_userbyid(relowner) as owner,relrowsecurity from pg_class where oid='crm_welcome_ledger'::regclass")).rows[0];
  assert.deepEqual(meta,{owner:'postgres',relrowsecurity:true});
  assert.equal((await db.query("select count(*)::int n from pg_policy where polrelid='crm_welcome_ledger'::regclass")).rows[0].n,0);
  assert.deepEqual(await preserved(db),before);
  assert.deepEqual((await db.query("select relacl::text from pg_class where oid='existing_unrelated'::regclass")).rows,otherBefore);
  assert.equal((await db.query('select count(*)::int n from crm_welcome_ledger')).rows[0].n,0);
 }finally{await db.close();}
});

test('existing drift aborts entire migration before touching row/schema/owner/RLS/ACL/comment/defaults',async()=>{
 const db=await dbFixture();try{
  await db.exec("create table crm_welcome_ledger(preserve text);insert into crm_welcome_ledger values('keep-existing-evidence');grant all on crm_welcome_ledger to anon;comment on table crm_welcome_ledger is 'keep-existing-comment';");
  async function snapshot(){return {global:await preserved(db),rows:(await db.query('select * from crm_welcome_ledger')).rows,acl:(await db.query(aclSql)).rows,meta:(await db.query("select relowner,relrowsecurity,obj_description(oid) as comment from pg_class where oid='crm_welcome_ledger'::regclass")).rows,columns:(await db.query("select column_name,data_type from information_schema.columns where table_name='crm_welcome_ledger' order by ordinal_position")).rows};}
  const before=await snapshot();await assert.rejects(db.exec(sql),e=>e.code==='P0001'&&e.message.includes('WELCOME_LEDGER_ALREADY_EXISTS_REVIEW_REQUIRED'));await db.exec('rollback');assert.deepEqual(await snapshot(),before);
 }finally{await db.close();}
});

test('reapplying to an existing correct ledger aborts and preserves claimed evidence',async()=>{
 const db=await dbFixture();try{
  await db.exec(sql);await db.query("insert into crm_welcome_ledger(contact_id,purpose,provider_key) values('11111111-1111-4111-8111-111111111111','welcome','fixture-key')");
  const before=(await db.query('select * from crm_welcome_ledger')).rows;
  await assert.rejects(db.exec(sql),e=>e.message.includes('WELCOME_LEDGER_ALREADY_EXISTS_REVIEW_REQUIRED'));await db.exec('rollback');assert.deepEqual((await db.query('select * from crm_welcome_ledger')).rows,before);
 }finally{await db.close();}
});
