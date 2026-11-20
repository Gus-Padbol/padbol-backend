import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import express from 'express';
import {mountScoreboardRoutes} from './scoreboard.js';
import {GIACOMO_CONTINGENCY_USER_ID as GIACOMO} from '../lib/torneos/nationsScoreboardContingency.js';

// Exercise the HTTP handlers with the actual no-role account shape. All storage
// is isolated memory; no credentials or production calls are used by this test.
async function fixture() {
 const stranger='77777777-7777-4777-8777-777777777777';
 const rows={sedes:[{id:9,nombre:'Test venue',timezone:'Europe/Rome'}],canchas:[],scoreboard_partidos:[],scoreboard_historial_puntos:[]};
 const owners=new Map();let grantActive=true;
 const clone=value=>structuredClone(value);
 const db={from(table){let filters=[],mode='read',values,one=false,sort=null,maximum=null;const q={
  select(){return q},eq(key,value){filters.push(r=>String(r[key])===String(value));return q},is(key,value){filters.push(r=>r[key]==value);return q},
  order(key,{ascending=true}={}){sort={key,ascending};return q},single(){one=true;return q},maybeSingle(){one=true;return q},limit(n){maximum=n;return q},
  insert(value){mode='insert';values=value;return q},update(value){mode='update';values=value;return q},delete(){mode='delete';return q},
  then(resolve,reject){try{rows[table]??=[];let selected=rows[table].filter(r=>filters.every(f=>f(r)));
   if(mode==='insert'){selected=(Array.isArray(values)?values:[values]).map(value=>({id:randomUUID(),score_a:0,score_b:0,games_a:0,games_b:0,sets_a:0,sets_b:0,set_actual:1,historial_sets:[],historial_puntos:[],es_tiebreak:false,cronometro_pausado:true,cronometro_inicio:null,cronometro_acumulado:0,updated_at:null,...clone(value)}));rows[table].push(...selected);}
   if(mode==='update')selected.forEach(r=>Object.assign(r,clone(values)));
   if(mode==='delete')rows[table]=rows[table].filter(r=>!selected.includes(r));
   if(sort)selected.sort((a,b)=>sort.ascending?String(a[sort.key]).localeCompare(String(b[sort.key])):String(b[sort.key]).localeCompare(String(a[sort.key])));
   if(maximum!=null)selected=selected.slice(0,maximum);
   return Promise.resolve({data:clone(one?selected[0]??null:selected),error:null,count:selected.length}).then(resolve,reject);
  }catch(e){return Promise.reject(e).then(resolve,reject)}}};return q;}};
 db.rpc=async(name,args)=>{assert.equal(name,'scoreboard_commit_mutation');const row=rows.scoreboard_partidos.find(r=>r.id===args.p_id);if(!row||(row.updated_at??null)!==args.p_expected_updated_at)return {data:null,error:null};Object.assign(row,clone(args.p_next),{updated_at:new Date(Math.max(Date.now(),Date.parse(row.updated_at||'')+1||0)).toISOString()});
  if(args.p_kind==='point')rows.scoreboard_historial_puntos.push({id:randomUUID(),partido_id:row.id,timestamp:new Date().toISOString(),...clone(args.p_history)});
  if(args.p_kind==='undo')rows.scoreboard_historial_puntos=rows.scoreboard_historial_puntos.filter(h=>h.id!==args.p_history_id);
  return {data:clone(row),error:null};};
 const pool={async query(sql,args){
  if(sql.includes('FROM public.torneos'))return {rowCount:Number(args[0]===57&&args[1]===9),rows:[{id:57}]};
  if(sql.includes('FROM nations_operator.grants'))return {rowCount:Number(grantActive&&args[0]===GIACOMO),rows:grantActive&&args[0]===GIACOMO?[{id:'grant',torneo_id:57}]:[]};
  if(sql.startsWith('INSERT INTO public.scoreboard_contingency_owners')){owners.set(args[0],args[1]);return {rowCount:1,rows:[]};}
  if(sql.includes('FROM public.scoreboard_contingency_owners'))return {rowCount:Number(owners.get(args[0])===args[1]),rows:[]};
  if(sql.includes('FROM nations_marker_private.nations_marker_match'))return {rowCount:0,rows:[]};
  throw new Error(`Unexpected SQL in isolated fixture: ${sql}`);
 }};
 const app=express();app.use(express.json());
 mountScoreboardRoutes(app,{supabaseAdmin:db,nationsGamesPool:pool,nationsGamesEnabled:true,getAuthenticatedUser:async req=>req.headers.authorization?{user:{id:req.headers.authorization==='Bearer stranger'?stranger:GIACOMO}}:{user:null,status:401,error:'No autorizado'},fetchUserRoleRowForAuthUser:async()=>null});
 const server=await new Promise(resolve=>{const s=app.listen(0,'127.0.0.1',()=>resolve(s));});const base=`http://127.0.0.1:${server.address().port}`;
 const request=async(path,{method='GET',body,actor='giacomo'}={})=>{const r=await fetch(base+path,{method,headers:{'content-type':'application/json',...(actor?{authorization:`Bearer ${actor}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});return {status:r.status,body:await r.json()};};
 return {rows,owners,request,expireGrant(){grantActive=false;},close:()=>new Promise(resolve=>server.close(resolve))};
}
const creation={sede_id:9,cancha:'1',equipo_a_nombre:'Test Italy',equipo_b_nombre:'Test Spain',equipo_a_jugadores:['A1','A2','A3','A4'].map(nombre=>({nombre})),equipo_b_jugadores:['B1','B2','B3','B4'].map(nombre=>({nombre}))};

test('no-role Giacomo creates an owned marker, starts, scores, undoes and reads public TV',async()=>{
 const f=await fixture();try{
  const created=await f.request('/api/scoreboard/partidos',{method:'POST',body:creation});assert.equal(created.status,201,JSON.stringify(created.body));const id=created.body.id;assert.equal(f.owners.get(id),GIACOMO);
  const read=await f.request(`/api/scoreboard/partidos/${id}`);assert.equal(read.status,200);assert.equal(read.body.can_control,true);
  const start=await f.request(`/api/scoreboard/partidos/${id}/cronometro/start`,{method:'POST'});assert.equal(start.status,200,JSON.stringify(start.body));assert.equal(start.body.estado,'en_curso');
  const point=await f.request(`/api/scoreboard/partidos/${id}/punto/A`,{method:'POST'});assert.equal(point.status,200,JSON.stringify(point.body));assert.equal(point.body.score_a,15);
  const tv=await f.request(`/api/scoreboard/partidos/${id}`,{actor:null});assert.equal(tv.status,200);assert.equal(tv.body.score_a,15);assert.equal(tv.body.can_control,false);
  const undo=await f.request(`/api/scoreboard/partidos/${id}/undo`,{method:'POST'});assert.equal(undo.status,200,JSON.stringify(undo.body));assert.equal(undo.body.score_a,0);
 }finally{await f.close();}
});

test('contingency cannot control other owners, other venues, linked official games, or mint bearer links',async()=>{
 const f=await fixture();try{
  for(const body of [{...creation,sede_id:8},{...creation,torneo_id:57},{...creation,reserva_id:123},{...creation,partido_torneo_id:578}]){const denied=await f.request('/api/scoreboard/partidos',{method:'POST',body});assert.equal(denied.status,403,JSON.stringify(denied));}
  const made=await f.request('/api/scoreboard/partidos',{method:'POST',body:creation});assert.equal(made.status,201);const id=made.body.id;
  const foreign=await f.request(`/api/scoreboard/partidos/${id}/cronometro/start`,{method:'POST',actor:'stranger'});assert.equal(foreign.status,403);
  const link=await f.request(`/api/scoreboard/partidos/${id}/control-token`,{method:'POST'});assert.equal(link.status,403);
  const attach=await f.request(`/api/scoreboard/partidos/${id}`,{method:'PATCH',body:{torneo_id:57}});assert.equal(attach.status,403);
  f.rows.scoreboard_partidos[0].partido_torneo_id=578;f.rows.scoreboard_partidos[0].torneo_id=57;
  const official=await f.request(`/api/scoreboard/partidos/${id}/cronometro/start`,{method:'POST'});assert.equal(official.status,403);
 }finally{await f.close();}
});

test('expired grant immediately denies authenticated control of an owned marker',async()=>{
 const f=await fixture();try{const made=await f.request('/api/scoreboard/partidos',{method:'POST',body:creation});assert.equal(made.status,201);f.expireGrant();const denied=await f.request(`/api/scoreboard/partidos/${made.body.id}/cronometro/start`,{method:'POST'});assert.equal(denied.status,403);}finally{await f.close();}
});
