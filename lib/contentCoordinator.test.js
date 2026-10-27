import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
const owner='8beebdbe-e1d7-4607-9bb0-9a7d64701408',jp='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',editor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('coordinator scope, verified owner grants, approval and promotion audit without global roles',async()=>{
 const db=new PGlite();try{
 await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key,email text,email_confirmed_at timestamptz);create table user_roles(user_id uuid,role text,nombre text);create schema storage;create table storage.objects(bucket_id text);alter table storage.objects enable row level security;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);insert into auth.users values('${owner}','owner@example.com',now()),('${jp}','jp@example.com',null);insert into user_roles(user_id,role) values('${owner}','super_admin'),('${editor}','editor_contenido');create function crm_commercial_owner(uuid,boolean)returns boolean language sql as 'select $1=''${owner}''::uuid and $2';`);
 for(const file of ['20261026010000_content_workspace.sql','20261026060000_content_coordinators.sql'])await db.exec(await readFile(new URL('../sql/migrations/'+file,import.meta.url),'utf8'));
 const grant=(actor,email)=>db.query('select content_workspace_coordinator_grant($1,$2,true) r',[actor,email]);
 await assert.rejects(grant(editor,'jp@example.com'),/FORBIDDEN/);await assert.rejects(grant(owner,'jp@example.com'),/IDENTITY_UNVERIFIED/);
 await db.query('update auth.users set email_confirmed_at=now() where id=$1',[jp]);await grant(owner,'jp@example.com');assert.equal((await db.query('select content_workspace_coordinator_access($1) r',[jp])).rows[0].r,true);
 assert.equal((await db.query('select count(*) n from user_roles where user_id=$1',[jp])).rows[0].n,0);
 const call=async(actor,approve,op,id=null,version=null,patch={})=>(await db.query('select content_workspace_command($1,$2,$3,$4,$5,$6) r',[actor,approve,op,id,version,JSON.stringify(patch)])).rows[0].r;
 let item=(await call(editor,false,'create',null,null,{title:'Entrega',assetUrl:'https://example.com/final.mp4',status:'revision'})).item;
 await assert.rejects(call(editor,true,'update',item.id,item.version,{status:'aprobado'}),/FORBIDDEN/);
 item=(await call(jp,true,'update',item.id,item.version,{status:'aprobado',reviewNote:'Revisado'})).item;assert.equal(item.reviewedBy,jp);assert.ok(item.reviewedAt);
 await assert.rejects(call(editor,false,'promotion',item.id,item.version,{decision:'promocionar',note:'Forzado'}),/FORBIDDEN/);
 item=(await call(jp,true,'promotion',item.id,item.version,{decision:'promocionar',note:'Pauta a evaluar aparte'})).item;assert.equal(item.promotionDecision,'promocionar');assert.equal(item.promotionDecidedBy,jp);
 await assert.rejects(call(editor,false,'update',item.id,item.version,{promotionDecision:'organico'}),/FORBIDDEN/);
 const read=await call(jp,true,'read',item.id);assert.equal(read.history[0].action,'promotion_decided');await db.query('select content_workspace_file_add($1,false,$2,$3,$4,$5,$6,$7)',[editor,item.id,'cccccccc-cccc-4ccc-8ccc-cccccccccccc','nuevo.mp4','video/mp4',100,item.id+'/cccccccc-cccc-4ccc-8ccc-cccccccccccc']);const revised=(await call(jp,true,'read',item.id)).item;assert.equal(revised.status,'revision');assert.equal(revised.promotionDecision,'sin_decidir');assert.equal(revised.reviewedBy,undefined);await assert.rejects(call(jp,true,'promotion',item.id,revised.version,{decision:'promocionar',note:''}),/INVALID/);
 await db.query('select content_workspace_coordinator_grant($1,$2,false)',[owner,'jp@example.com']);await assert.rejects(call(jp,true,'read',item.id),/NOT_FOUND/);
 await db.exec('set role authenticated');await assert.rejects(db.query('select content_workspace_coordinator_grant($1,$2,true)',[owner,'jp@example.com']),/permission denied/);await assert.rejects(db.exec('select * from content_workspace_coordinators'),/permission denied/);
 }finally{await db.close();}
});
