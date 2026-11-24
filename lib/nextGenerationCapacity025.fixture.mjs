// QA-025 capacity fixture rebased onto the exact NG-026 catalog/RPC contract.
// Only this fixture owns its PG17 cluster, socket directory and cleanup.
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {execFileSync} from 'node:child_process';import {once} from 'node:events';import express from 'express';import pg from 'pg';
import {registerNextGenerationAdminRoutes} from './nextGenerationAdmin.js';
import {catalog,SID,SID2,SIDB,VA,VB,R1,R2,bounded,deferred} from './nextGenerationUuid026.fixture.mjs';
export {SID,R1,R2,bounded};
const ident=k=>{if(!/^[a-z_][a-z0-9_]*$/.test(k))throw Error('Fixture invalid identifier');return '"'+k+'"';};
export async function start({install=true}={}){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ng025-')),data=path.join(dir,'data'),port=55496;let running=false,pool,server;
 const run=(name,args)=>execFileSync('/opt/homebrew/bin/'+name,args,{env:{PATH:'/usr/bin:/bin',LC_ALL:'C'},stdio:'pipe',encoding:'utf8',timeout:10000});
 async function stop(){if(server){await bounded(new Promise(r=>{server.close(r);server.closeAllConnections?.();}));server=null;}if(pool){await bounded(pool.end());pool=null;}if(running)run('pg_ctl',['-D',data,'-m','immediate','-w','stop']);running=false;fs.rmSync(dir,{recursive:true,force:true});console.log('CLEANUP_OWN_NG025_SOCKET_CLUSTER');}
 try{
  run('initdb',['-D',data,'-U','postgres','-A','trust','--no-locale','-E','UTF8']);run('pg_ctl',['-D',data,'-l',path.join(dir,'pg.log'),'-o',`-F -h '' -k ${dir} -p ${port}`,'-w','start']);running=true;
  pool=new pg.Pool({host:dir,port,user:'postgres',database:'postgres',max:8,connectionTimeoutMillis:2000,query_timeout:5000});
  if((await pool.query('SHOW listen_addresses')).rows[0].listen_addresses!=='')throw Error('Fixture must be socket only');
  await pool.query('CREATE ROLE anon NOLOGIN;CREATE ROLE authenticated NOLOGIN;CREATE ROLE service_role NOLOGIN BYPASSRLS;CREATE SCHEMA auth');
  const tableNames=new Set(catalog.tables.map(t=>t.name));
  for(const parent of catalog.foreign_parent_columns)if(parent.schema!=='public'||!tableNames.has(parent.table))await pool.query(`CREATE TABLE IF NOT EXISTS ${ident(parent.schema)}.${ident(parent.table)}(${ident(parent.column)} ${parent.type} PRIMARY KEY)`);
  for(const col of catalog.columns)if(col.default?.startsWith('nextval(')){const sequence=col.default.match(/nextval\('([^']+)'/)[1];await pool.query('CREATE SEQUENCE '+ident(sequence));}
  for(const t of catalog.tables){const columns=catalog.columns.filter(c=>c.table===t.name).map(c=>`${ident(c.column)} ${c.type}${c.identity?` GENERATED ${c.identity==='a'?'ALWAYS':'BY DEFAULT'} AS IDENTITY`:c.default?' DEFAULT '+c.default:''}${c.not_null?' NOT NULL':''}`);await pool.query(`CREATE TABLE public.${ident(t.name)}(${columns.join(',')})`);}
  for(const fk of [false,true])for(const c of catalog.constraints)if((c.kind==='f')===fk)await pool.query(`ALTER TABLE public.${ident(c.table)} ADD CONSTRAINT ${ident(c.name)} ${c.definition}`);
  for(const i of catalog.indexes)if(!catalog.constraints.some(c=>c.name===i.name))await pool.query(i.definition);
  const privileges={r:'SELECT',a:'INSERT',w:'UPDATE',d:'DELETE',D:'TRUNCATE',x:'REFERENCES',t:'TRIGGER',m:'MAINTAIN'};
  for(const t of catalog.tables){if(t.rls)await pool.query(`ALTER TABLE ${ident(t.name)} ENABLE ROW LEVEL SECURITY`);if(t.force_rls)await pool.query(`ALTER TABLE ${ident(t.name)} FORCE ROW LEVEL SECURITY`);
   for(const entry of (t.acl||'{}').slice(1,-1).split(',').filter(Boolean)){const [role,tail]=entry.split('=');const rights=tail.split('/')[0].replaceAll('*','').split('').map(c=>privileges[c]);if(rights.length)await pool.query(`GRANT ${rights.join(',')} ON ${ident(t.name)} TO ${role?ident(role):'PUBLIC'}`);}}
  for(const f of catalog.functions){await pool.query(f.definition);const args=f.args.split(',').map(a=>a.trim().split(/\s+/).slice(1).join(' ')).join(',');await pool.query(`REVOKE ALL ON FUNCTION public.${ident(f.name)}(${args}) FROM PUBLIC,anon,authenticated;GRANT EXECUTE ON FUNCTION public.${ident(f.name)}(${args}) TO service_role`);}
  if(install)await pool.query(fs.readFileSync(new URL('../sql/candidates/20261124_nextgen_uuid_compat026.sql',import.meta.url),'utf8'));
  await pool.query("INSERT INTO sedes(id,nombre,pais,ciudad,cantidad_canchas,horario_apertura,horario_cierre,precio_por_reserva,whatsapp_contacto) VALUES(1,'Synthetic A','AR','City',1,'08:00','23:00',0,'+541155550000'),(2,'Synthetic B','AR','City',1,'08:00','23:00',0,'+541155550000'),(3,'Synthetic C','AR','City',1,'08:00','23:00',0,'+541155550000')");
  const request=async(id,canonical)=>pool.query("INSERT INTO ng_solicitudes_sede(id,canonical_sede_id,nombre,sede_club,ciudad,pais,email,whatsapp,motivo_solicitud,direccion,consentimiento_datos,estado) VALUES($1,$2,'Synthetic contact','Synthetic PP','City','AR','fixture@example.invalid','+541155550000','conocer','Fixture address',true,'aprobada')",[id,canonical]);
  await request(VA,1);await request(VB,2);
  for(const [id,venue] of [[SID,VA],[SID2,VA],[SIDB,VB]])await pool.query("INSERT INTO ng_sesiones(id,sede_id,nombre_publico,ciudad,pais,categoria,comienza_at,termina_at,cupo,estado,creado_por) VALUES($1,$2,'Synthetic session','City','AR','Sub-18','2027-01-01T18:00:00Z','2027-01-01T19:00:00Z',2,'publicada','fixture@example.invalid')",[id,venue]);
  const registration=async(id,session=SID,venue=1,status='borrador')=>pool.query("INSERT INTO ng_inscripciones(id,sesion_id,sede_id,idempotency_key,payload_hash,contacto_nombre,contacto_email,contacto_whatsapp,consentimiento_datos,consentimiento_terminos,version_privacidad,version_terminos,categoria,estado) VALUES($1,$2,$3,$1,'synthetic-hash','Synthetic responsible','fixture@example.invalid','+541155550000',true,true,'synthetic-v1','synthetic-v1','Sub-18',$4)",[id,session,venue,status]);
  await registration(R1,SID,1,'confirmada');await registration(R2,SID,1,'borrador');

  const state={holdOldRead:false,oldRead:deferred(),releaseOld:deferred(),holdPatchCommit:false,patchUpdated:deferred(),releasePatch:deferred(),patchStarted:deferred(),confirmStarted:deferred(),rpcWrites:0,rpcErrors:[]};
  const db={from(table){let action='read',payload,columns='*',single=false,limit,orders=[];const filters=[];const q={select(c){columns=c||'*';return q;},eq(k,v){filters.push([k,'eq',v]);return q;},in(k,v){filters.push([k,'in',v]);return q;},order(k,o={}){orders.push([k,o.ascending===false?'DESC':'ASC']);return q;},limit(n){limit=n;return q;},update(p){action='update';payload=p;return q;},single(){single=true;return execute();},maybeSingle(){single=true;return execute();},then(a,b){return execute().then(a,b);}};
   async function execute(){let client;try{client=await pool.connect();const args=[],where=filters.map(([k,op,v])=>{args.push(v);return op==='in'?ident(k)+'=ANY($'+args.length+'::uuid[])':ident(k)+'=$'+args.length;});let sql;
    if(action==='update'){const sets=Object.entries(payload).map(([k,v])=>{args.push(v);return ident(k)+'=$'+args.length;});sql=`UPDATE ${ident(table)} SET ${sets.join(',')} WHERE ${where.join(' AND ')} RETURNING ${columns}`;}
    else{sql=`SELECT ${columns} FROM ${ident(table)}${where.length?' WHERE '+where.join(' AND '):''}`;if(orders.length)sql+=' ORDER BY '+orders.map(([k,d])=>ident(k)+' '+d).join(',');if(limit!=null){args.push(limit);sql+=' LIMIT $'+args.length;}}
    const result=await client.query(sql,args);
    if(table==='ng_inscripciones'&&action==='read'&&state.holdOldRead&&filters.some(([k])=>k==='sesion_id')){state.oldRead.resolve({pid:client.processID,confirmed:result.rows.filter(r=>r.estado==='confirmada').length});await bounded(state.releaseOld.promise);}
    return {data:single?(result.rows[0]||null):result.rows,error:null};
   }catch(error){return{data:null,error};}finally{client?.release();}}
   return q;},async rpc(name,args){const client=await pool.connect();try{await client.query('BEGIN');if(name==='ng_update_session')state.patchStarted.resolve(client.processID);if(name==='ng_confirm_registration')state.confirmStarted.resolve(client.processID);
    const keys=Object.keys(args);const result=await client.query(`SELECT to_jsonb(public.${ident(name)}(${keys.map((k,n)=>ident(k)+' => $'+(n+1)).join(',')})) result`,Object.values(args));
    if(name==='ng_update_session'){state.rpcWrites++;if(state.holdPatchCommit){state.patchUpdated.resolve(client.processID);await bounded(state.releasePatch.promise);}}await client.query('COMMIT');return{data:result.rows[0].result,error:null};}catch(error){state.rpcErrors.push(error.code);await client.query('ROLLBACK');return{data:null,error};}finally{client.release();}}};
  const scopes={a:{rol:'admin_club',sedeId:1,email:'a@example.invalid'},b:{rol:'admin_club',sedeId:2},super:{rol:'super_admin',superA:true,email:'super@example.invalid'}};
  const app=express();app.use(express.json());registerNextGenerationAdminRoutes(app,{supabaseAdmin:db,pgPool:pool,adminListScopeFromRequest:async req=>scopes[req.headers.authorization?.replace('Bearer ','')]||null});server=app.listen(0,'127.0.0.1');await once(server,'listening');
  const call=async(actor,method,url,body)=>{const r=await fetch(`http://127.0.0.1:${server.address().port}${url}`,{method,signal:AbortSignal.timeout(7000),headers:{...(actor?{authorization:'Bearer '+actor}:{}),'content-type':'application/json'},...(body?{body:JSON.stringify(body)}:{})});return{status:r.status,body:await r.json()};};
  const snapshot=async()=>{const r=(await pool.query("SELECT cupo,(SELECT count(*)::int FROM ng_inscripciones WHERE sesion_id=$1 AND estado='confirmada') used,nombre_publico FROM ng_sesiones WHERE id=$1",[SID])).rows[0];return r;};
  const waitLocked=async pid=>{for(let n=0;n<200;n++){if((await pool.query('SELECT wait_event_type FROM pg_stat_activity WHERE pid=$1',[pid])).rows[0]?.wait_event_type==='Lock')return;await new Promise(r=>setTimeout(r,5));}throw Error('Did not observe real PG lock wait');};
  return{pool,state,call,snapshot,waitLocked,stop};
 }catch(error){if(fs.existsSync(path.join(dir,'pg.log')))console.error('OWN_PG_DIAGNOSTIC',fs.readFileSync(path.join(dir,'pg.log'),'utf8').slice(-1000));await stop();throw error;}
}
