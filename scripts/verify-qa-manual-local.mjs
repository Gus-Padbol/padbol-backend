/** Actual localhost HTTP + real disposable PostgreSQL; synthetic auth adapter, no production service. */
import express from 'express';import {execFile} from 'node:child_process';import {promisify} from 'node:util';import assert from 'node:assert/strict';
import {mountQaManualTeamsRoutes} from '../routes/qaManualTeams.js';
const exec=promisify(execFile),docker=['--context','colima','exec','jefe4-calendar-review-20261015','psql','-U','postgres','-d','chivi_manual_20261015','-v','ON_ERROR_STOP=1','-v','VERBOSITY=verbose','-At','-c'];
const actor='11111111-1111-4111-8111-111111111111',foreign='99999999-9999-4999-8999-999999999999';const quote=x=>"'"+String(x).replaceAll("'","''")+"'";
async function sql(text){return (await exec('docker',[...docker,text])).stdout.trim();}
const reset="TRUNCATE public.partidos,public.equipos CASCADE; UPDATE torneos SET estado='abierto' WHERE id=555;";
await sql(reset);
const db={async rpc(name,p){assert.equal(name,'gestionar_dupla_qa');const args=[p.p_torneo_id,quote(p.p_actor_id)+'::uuid',quote(p.p_accion),quote(p.p_nombre),'ARRAY['+p.p_jugadores.map(x=>quote(x)+'::uuid').join(',')+']::uuid[]',p.p_request_id?quote(p.p_request_id)+'::uuid':'NULL'];try{return {data:JSON.parse(await sql('SELECT public.gestionar_dupla_qa('+args.join(',')+');')),error:null};}catch(e){return {data:null,error:{code:e.stderr.match(/ERROR:\s+([A-Z0-9]{5})/)?.[1]||'XX000'}};}}};
const app=express();app.use(express.json());mountQaManualTeamsRoutes(app,{db,getAuthenticatedUser:async req=>({user:req.headers.authorization==='Bearer local-qa'?{id:actor}:req.headers.authorization==='Bearer local-foreign'?{id:foreign}:null,status:401})});const server=app.listen(0,'127.0.0.1');await new Promise(r=>server.on('listening',r));const url='http://127.0.0.1:'+server.address().port+'/api/torneos/555/inscripcion-qa';let checks=0;
async function call(token,body){const res=await fetch(url,{method:body?'POST':'GET',headers:{'Content-Type':'application/json',...(token?{Authorization:'Bearer '+token}:{})},...(body?{body:JSON.stringify(body)}:{})});return {status:res.status,data:await res.json()};}
try{
 assert.equal((await call()).status,401);checks++;
 assert.equal((await call('local-foreign')).status,403);checks++;
 const catalog=await call('local-qa');assert.equal(catalog.data.players.length,8);assert.ok(catalog.data.players.every(p=>!p.inscrito));checks++;
 const ids=catalog.data.players.slice(0,2).map(p=>p.user_id),body={nombre:"QA O'Hare",user_ids:ids,request_id:'44444444-4444-4444-8444-000000009999'};
 const first=await call('local-qa',body);assert.equal(first.status,201);assert.equal(first.data.equipo.jugadores.length,2);checks++;
 const retry=await call('local-qa',body);assert.equal(retry.status,200);assert.equal(retry.data.equipo.id,first.data.equipo.id);checks++;
 const second=await call('local-qa',{...body,request_id:'44444444-4444-4444-8444-000000009998'});assert.equal(second.status,409);checks++;
 const read=await call('local-qa');assert.ok(ids.every(id=>read.data.players.find(p=>p.user_id===id).inscrito));checks++;
 console.log(JSON.stringify({status:'PASS',actual_local_HTTP_checks:checks,storage:'real PostgreSQL16 isolated local database',authentication:'synthetic test adapter; not proof of JWT verification or production deployment'}));
}finally{await new Promise(r=>server.close(r));await sql(reset);}
