import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {once} from 'node:events';import express from 'express';import pg from 'pg';
import {registerNextGenerationAdminRoutes} from './nextGenerationAdmin.js';
export const SID='00000000-0000-4000-8000-000000000001',R1='00000000-0000-4000-8000-000000000011',R2='00000000-0000-4000-8000-000000000012';
export const deferred=()=>{let resolve;return{promise:new Promise(r=>resolve=r),resolve:v=>resolve(v)};};
export async function bounded(p,ms=3000){let timer;try{return await Promise.race([p,new Promise((_,reject)=>timer=setTimeout(()=>reject(Error('Fixture barrier timeout')),ms))]);}finally{clearTimeout(timer);}}
export async function start({install=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ng025-')),data=path.join(dir,'data'),port=55496;let running=false,pool,server;
 const run=(name,args)=>execFileSync('/opt/homebrew/bin/'+name,args,{env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:'pipe',encoding:'utf8',timeout:10000});
 async function stop(){if(server){await bounded(new Promise(r=>{server.close(r);server.closeAllConnections?.();}));server=null;}if(pool){await bounded(pool.end());pool=null;}if(running)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);running=false;fs.rmSync(dir,{recursive:true,force:true});console.log('CLEANUP_OWN_NG025_SOCKET_CLUSTER');}
 try{
 run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run('pg_ctl',['-D',data,'-l',path.join(dir,'pg.log'),'-o',`-F -h '' -k ${dir} -p ${port}`,'-w','start']);running=true;
 pool=new pg.Pool({host:dir,port,user:'postgres',database:'postgres',max:8,connectionTimeoutMillis:2000,query_timeout:5000});
 if((await pool.query('SHOW listen_addresses')).rows[0].listen_addresses!=='')throw Error('Fixture must be socket only');
 await pool.query("CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN;CREATE TABLE sedes(id bigint PRIMARY KEY,nombre text,ciudad text,pais text);CREATE TABLE crm_conversations(id uuid PRIMARY KEY);INSERT INTO sedes VALUES(1,'Synthetic A','A','AR'),(2,'Synthetic B','B','AR')");
 await pool.query(fs.readFileSync(new URL('../sql/20261005170000_next_generation_operations.sql',import.meta.url),'utf8'));
 if(install)await pool.query(fs.readFileSync(new URL('../sql/candidates/20261124_ng_update_session_atomic025.sql',import.meta.url),'utf8'));
 await pool.query("INSERT INTO ng_sesiones(id,sede_id,nombre_publico,categoria,cupo,estado,comienza_at) VALUES($1,1,'Synthetic session','U18',2,'programada','2027-01-01T18:00:00Z')",[SID]);
 await pool.query("INSERT INTO ng_inscripciones(id,sesion_id,sede_id,contacto_nombre,categoria,estado) VALUES($2,$1,1,'Synthetic A','U18','confirmada'),($3,$1,1,'Synthetic B','U18','borrador')",[SID,R1,R2]);
 const state={holdOldRead:false,oldRead:deferred(),releaseOld:deferred(),holdPatchCommit:false,patchUpdated:deferred(),releasePatch:deferred(),patchStarted:deferred(),confirmStarted:deferred(),rpcWrites:0};
 const ident=k=>{if(!/^[a-z_][a-z0-9_]*$/.test(k))throw Error('Fixture invalid identifier');return '"'+k+'"';};
 const db={from(table){let action='read',payload,columns='*',single=false;const filters=[];const q={select(c){columns=c||'*';return q;},eq(k,v){filters.push([k,v]);return q;},update(p){action='update';payload=p;return q;},single(){single=true;return execute();},maybeSingle(){single=true;return execute();},then(a,b){return execute().then(a,b);}};
 async function execute(){let client;try{client=await pool.connect();const args=[],where=filters.map(([k,v])=>{args.push(v);return ident(k)+'=$'+args.length;});let sql;
 if(action==='update'){const sets=Object.entries(payload).map(([k,v])=>{args.push(v);return ident(k)+'=$'+args.length;});sql=`UPDATE ${ident(table)} SET ${sets.join(',')} WHERE ${where.join(' AND ')} RETURNING ${columns}`;}
 else sql=`SELECT ${columns} FROM ${ident(table)}${where.length?' WHERE '+where.join(' AND '):''}`;
 const result=await client.query(sql,args);
 if(table==='ng_inscripciones'&&action==='read'&&state.holdOldRead&&filters.some(([k])=>k==='sesion_id')){state.oldRead.resolve({pid:client.processID,confirmed:result.rows.filter(r=>r.estado==='confirmada').length});await bounded(state.releaseOld.promise);}
 return {data:single?(result.rows[0]||null):result.rows,error:null};
 }catch(error){return{data:null,error};}finally{client?.release();}}
 return q;},async rpc(name,args){const client=await pool.connect();try{await client.query('BEGIN');if(name==='ng_update_session')state.patchStarted.resolve(client.processID);if(name==='ng_confirm_registration')state.confirmStarted.resolve(client.processID);
 const keys=Object.keys(args);const result=await client.query(`SELECT to_jsonb(public.${ident(name)}(${keys.map((k,n)=>ident(k)+' => $'+(n+1)).join(',')})) result`,Object.values(args));
 if(name==='ng_update_session'){state.rpcWrites++;if(state.holdPatchCommit){state.patchUpdated.resolve(client.processID);await bounded(state.releasePatch.promise);}}
 await client.query('COMMIT');return{data:result.rows[0].result,error:null};}catch(error){await client.query('ROLLBACK');return{data:null,error};}finally{client.release();}}};
 const scopes={a:{rol:'admin_club',sedeId:1,email:'a@example.invalid'},b:{rol:'admin_club',sedeId:2},super:{rol:'super_admin',superA:true,email:'super@example.invalid'}};
 const app=express();app.use(express.json());registerNextGenerationAdminRoutes(app,{supabaseAdmin:db,adminListScopeFromRequest:async req=>scopes[req.headers.authorization?.replace('Bearer ','')]||null});server=app.listen(0,'127.0.0.1');await once(server,'listening');
 const call=async(actor,method,url,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${url}`,{method,signal:AbortSignal.timeout(7000),headers:{...(actor?{authorization:'Bearer '+actor}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
 const snapshot=async()=>{const r=(await pool.query('SELECT cupo,(SELECT count(*)::int FROM ng_inscripciones WHERE sesion_id=$1 AND estado=\'confirmada\') used,nombre_publico FROM ng_sesiones WHERE id=$1',[SID])).rows[0];return r;};
 const waitLocked=async pid=>{for(let n=0;n<200;n++){if((await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,5));}throw Error('Did not observe real PG lock wait');};
 return{pool,state,call,snapshot,waitLocked,stop};
 }catch(error){if(fs.existsSync(path.join(dir,'pg.log')))console.error('OWN_PG_DIAGNOSTIC',fs.readFileSync(path.join(dir,'pg.log'),'utf8').slice(-1000));await stop();throw error;}
}
