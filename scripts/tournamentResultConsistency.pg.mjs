// Private PG only. Actual services and existing projection trigger; synthetic storage/actors.
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {execFileSync} from 'node:child_process';
import pg from 'pg';
import {finalizarPartidoTorneo} from '../lib/torneos/finalizarPartidoTorneoService.js';
import {cargarResultadoManualPartidoTorneo} from '../lib/torneos/cargarResultadoManualPartidoTorneoService.js';
import {syncScoreboardToTorneoPartido} from '../src/scoreboard/scoreboardTorneoSyncService.js';
const dir=await mkdtemp('/tmp/pb-tournament-cas-'),bin='/opt/homebrew/opt/postgresql@17/bin';let running=false,pool,checks=0;
const result=(a=2,b=0)=>({goles_a:a,goles_b:b});
try{
 execFileSync(bin+'/initdb',['-D',dir+'/data','--username=postgres','--auth-local=trust','--auth-host=reject','--no-locale','--encoding=UTF8'],{stdio:'pipe'});
 execFileSync(bin+'/pg_ctl',['-D',dir+'/data','-l',dir+'/server.log','-o',`-F -h '' -k ${dir} -p5432`,'-w','start'],{stdio:'pipe'});running=true;
 pool=new pg.Pool({host:dir,user:'postgres',database:'postgres',port:5432,max:8});
 await pool.query(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
 CREATE TABLE torneos(id bigint primary key,deporte text,modalidad_plantel text,plan_nations jsonb);
 INSERT INTO torneos VALUES(28,'padbol','dobles',null);
 CREATE TABLE partidos(id bigint primary key,torneo_id bigint,estado text,resultado jsonb,equipo_a_id bigint,equipo_b_id bigint,ganador_equipo_id bigint);
 CREATE TABLE scoreboard_partidos(id text primary key,partido_torneo_id bigint,torneo_id bigint,estado text,sets_a integer,sets_b integer,historial_sets jsonb,sync_torneo_status text,updated_at timestamptz,synced_to_torneo_at timestamptz);`);
 await pool.query(await readFile(new URL('../sql/migrations/20261016190000_sync_linked_scoreboard_final_result.sql',import.meta.url),'utf8'));
 const reset=async()=>{await pool.query('TRUNCATE partidos,scoreboard_partidos');await pool.query("INSERT INTO partidos VALUES(45,28,'pendiente',null,71,72,null)");};
 const link=async()=>pool.query("INSERT INTO scoreboard_partidos(id,partido_torneo_id,torneo_id,estado,sets_a,sets_b,sync_torneo_status)VALUES('sb',45,28,'terminado',0,2,'pending')");
 function client({barrier=false,lostReply=false,readFailure=false}={}){
  let reads=0,release;const gate=new Promise(r=>release=r);let lose=lostReply;
  return {from(table){assert.ok(['partidos','scoreboard_partidos','torneos'].includes(table));let patch=null;const filters=[];
   const query={select(){return query;},eq(k,v){filters.push([k,v,false]);return query;},is(k,v){filters.push([k,v,true]);return query;},update(p){patch=p;return query;},
    async maybeSingle(){
     if(!patch&&readFailure&&lose===false)return{data:null,error:Error('synthetic reconciliation unavailable')};
     const values=[],where=filters.map(([k,v,nil])=>{assert.match(k,/^[a-z_]+$/);if(nil)return `${k} IS NULL`;values.push(v);return `${k}=$${values.length}`;}).join(' AND ')||'TRUE';
     if(patch){const fields=Object.entries(patch),params=fields.map(([,v])=>v);const shifted=where.replace(/\$(\d+)/g,(_,n)=>'$'+(Number(n)+params.length));
      try{const rows=(await pool.query(`UPDATE ${table} SET ${fields.map(([k],i)=>`${k}=$${i+1}`).join(',')} WHERE ${shifted} RETURNING *`,[...params,...values])).rows;
       if(lose){lose=false;throw Error('synthetic response lost after committed update');}return{data:rows[0]??null,error:null};
      }catch(error){return{data:null,error};}
     }
     const rows=(await pool.query(`SELECT * FROM ${table} WHERE ${where}`,values)).rows;
     if(table==='partidos'&&rows[0])rows[0].torneo=(await pool.query('SELECT * FROM torneos WHERE id=$1',[rows[0].torneo_id])).rows[0];
     if(barrier&&table==='partidos'&&reads++<2){if(reads===2)release();await gate;}
     return{data:rows[0]??null,error:null};
    },then(resolve,reject){return query.maybeSingle().then(resolve,reject);}};return query;}};
 }
 const finalize=(db,score)=>finalizarPartidoTorneo(db,{partidoId:45,torneoId:28,resultado:score,context:{allowOverwrite:false}});
 for(const linked of [false,true])for(const score of [result(3,2),result(2.5,1),result(2,1.5)]){await reset();if(linked)await link();const r=await finalize(client(),score);assert.equal(r.ok,false);assert.equal((await pool.query('SELECT estado FROM partidos')).rows[0].estado,'pendiente');checks++;}
 await reset();await link();let db=client({barrier:true});let responses=await Promise.all([finalize(db,result()),finalize(db,result(0,2))]);assert.equal(responses.filter(r=>r.status==='finalized').length,1);assert.equal(responses.filter(r=>r.status==='rejected').length,1);let row=(await pool.query('SELECT * FROM partidos')).rows[0];let sb=(await pool.query('SELECT * FROM scoreboard_partidos')).rows[0];assert.equal(Number(sb.sets_a),row.resultado.goles_a);assert.equal(Number(sb.sets_b),row.resultado.goles_b);checks++;
 await reset();db=client({barrier:true});responses=await Promise.all([finalize(db,result()),finalize(db,result())]);assert.deepEqual(responses.map(r=>r.status).sort(),['finalized','idempotent']);checks++;
 await reset();await link();db=client({barrier:true});const effects=[];
 responses=await Promise.all([cargarResultadoManualPartidoTorneo(db,{torneoId:28,partidoId:45,body:result()}, {onPartidoTorneoFinalizado:async()=>{effects.push(true);return{ok:true,advance:{status:'skipped',reason:'no_destino'},scoreboard:null};}}),syncScoreboardToTorneoPartido(db,'sb')]);row=(await pool.query('SELECT * FROM partidos')).rows[0];sb=(await pool.query('SELECT * FROM scoreboard_partidos')).rows[0];assert.equal(sb.sets_a,row.resultado.goles_a);assert.equal(sb.sets_b,row.resultado.goles_b);assert.equal(responses[0].statusCode===409||responses[1].ok===false,true);assert.ok(effects.length<=1);checks++;
 await reset();await link();await pool.query("CREATE FUNCTION fail_final()RETURNS trigger LANGUAGE plpgsql AS $$BEGIN RAISE EXCEPTION 'synthetic trigger rollback';END$$;CREATE TRIGGER zz_fail_final AFTER UPDATE ON partidos FOR EACH ROW EXECUTE FUNCTION fail_final()");await assert.rejects(()=>finalize(client(),result()),/synthetic trigger rollback/);assert.equal((await pool.query('SELECT estado FROM partidos')).rows[0].estado,'pendiente');assert.equal((await pool.query('SELECT sets_b FROM scoreboard_partidos')).rows[0].sets_b,2);await pool.query('DROP TRIGGER zz_fail_final ON partidos');checks++;
 await reset();await link();const recovered=await finalize(client({lostReply:true}),result());assert.equal(recovered.status,'idempotent');assert.equal(recovered.updated,false);assert.equal((await pool.query('SELECT ganador_equipo_id FROM partidos')).rows[0].ganador_equipo_id,'71');checks++;
 const replay=await finalize(client(),result());assert.equal(replay.status,'idempotent');const conflict=await finalize(client(),result(0,2));assert.equal(conflict.ok,false);checks++;
 await reset();await assert.rejects(()=>finalize(client({lostReply:true,readFailure:true}),result()),/synthetic response lost/);assert.equal((await pool.query('SELECT estado FROM partidos')).rows[0].estado,'finalizado');assert.equal((await finalize(client(),result())).status,'idempotent');checks++;
 console.log(JSON.stringify({checks,postgres:(await pool.query('select version()')).rows[0].version,source:'actual services plus existing linked scoreboard projection SQL trigger',race:'manual/manual opposite, identical; manual/scoreboard',rollback:true,lost_response_read_reconciliation:true,production_changes:false,external_network:'blocked',ranking_tables_written:false},null,2));
}finally{if(pool)await pool.end();if(running)execFileSync(bin+'/pg_ctl',['-D',dir+'/data','-m','immediate','-w','stop'],{stdio:'pipe'});await rm(dir,{recursive:true,force:true});}
