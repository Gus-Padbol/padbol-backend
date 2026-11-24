import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import vm from 'node:vm';
import cors from 'cors';
import {once} from 'node:events';
import {createScoreboardLiveRouter} from './scoreboardLive.js';
const A='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',B='bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const C='cccccccc-cccc-4ccc-8ccc-cccccccccccc',D='dddddddd-dddd-4ddd-8ddd-dddddddddddd',E='eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const jpeg=Buffer.from([255,216,12,13,255,217]);
async function fixture(enabled=true){
 let now=1000,reads=0;
 const roles=new Map([['a',{role:'admin_club',sede_id:7}],['b',{role:'admin_club',sede_id:8}],['super',{role:'super_admin'}],['player',{role:'jugador'}]]);
 const boards=new Map([[A,{id:A,sede_id:7}],[B,{id:B,sede_id:8}]]);
 const app=express();
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');
 const literal=source.slice(source.indexOf('// CORS\napp.use(cors(')+ '// CORS\napp.use(cors('.length);
 const options=vm.runInNewContext('('+literal.slice(0,literal.indexOf('}));')+1)+')',{configuredOrigins:[]});
 app.use(cors(options));app.use(express.json());
 // Persistence boundary only for these original HTTP cases; actual PG lock test below.
 const deps={...(enabled==='default'?{}:{enabled}),now:()=>now,getAuthenticatedUser:async req=>{const id=req.get('Authorization')?.replace('Bearer ','');return roles.has(id)?{user:{id}}:{status:401};},
 pgPool:{async connect(){return{async query(sql,args){if(sql.startsWith('SELECT role'))return{rows:roles.has(args[0])?[roles.get(args[0])]:[]};if(sql.startsWith('SELECT id')){reads++;return{rows:boards.has(args[0])?[boards.get(args[0])]:[]};}return{rows:[]};},release(){}};}}};
 app.use('/api/scoreboard/partidos/:id/live',createScoreboardLiveRouter(deps));const server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
 const headers=(actor='a',role='camera',client=C,generation=1,stop=0)=>({Authorization:'Bearer '+actor,'X-Live-Client':client,'X-Live-Generation':String(generation),'X-Live-Stop-Version':String(stop)});
 async function call(path,{board=A,actor='a',role='camera',client=C,generation=1,stop=0,method='POST',body={},binary=false,extraHeaders={}}={}){const response=await fetch(`${base}/api/scoreboard/partidos/${board}/live/${path}${path.includes('?')?'&':'?'}role=${role}`,{method,headers:{...headers(actor,role,client,generation,stop),...extraHeaders,...(method==='POST'?{'Content-Type':binary?'image/jpeg':'application/json'}:{})},...(method==='POST'?{body:binary?body:JSON.stringify(body)}:{})});const bytes=Buffer.from(await response.arrayBuffer());let data;try{data=JSON.parse(bytes);}catch{}return {status:response.status,data,bytes,headers:response.headers};}
 function stream({generation=1,stop=0}={}){let response;const done=new Promise((resolve,reject)=>{const request=http.request(`${base}/api/scoreboard/partidos/${A}/live/frame?role=camera`,{method:'POST',headers:{...headers('a','camera',C,generation,stop),'Content-Type':'image/jpeg'}},r=>{const chunks=[];r.on('data',b=>chunks.push(b));r.on('end',()=>resolve({status:r.statusCode,data:JSON.parse(Buffer.concat(chunks))}));});request.on('error',reject);response=request;request.write(jpeg.subarray(0,3));});return {done,end:()=>response.end(jpeg.subarray(3))};}
 return {call,roles,boards,stream,reads:()=>reads,advance:ms=>{now+=ms;},async stop(){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}};
}
async function withFixture(fn,enabled=true){const f=await fixture(enabled);try{await fn(f);}finally{await f.stop();}}
test('057 default/injected off and real authAccess role/PP rules fail closed',()=>withFixture(async f=>{
 assert.equal((await f.call('start')).status,503);assert.equal(f.reads(),0);
},false));
test('057 actual HTTP private JPEG, per-match isolation and no query/body identity authority',()=>withFixture(async f=>{
 assert.equal((await f.call('start',{actor:'player'})).status,403);
 assert.equal((await f.call('start',{actor:'b'})).status,403);
 const started=await f.call('start');assert.equal(started.status,200);assert.deepEqual(started.data.context,{scoreboardId:A,role:'camera',clientId:C,generation:1});
 assert.equal((await f.call('start',{role:'screen',client:D})).status,200);
 assert.equal((await f.call('frame',{body:jpeg,binary:true})).status,200);
 const frame=await f.call('frame',{role:'screen',client:D,method:'GET'});assert.equal(frame.status,200);assert.deepEqual(frame.bytes,jpeg);assert.equal(frame.headers.get('x-live-board'),A);
 await f.call('start',{board:B,actor:'b',role:'screen',client:E});assert.equal((await f.call('frame',{board:B,actor:'b',role:'screen',client:E,method:'GET'})).status,204);
 assert.equal((await f.call('frame',{role:'camera',method:'GET'})).status,403);
}));
test('057 camera lease rejects second client; old streamed POST cannot affect stop/restart',()=>withFixture(async f=>{
 await f.call('start');assert.equal((await f.call('start',{client:D})).data.code,'LIVE_ROLE_BUSY');
 const before=f.reads(),pending=f.stream();while(f.reads()===before)await new Promise(r=>setTimeout(r,2));
 assert.equal((await f.call('frame',{binary:true,body:jpeg})).data.code,'LIVE_FRAME_BUSY');
 assert.equal((await f.call('stop')).status,200);assert.equal((await f.call('start',{generation:2})).status,200);pending.end();assert.equal((await pending.done).data.code,'LIVE_RUN_STALE');
 await f.call('start',{role:'screen',client:D});assert.equal((await f.call('frame',{role:'screen',client:D,stop:1,method:'GET'})).status,204);
 assert.equal((await f.call('stop',{generation:1,stop:0})).status,409);
 assert.equal((await f.call('frame',{generation:2,stop:1,body:jpeg,binary:true})).status,200);
}));
test('057 revocation or partido PP drift during streamed JPEG prevents commit',()=>withFixture(async f=>{
 await f.call('start');const before=f.reads(),pending=f.stream();while(f.reads()===before)await new Promise(r=>setTimeout(r,2));
 f.roles.set('a',{role:'jugador'});pending.end();assert.equal((await pending.done).status,403);
 f.roles.set('a',{role:'admin_club',sede_id:7});await f.call('start',{role:'screen',client:D});assert.equal((await f.call('frame',{role:'screen',client:D,method:'GET'})).status,204);
 const before2=f.reads(),pending2=f.stream();while(f.reads()===before2)await new Promise(r=>setTimeout(r,2));f.boards.set(A,{id:A,sede_id:8});pending2.end();assert.equal((await pending2.done).status,403);
}));
test('057 negotiation/readyId intact and old pair signals do not reach new receiver',()=>withFixture(async f=>{
 await f.call('start');await f.call('start',{role:'screen',client:D});const body={type:'offer',sdp:'synthetic-sdp',negotiation:'camera:1:1',readyId:'screen:1'};
 await f.call('signal',{body});const first=await f.call('poll',{role:'screen',client:D,method:'GET'});assert.equal(first.data.messages.length,1);assert.equal(first.data.messages[0].negotiation,body.negotiation);assert.equal(first.data.messages[0].readyId,body.readyId);
 for(let i=0;i<40;i++)await f.call('signal',{body});const bounded=await f.call('poll',{role:'screen',client:D,method:'GET'});assert.equal(bounded.data.messages.length,32);
 await f.call('start',{role:'screen',client:D,generation:2});assert.equal((await f.call('poll',{role:'screen',client:D,generation:2,method:'GET'})).data.messages.length,0);
 assert.equal((await f.call('signal',{body:{type:'offer',sdp:'x'.repeat(17000)}})).status,400);
}));
test('057 frame cap, expired lease/idle cleanup, current generation and bounded capacity',()=>withFixture(async f=>{
 await f.call('start');assert.equal((await f.call('frame',{binary:true,body:Buffer.alloc(300001)})).status,413);
 f.advance(12001);assert.equal((await f.call('frame',{binary:true,body:jpeg})).data.code,'LIVE_RUN_STALE');
 await f.call('start',{client:D});f.advance(60001);assert.equal((await f.call('poll',{role:'camera',client:D,method:'GET'})).status,409);
 assert.equal((await f.call('start',{actor:'super'})).status,200);
 for(let i=1;i<=8;i++){const id=`00000000-0000-4000-8000-${String(i).padStart(12,'0')}`;f.boards.set(id,{id,sede_id:7});const result=await f.call('start',{actor:'super',board:id});assert.equal(result.status,i<8?200:503);if(i===8)assert.equal(result.data.code,'LIVE_CAPACITY');}
}));

test('057 real server mount/default-OFF and unchanged-origin CORS expose only context/frame headers',()=>withFixture(async f=>{
 const source=fs.readFileSync(new URL('../server.js',import.meta.url),'utf8');assert.match(source,/app\.use\('\/api\/scoreboard\/partidos\/:id\/live', createScoreboardLiveRouter\(\{pgPool,getAuthenticatedUser\}\)\)/);
 const off=await f.call('start');assert.equal(off.data.code,'LIVE_DISABLED');assert.equal(f.reads(),0);
 const pre=await f.call('start',{method:'OPTIONS',extraHeaders:{Origin:'http://localhost:3000','Access-Control-Request-Method':'POST','Access-Control-Request-Headers':'authorization,x-live-client,x-live-generation,x-live-stop-version'}});assert.equal(pre.status,204);assert.equal(pre.headers.get('access-control-allow-origin'),'http://localhost:3000');assert.match(pre.headers.get('access-control-allow-headers'),/x-live-generation/);
 const denied=await f.call('start',{method:'OPTIONS',extraHeaders:{Origin:'https://unapproved.invalid','Access-Control-Request-Method':'POST'}});assert.notEqual(denied.headers.get('access-control-allow-origin'),'https://unapproved.invalid');assert.notEqual(denied.headers.get('access-control-allow-origin'),'*');
 assert.match(off.headers.get('access-control-expose-headers'),/X-Live-Board/);
},'default'));

// Regression for the former role-read -> awaited board-read window. Real PG17
// user_roles has the captured 13 columns, no invented user_id uniqueness.
test('057 final authority PG role locks close delayed board-read revocation window',async()=>{
 const {default:pg}=await import('pg'),os=await import('node:os'),path=await import('node:path'),net=await import('node:net');
 const {execFileSync}=await import('node:child_process');const dir=fs.mkdtempSync(path.join(os.tmpdir(),'live057-pg-')),data=path.join(dir,'data');
 const portServer=net.createServer();portServer.listen(0,'127.0.0.1');await once(portServer,'listening');const port=portServer.address().port;await new Promise(r=>portServer.close(r));
 const run=(name,args)=>execFileSync('/opt/homebrew/bin/'+name,args,{env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:'pipe',timeout:15000});
 let pool,server,started=false,held,gate,reads=0,authorityPid;
 const wait=async predicate=>{const end=Date.now()+4000;while(!await predicate()){if(Date.now()>end)throw Error('bounded PG lock wait timed out');await new Promise(r=>setTimeout(r,5));}};
 const actor='11111111-1111-4111-8111-111111111111';
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run('pg_ctl',['-D',data,'-l',path.join(dir,'pg.log'),'-o',`-F -h '' -k ${dir} -p ${port}`,'-w','start']);started=true;
  pool=new pg.Pool({host:dir,port,user:'postgres',database:'postgres',max:5,connectionTimeoutMillis:2000,query_timeout:6000});assert.match((await pool.query('SHOW server_version_num')).rows[0].server_version_num,/^17/);
  await pool.query(`CREATE TABLE user_roles(id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,user_id uuid,role text NOT NULL,pais text,sede_id bigint,created_at timestamp DEFAULT now(),email text,nombre text,torneos_oficiales_habilitados boolean DEFAULT false,alcance text DEFAULT 'sede',ciudad text,provincia text,organizacion_id uuid);CREATE TABLE scoreboard_partidos(id uuid PRIMARY KEY,sede_id bigint);`);
  await pool.query("INSERT INTO user_roles(user_id,role,sede_id)VALUES($1,'admin_club',7)",[actor]);await pool.query('INSERT INTO scoreboard_partidos VALUES($1,7)',[A]);
  const pgPool={async connect(){const c=await pool.connect();return {async query(sql,args){if(sql.startsWith('SELECT id')){reads++;if(gate?.at===reads){authorityPid=c.processID;gate.reached=true;gate.arrived();await gate.release;}}return c.query(sql,args);},release(){c.release();}};}};
  const app=express();app.use(express.json());app.use('/api/scoreboard/partidos/:id/live',createScoreboardLiveRouter({enabled:true,pgPool,getAuthenticatedUser:async req=>req.get('Authorization')==='Bearer synthetic057'?{user:{id:actor}}:{status:401}}));server=app.listen(0,'127.0.0.1');await once(server,'listening');const base='http://127.0.0.1:'+server.address().port;
  const call=(route,role='camera',method='POST',body='{}')=>fetch(`${base}/api/scoreboard/partidos/${A}/live/${route}?role=${role}`,{method,headers:{Authorization:'Bearer synthetic057','X-Live-Client':role==='camera'?C:D,'X-Live-Generation':'1','X-Live-Stop-Version':'0','Content-Type':route==='frame'&&method==='POST'?'image/jpeg':'application/json'},...(method==='POST'?{body}:{})});
  assert.equal((await call('start')).status,200);assert.equal((await call('start','screen')).status,200);assert.equal((await call('frame','camera','POST',jpeg)).status,200);
  // Pause final board lookup after its role row is locked. Revocation must wait,
  // rather than commit between the two reads as it did before this correction.
  let arrived,release;const seen=new Promise(r=>arrived=r);gate={at:reads+2,arrived,release:new Promise(r=>release=r)};
  gate.open=release;const pending=call('frame','screen','GET');await wait(()=>gate.reached===true);held=await pool.connect();const revokePid=held.processID;assert.notEqual(revokePid,authorityPid);
  const revocation=held.query("UPDATE user_roles SET role='jugador' WHERE user_id=$1",[actor]);await wait(async()=>{const r=await pool.query('SELECT wait_event_type,pg_blocking_pids(pid) blockers FROM pg_stat_activity WHERE pid=$1',[revokePid]);return r.rows[0]?.wait_event_type==='Lock'&&r.rows[0].blockers.includes(authorityPid);});
  release();const response=await pending;assert.equal(response.status,200);assert.deepEqual(Buffer.from(await response.arrayBuffer()),jpeg);await revocation;held.release();held=null;gate=null;
  assert.equal((await call('frame','screen','GET')).status,403,'next decision must see completed revocation');
  console.log('PG057_AUTH_FIRST '+JSON.stringify({authorityPid,revokePid,lockWait:true,frameDecisionBeforeRevocation:true,next403:true}));
  // If revocation owns the row before authorization, the role SELECT waits and
  // evaluates the committed new role. It may not return the old qualified role.
  await pool.query("UPDATE user_roles SET role='admin_club' WHERE user_id=$1",[actor]);held=await pool.connect();await held.query('BEGIN');await held.query("UPDATE user_roles SET role='jugador' WHERE user_id=$1",[actor]);
  const next=call('frame','screen','GET');await wait(async()=>{const r=await pool.query("SELECT pid FROM pg_stat_activity WHERE wait_event_type='Lock' AND $1=ANY(pg_blocking_pids(pid))",[held.processID]);return r.rowCount>0;});await held.query('COMMIT');held.release();held=null;assert.equal((await next).status,403);
  console.log('PG057_REVOKE_FIRST '+JSON.stringify({waited:true,response403:true}));
 }finally{
  if(gate)gate.open?.();
  if(held){try{await held.query('ROLLBACK');}catch{}held.release();}
  if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}
  if(pool)await pool.end();if(started)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);fs.rmSync(dir,{recursive:true,force:true});console.log('CLEANUP_OWN_LIVE057_PG_SOCKET_CLUSTER');
 }
});
