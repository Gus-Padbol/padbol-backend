import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {PGlite} from '@electric-sql/pglite';
import {registerCrmSpaceTicketRoutes} from './crmSpaceTicketRoutes.js';
import {registerCrmSpaceAdminRoutes} from './crmSpaceAdminRoutes.js';

const actor='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const conversation='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const request='cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const assignee='dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const deferred=()=>{let resolve;const promise=new Promise(r=>{resolve=r;});return {promise,resolve};};

async function fixture({assigned=true,render=false,status='recibida',storageError=false}={}){
 const pg=new PGlite();
 await pg.exec(`
  create schema auth;
  create table auth.users(id uuid primary key,email text);
  create table crm_conversations(id uuid primary key,origin text,qualification_data jsonb,operador text,derivado boolean,contact_id uuid,test_hidden_at timestamptz,email_return_linked_to uuid,estado text,updated_at timestamptz);
  create table crm_space_requests(id uuid primary key,conversation_id uuid,length_m numeric,width_m numeric,covered boolean,height_m numeric,desired_courts int,files jsonb,simulation_path text,status text,media_deleted_at timestamptz,created_at timestamptz default now(),updated_at timestamptz);
  create table crm_commercial_form_cases(conversation_id uuid primary key,assigned_user_id uuid,assignment_version bigint,progress_state text,commercial_next_step text,management jsonb);
  create table crm_replies(conversation_id uuid,status text);
  create table crm_activities(id bigint generated always as identity,contact_id uuid,conversation_id uuid,activity_type text,summary text,author text);
  create function crm_commercial_form_is_allowed(uuid)returns boolean language sql as 'select true';
 `);
 await pg.query('insert into auth.users values($1,$2)',[assignee,'configured-advisor@example.invalid']);
 await pg.query("insert into crm_conversations values($1,'codex_internal_space_test',$2,'Operador existente',true,$3,null,null,'en_atencion',now())",[conversation,JSON.stringify({keep:{value:'preserved'},space:{testComplements:['bar']}}),actor]);
 await pg.query('insert into crm_space_requests(id,conversation_id,length_m,width_m,covered,height_m,desired_courts,files,simulation_path,status,updated_at)values($1,$2,30,16,true,6.5,4,$3,$4,$5,$6)',[request,conversation,'[]',render?'simulations/existing.png':null,status,'2026-01-01T00:00:00.000Z']);
 if(assigned)await pg.query("insert into crm_commercial_form_cases values($1,$2,4,'en_atencion','Próximo paso existente',$3)",[conversation,assignee,JSON.stringify({agenda:'existing',note:'preserved'})]);
 const errors=[],removed=[],uploaded=[];let storageGate=null;
 const query=async(sql,args)=>{try{return await pg.query(sql,args);}catch(e){errors.push({message:e.message,sql});throw e;}};
 const pool={query,connect:async()=>({query,release(){}})};
 const db={rpc:async()=>({data:'manager',error:null}),storage:{from:()=>({
  upload:async(path)=>{uploaded.push(path);const gate=storageGate;storageGate=null;if(gate){gate.entered.resolve();await gate.continue.promise;}return {error:storageError?{message:'Synthetic upload failure'}:null};},
  remove:async(paths)=>{removed.push(...paths);return {error:null};},
  createSignedUrl:async()=>({data:{signedUrl:'https://synthetic.invalid/render'},error:null})
 })}};
 const deps={db,pool,authUserFromBearer:async()=>({id:actor,email:'manager@example.invalid',email_confirmed_at:'2026-01-01'}),resolveTrustedSuperadmin:async()=>false,logger:{error(){}}};
 const app=express();app.use(express.json());registerCrmSpaceTicketRoutes(app,deps);registerCrmSpaceAdminRoutes(app,deps);
 const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));const base='http://127.0.0.1:'+server.address().port;
 async function json(path,method='GET',body){const response=await fetch(base+path,{method,...(body?{headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}:{})});return {status:response.status,data:await response.json()};}
 const endpoint=`/api/admin/crm/space-requests/${request}`;
 return {pg,errors,removed,uploaded,json,endpoint,
  current:async()=>{const result=await json(`/api/admin/crm/space-requests/by-conversation/${conversation}`);assert.equal(result.status,200,JSON.stringify({result,errors}));assert.equal(typeof result.data.request.reviewVersion,'string');return result.data.request;},
  prepare:(version)=>json(endpoint+'/prepare-review','POST',{expectedAssignmentVersion:assigned?4:null,expectedReviewVersion:version,testComplements:['bar']}),
  status:(status,version)=>json(endpoint+'/status','PATCH',{status,expectedReviewVersion:version}),
  sent:(version)=>json(endpoint+'/mark-sent','POST',{expectedReviewVersion:version}),
  upload:(version)=>{const body=new FormData();body.set('expectedReviewVersion',version);body.set('simulation',new Blob(['synthetic-file'],{type:'image/png'}),'synthetic.png');return fetch(base+endpoint+'/simulation',{method:'POST',body}).then(async r=>({status:r.status,data:await r.json()}));},
  blockUpload:()=>{storageGate={entered:deferred(),continue:deferred()};return storageGate;},
  ownership:async()=>({conversation:(await pg.query('select operador,derivado,estado,qualification_data from crm_conversations')).rows,management:(await pg.query('select * from crm_commercial_form_cases')).rows}),
  close:async()=>{await new Promise(r=>server.close(r));await pg.close();}
 };
}

test('preparation retry with old review version is idempotent and preserves configured commercial management',async()=>{
 const f=await fixture();try{const before=await f.ownership(),initial=await f.current();
 const first=await f.prepare(initial.reviewVersion);assert.equal(first.status,200,JSON.stringify({first,errors:f.errors}));
 const retry=await f.prepare(initial.reviewVersion);assert.equal(retry.status,200,JSON.stringify({retry,errors:f.errors}));assert.equal(retry.data.idempotent,true);
 assert.equal((await f.pg.query('select count(*)::int n from crm_activities')).rows[0].n,1);
 assert.deepEqual(await f.ownership(),before);assert.equal((await f.current()).status,'en_preparacion');
 }finally{await f.close();}
});

test('preparation does not invent an assignment when no commercial case exists',async()=>{
 const f=await fixture({assigned:false});try{const before=await f.ownership(),initial=await f.current();const result=await f.prepare(initial.reviewVersion);assert.equal(result.status,200,JSON.stringify({result,errors:f.errors}));assert.equal(result.data.assignedUserId,null);assert.deepEqual(await f.ownership(),before);assert.equal((await f.pg.query('select count(*)::int n from crm_commercial_form_cases')).rows[0].n,0);}finally{await f.close();}
});

test('two explicit status changes with the same version have only one winner and sent is terminal',async()=>{
 const f=await fixture({render:true});try{const initial=await f.current();const results=await Promise.all([f.status('en_evaluacion',initial.reviewVersion),f.status('en_preparacion',initial.reviewVersion)]);assert.deepEqual(results.map(r=>r.status).sort(),[200,409],JSON.stringify({results,errors:f.errors}));
 const current=await f.current();const sent=await f.sent(current.reviewVersion);assert.equal(sent.status,200,JSON.stringify(sent));
 assert.equal((await f.status('en_preparacion',initial.reviewVersion)).status,409);
 const final=await f.current();assert.equal(final.status,'enviada');assert.equal((await f.status('en_evaluacion',final.reviewVersion)).status,409);assert.equal((await f.current()).status,'enviada');
 }finally{await f.close();}
});

test('upload racing a status change is rejected and cleans only its newly uploaded file',async()=>{
 const f=await fixture({render:true});let gate,upload;try{const initial=await f.current();gate=f.blockUpload();upload=f.upload(initial.reviewVersion);await Promise.race([gate.entered.promise,upload.then(result=>{throw Error('Upload ended before storage gate: '+JSON.stringify({result,errors:f.errors}));})]);
 const status=await f.status('en_evaluacion',initial.reviewVersion);assert.equal(status.status,200,JSON.stringify(status));gate.continue.resolve();const result=await upload;assert.equal(result.status,409,JSON.stringify({result,errors:f.errors}));
 assert.deepEqual(f.removed,f.uploaded);assert.equal(f.removed.length,1);const row=(await f.pg.query('select status,simulation_path from crm_space_requests')).rows[0];assert.deepEqual(row,{status:'en_evaluacion',simulation_path:'simulations/existing.png'});
 }finally{gate?.continue.resolve();if(upload)await upload.catch(()=>{});await f.close();}
});

test('attaching a file preserves review state and cannot overwrite a sent review',async()=>{
 const f=await fixture({status:'en_evaluacion'});try{const initial=await f.current();const uploaded=await f.upload(initial.reviewVersion);assert.equal(uploaded.status,201,JSON.stringify({uploaded,errors:f.errors}));const attached=await f.current();assert.equal(attached.status,'en_evaluacion');assert.equal(attached.simulationAvailable,true);
 const sent=await f.sent(attached.reviewVersion);assert.equal(sent.status,200,JSON.stringify(sent));const before=(await f.pg.query('select status,simulation_path from crm_space_requests')).rows[0];const terminal=await f.current();const denied=await f.upload(terminal.reviewVersion);assert.equal(denied.status,409,JSON.stringify(denied));assert.deepEqual((await f.pg.query('select status,simulation_path from crm_space_requests')).rows[0],before);
 }finally{await f.close();}
});

test('stale assignment and pending reply leave review and commercial data unchanged',async()=>{
 for(const scenario of ['assignment','pending']){const f=await fixture();try{
  const initial=await f.current();if(scenario==='assignment')await f.pg.query('update crm_commercial_form_cases set assignment_version=5');else await f.pg.query("insert into crm_replies values($1,'pending')",[conversation]);
  const before=await f.ownership(),result=await f.prepare(initial.reviewVersion);assert.equal(result.status,409,JSON.stringify({scenario,result,errors:f.errors}));assert.deepEqual(await f.ownership(),before);assert.equal((await f.current()).status,'recibida');assert.equal((await f.pg.query('select count(*)::int n from crm_activities')).rows[0].n,0);
 }finally{await f.close();}}
});


test('concurrent uploads use distinct object paths even within one millisecond',async()=>{
 const f=await fixture({render:true});const originalNow=Date.now;
 try{const initial=await f.current();Date.now=()=>1793912400000;
  const results=await Promise.all([f.upload(initial.reviewVersion),f.upload(initial.reviewVersion)]);assert.deepEqual(results.map(r=>r.status).sort(),[201,409],JSON.stringify({results,errors:f.errors}));
  assert.equal(new Set(f.uploaded).size,2,'Concurrent uploads must not share a storage object path');
  const stored=(await f.pg.query('select simulation_path from crm_space_requests')).rows[0].simulation_path;assert.equal(f.removed.includes(stored),false,'Losing upload must not remove the winning upload object');
 }finally{Date.now=originalNow;await f.close();}
});

test('failed storage upload does not remove an object it did not create',async()=>{
 const f=await fixture({render:true,storageError:true});try{const initial=await f.current(),result=await f.upload(initial.reviewVersion);assert.equal(result.status,503);assert.deepEqual(f.removed,[]);assert.deepEqual((await f.pg.query('select status,simulation_path from crm_space_requests')).rows[0],{status:'recibida',simulation_path:'simulations/existing.png'});}finally{await f.close();}
});
