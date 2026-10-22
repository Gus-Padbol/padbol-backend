import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {resolveScoreboardForTorneoPartido} from '../src/scoreboard/scoreboardTorneoPartidoResolver.js';
import {mountScoreboardRoutes} from './scoreboard.js';

test('a confirmed partial is read again from the same marker after leaving the match',async()=>{
 const rows={
  torneos:[{id:901,sede_id:8,tipo_torneo:'knockout',estado:'en_curso',deporte:'padbol',plan_nations:null}],
  partidos:[{id:5,torneo_id:901,sede_id:8,equipo_a_id:1,equipo_b_id:2,estado:'en_curso'}],
  equipos:[1,2].map(id=>({id,torneo_id:901,nombre:`Equipo ${id}`,inscripcion_estado:'confirmada',jugadores:[{nombre:'Uno',participante_id:`${id}a`},{nombre:'Dos',participante_id:`${id}b`}]})),
  sedes:[{id:8,nombre:'Sede ficticia',timezone:'Europe/Rome'}],canchas:[],torneo_partidos_programacion:[],scoreboard_historial_puntos:[],
  scoreboard_partidos:[{id:'12121212-1212-4212-8212-121212121212',partido_torneo_id:5,torneo_id:901,sede_id:8,estado:'en_curso',cronometro_inicio:'2026-10-21T12:00:00Z',cronometro_pausado:false,score_a:0,score_b:0,games_a:2,games_b:1,sets_a:0,sets_b:0,historial_sets:[],historial_puntos:[],saque_actual:'A',es_tiebreak:false}],
 };
 const writes=[];
 const db={from(table){let filters=[],mode='read',values;const q={select(){return q},eq(key,val){filters.push([key,val]);return q},order(){return q},single(){q.one=true;return q},maybeSingle(){q.one=true;return q},limit(){return q},insert(v){mode='insert';values=v;return q},update(v){mode='update';values=v;return q},then(resolve,reject){try{let selected=(rows[table]??[]).filter(row=>filters.every(([key,val])=>String(row[key])===String(val)));if(mode==='insert'){writes.push(table);rows[table].push(structuredClone(values));selected=[values];}if(mode==='update'){writes.push(table);selected.forEach(row=>Object.assign(row,structuredClone(values)));}return Promise.resolve({data:q.one?structuredClone(selected[0]??null):structuredClone(selected),error:null,count:selected.length}).then(resolve,reject)}catch(e){return Promise.reject(e).then(resolve,reject)}}};return q;}};
 db.rpc=async(name,args)=>{assert.equal(name,'scoreboard_commit_mutation');assert.equal(args.p_kind,'point');const row=rows.scoreboard_partidos.find(item=>item.id===args.p_id);if(!row||(row.updated_at??null)!==args.p_expected_updated_at)return {data:null,error:null};Object.assign(row,structuredClone(args.p_next),{updated_at:new Date().toISOString()});rows.scoreboard_historial_puntos.push({partido_id:row.id,...args.p_history});writes.push('scoreboard_partidos','scoreboard_historial_puntos');return {data:structuredClone(row),error:null};};
 const app=express();app.use(express.json());const auth=async()=>({user:{id:'synthetic'}});

 mountScoreboardRoutes(app,{supabaseAdmin:db,getAuthenticatedUser:auth,fetchUserRoleRowForAuthUser:async()=>({role:'admin_club',sede_id:8})});
 const server=await new Promise(resolve=>{const x=app.listen(0,'127.0.0.1',()=>resolve(x));});
 try{
  const base=`http://127.0.0.1:${server.address().port}`;const id=rows.scoreboard_partidos[0].id;
  const saved=await fetch(`${base}/api/scoreboard/partidos/${id}/punto/A`,{method:'POST'});assert.equal(saved.status,200);assert.equal((await saved.json()).score_a,15);
  const before=writes.length;const operation=await resolveScoreboardForTorneoPartido(db,5);assert.equal(operation.scoreboard_id,id);assert.equal(writes.length,before);
  const returned=await fetch(`${base}/api/scoreboard/partidos/${id}`);assert.equal(returned.status,200);const partial=await returned.json();assert.equal(partial.score_a,15);assert.equal(partial.games_a,2);assert.equal(partial.games_b,1);assert.equal(rows.scoreboard_partidos.length,1);
  db.rpc=async()=>({data:null,error:new Error('synthetic storage unavailable')});
  const failed=await fetch(`${base}/api/scoreboard/partidos/${id}/punto/A`,{method:'POST'});assert.notEqual(failed.status,200);assert.equal(rows.scoreboard_partidos[0].score_a,15);assert.equal(rows.scoreboard_historial_puntos.length,1);
 }finally{await new Promise(resolve=>server.close(resolve));}
});
