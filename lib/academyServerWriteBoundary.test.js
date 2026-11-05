import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

const migration = await readFile(new URL('../supabase/migrations/20261105202234_academy_server_write_boundary.sql', import.meta.url),'utf8');
const actor='11111111-1111-4111-8111-111111111111',other='22222222-2222-4222-8222-222222222222';
const tables=['academy_enrollments','academy_progress','academy_quiz_attempts','academy_certificates'];
async function fixture() {
  const db=new PGlite();
  await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;
    create schema auth;create table auth.users(id uuid primary key);
    create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    grant usage on schema auth to anon,authenticated,service_role;
    create table academy_profiles(id uuid primary key references auth.users(id),full_name text,created_at timestamptz not null default now());
    create table academy_enrollments(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),course_id int not null,product_id int,created_at timestamptz not null default now(),unique(user_id,course_id));
    create table academy_progress(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),course_id int not null,lesson_id int,completed_at timestamptz not null default now(),unique(user_id,course_id,lesson_id));
    create table academy_quiz_attempts(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),course_id int not null,quiz_id int not null,score int,total int,passed boolean,created_at timestamptz not null default now());
    create table academy_certificates(id uuid primary key default gen_random_uuid(),user_id uuid not null references auth.users(id),course_id int not null,course_title text,student_name text,certificate_type text not null check(certificate_type in('padbol','fipa')),issued_at timestamptz not null default now(),unique(user_id,course_id));
    insert into auth.users values('${actor}'),('${other}');
    insert into academy_profiles(id,full_name) values('${actor}','Actor'),('${other}','Other');`);
  for(const tbl of tables){
    await db.exec(`alter table ${tbl} enable row level security;grant all on ${tbl} to anon,authenticated,service_role;
      grant insert(user_id),update(user_id),references(user_id) on ${tbl} to public;
      create policy legacy_unrestricted on ${tbl} for all using(true) with check(true);`);
    const extra=tbl==='academy_quiz_attempts'?',quiz_id':tbl==='academy_certificates'?',certificate_type':'';
    const value=tbl==='academy_quiz_attempts'?',1':tbl==='academy_certificates'?",'padbol'":'';
    await db.exec(`insert into ${tbl}(user_id,course_id${extra}) values('${actor}',1${value}),('${other}',1${value});`);
  }
  await db.exec('grant all on academy_profiles to anon,authenticated,service_role;grant update(id) on academy_profiles to public;create policy legacy_profiles_all on academy_profiles for all using(true) with check(true);');
  return db;
}
async function asActor(db){await db.exec(`set role authenticated;select set_config('request.jwt.claim.sub','${actor}',false);`);}
const denied=error=>error.code==='42501';

test('idempotent boundary preserves data and grants owner reads with server-only writes',async()=>{
  const db=await fixture();
  try{
    await db.exec(migration);await db.exec(migration);
    await asActor(db);
    for(const tbl of tables){
      assert.equal((await db.query(`select user_id from ${tbl}`)).rows.length,1);
      assert.equal((await db.query(`select user_id from ${tbl}`)).rows[0].user_id,actor);
      for(const sql of [`insert into ${tbl} default values`,`update ${tbl} set user_id=user_id`,`delete from ${tbl}`,`truncate ${tbl}`]) await assert.rejects(db.exec(sql),denied);
      const grants=(await db.query(`select has_table_privilege('authenticated','${tbl}','TRUNCATE') as truncate,has_column_privilege('authenticated','${tbl}','user_id','INSERT') as insert,has_column_privilege('anon','${tbl}','user_id','UPDATE') as update,has_column_privilege('authenticated','${tbl}','user_id','REFERENCES') as references`)).rows[0];
      assert.deepEqual(grants,{truncate:false,insert:false,update:false,references:false});
    }
    await db.exec(`update academy_profiles set full_name='Updated' where id='${actor}';`);
    assert.equal((await db.query('select full_name from academy_profiles')).rows[0].full_name,'Updated');
    assert.equal((await db.query(`update academy_profiles set full_name='Wrong' where id='${other}' returning id`)).rows.length,0);
    await assert.rejects(db.exec(`update academy_profiles set id='${other}' where id='${actor}'`),denied);
    await assert.rejects(db.exec('truncate academy_profiles'),denied);
    await db.exec('reset role;set role anon;');
    for(const tbl of [...tables,'academy_profiles'])await assert.rejects(db.exec(`select * from ${tbl}`),denied);
    await db.exec('reset role;set role service_role;');
    await db.exec(`insert into academy_enrollments(user_id,course_id) values('${actor}',2);insert into academy_certificates(user_id,course_id,certificate_type) values('${actor}',2,'padbol');`);
    assert.equal((await db.query('select count(*)::int as n from academy_enrollments')).rows[0].n,3);
    assert.equal((await db.query('select count(*)::int as n from academy_certificates')).rows[0].n,3);
    for(const tbl of ['academy_progress','academy_quiz_attempts'])assert.equal((await db.query(`select count(*)::int as n from ${tbl}`)).rows[0].n,2);
  }finally{await db.close();}
});
test('incompatible schema aborts without creating tables or partially changing permissions',async()=>{
  const db=await fixture();
  try{
    await db.exec('alter table academy_progress drop column lesson_id;');
    await assert.rejects(db.exec(migration),/ACADEMY_SCHEMA_INCOMPATIBLE/);
    await db.exec('rollback;');
    assert.equal((await db.query("select has_table_privilege('authenticated','academy_enrollments','TRUNCATE') as allowed")).rows[0].allowed,true);
    assert.equal((await db.query("select count(*)::int as n from information_schema.columns where table_name='academy_progress' and column_name='lesson_id'")).rows[0].n,0);
  }finally{await db.close();}
});
