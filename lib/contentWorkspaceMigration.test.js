import {test} from 'node:test';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';import {PGlite} from '@electric-sql/pglite';
const actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
test('content workspace real SQL version, approvals, audit and RLS',async()=>{
 const db=new PGlite();try{
 await db.exec('create role anon;create role authenticated;create role service_role;create table public.user_roles(user_id uuid,role text);create schema storage;create table storage.objects(bucket_id text);alter table storage.objects enable row level security;create table storage.buckets(id text primary key,name text,public boolean,file_size_limit bigint,allowed_mime_types text[]);');await db.exec(await readFile(new URL('../sql/migrations/20261026010000_content_workspace.sql',import.meta.url),'utf8'));
 const call=async(op,id=null,version=null,patch={},approve=false)=>(await db.query('select public.content_workspace_command($1,$2,$3,$4,$5,$6) as result',[actor,approve,op,id,version,JSON.stringify(patch)])).rows[0].result;
 const created=(await call('create',null,null,{title:'Match video'})).item;assert.equal(created.version,1);
 const id=created.id;
 const stranger='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';await db.query('insert into public.user_roles values($1,$2)',[stranger,'editor_contenido']);
 assert.equal((await db.query('select public.content_workspace_command($1,false,$2) result',[stranger,'list'])).rows[0].result.items.length,0);
 await assert.rejects(db.query('select public.content_workspace_command($1,false,$2,$3) result',[stranger,'read',id]),/NOT_FOUND/);
 await assert.rejects(call('update',id,1,{assignedUserId:stranger}),/FORBIDDEN/);
 await assert.rejects(call('update',id,1,{reviewNote:'fake approval'}),/FORBIDDEN/);

 await assert.rejects(call('update',id,1,{status:'aprobado',assetUrl:'https://example.com/video.mp4'}),/FORBIDDEN/);
 await assert.rejects(call('update',id,1,{status:'publicado',publicationUrl:'https://example.com/post'}),/INVALID/);
 const ready=(await call('update',id,1,{status:'revision',assetUrl:'https://example.com/video.mp4'})).item;assert.equal(ready.version,2);
 await assert.rejects(call('update',id,1,{title:'lost update'}),/VERSION_CONFLICT/);
 const approved=(await call('update',id,2,{status:'aprobado' },true)).item;assert.equal(approved.version,3);
 await assert.rejects(call('update',id,3,{title:'changed silently'}),/FORBIDDEN/);
 const published=(await call('update',id,3,{status:'publicado',publicationUrl:'https://example.com/post',publishedAt:'2026-10-25T15:00:00Z',channel:'Instagram',profile:'padbol'})).item;assert.equal(published.version,4);
 const read=await call('read',id);assert.equal(read.history.length,4);assert.equal(read.history.at(-1).snapshot.title,'Match video');
 await assert.rejects(db.exec(`delete from public.content_workspace_items where id='${id}'`),/IMMUTABLE/);await assert.rejects(db.exec('update public.content_workspace_history set action=\'fake\''),/IMMUTABLE/);
 const concurrent=await Promise.allSettled([call('update',id,4,{status:'preparando'}),call('update',id,4,{status:'preparando'})]);assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);assert.match(concurrent.find(r=>r.status==='rejected').reason.message,/VERSION_CONFLICT/);
 const fileId='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
 await db.query('select public.content_workspace_file_add($1,false,$2,$3,$4,$5,$6,$7)',[actor,id,fileId,'original.mp4','video/mp4',10,id+'/'+fileId]);
 assert.equal((await call('read',id)).files[0].name,'original.mp4');
 await assert.rejects(db.exec('delete from public.content_workspace_files'),/IMMUTABLE/);
 await db.exec("insert into storage.objects values('content-workspace-private'),('other');grant usage on schema storage to authenticated;grant select on storage.objects to authenticated;create policy legacy_all on storage.objects for select to authenticated using(true);");
 await db.exec('set role authenticated');assert.deepEqual((await db.query('select * from storage.objects')).rows,[{bucket_id:'other'}]);await assert.rejects(db.exec('select * from public.content_workspace_items'),/permission denied/);await assert.rejects(call('list'),/permission denied/);
 await db.exec('reset role;set role service_role');assert.equal((await db.query('select count(*) from public.content_workspace_items')).rows[0].count,0); // RLS denies direct service role without bypass in fixture.
 }finally{await db.close();}
});
