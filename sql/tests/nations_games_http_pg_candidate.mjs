import pg from 'pg';import express from 'express';import assert from 'node:assert/strict';import {readFile} from 'node:fs/promises';
import {mountScoreboardRoutes} from '../../routes/scoreboard.js';
import {fixture,memoryDb} from '../../lib/scoreboardSportGuard.test.js';
import {recoverOneGamesFinalization} from '../../lib/torneos/nationsGamesFinalizationRecovery.js';
const url=new URL(process.env.OWN_GAMES_PG_URL);if(url.hostname!=='127.0.0.1'||url.pathname!=='/marker_games_http_test'||url.port!==process.env.OWN_GAMES_PG_PORT)throw Error('REFUSE_TARGET');
const pool=new pg.Pool({connectionString:url.href}),id='00000000-0000-4000-8000-000000000001';
const source=await readFile('sql/tests/nations_games_atomic_history_candidate.mjs','utf8');
await pool.query(source.match(/await d.exec\(`([\s\S]*?)`\);/)[1].replaceAll('${id}',id));
await pool.query(`ALTER TABLE scoreboard_partidos ADD COLUMN sede_id bigint DEFAULT 1,ADD COLUMN torneo_id bigint DEFAULT 10,ADD COLUMN partido_torneo_id bigint DEFAULT 77; CREATE TABLE nations_marker_private.nations_marker_audit(match_id text,revision int,kind text,actor text,payload jsonb,UNIQUE(match_id,revision));`);
const st=(a,b,c)=>({status:'open',active:[a,b],lineup:{iniciales:[a,b],suplentes:[c]}});
await pool.query("INSERT INTO nations_marker_private.nations_marker_match VALUES($1,0,$2,'{}',now())",[id,JSON.stringify({A:st('a','b','c'),B:st('d','e','f')})]);
for(const p of ['sql/20261021120000_scoreboard_atomic_mutation.sql','sql/candidates/nations_games_atomic_history.sql','sql/candidates/nations_games_commands.sql','sql/candidates/nations_games_legacy_guard.sql'])await pool.query(await readFile(p,'utf8'));
const tables=fixture({sport:'padbol'});tables.partidos[0].id=77;const base=memoryDb(tables);
const db={rpc:()=>{throw Error('LEGACY_RPC_FORBIDDEN');},from(table){if(!['scoreboard_partidos','scoreboard_historial_puntos'].includes(table))return base.from(table);let filters=[],descending=false,max;
 const q={select(){return q;},eq(k,v){if(!['id','partido_id','control_token_hash'].includes(k))throw Error('unexpected key');filters.push([k,v]);return q;},order(){descending=true;return q;},limit(n){max=n;return q;},async maybeSingle(){return {...await run(),data:(await run()).data[0]??null};},then(a,b){return run().then(a,b);}};
 async function run(){let sql=`SELECT * FROM ${table}`;if(filters.length)sql+=' WHERE '+filters.map(([k],i)=>`${k}=$${i+1}`).join(' AND ');if(descending)sql+=' ORDER BY id DESC';if(max)sql+=' LIMIT '+Number(max);return {data:(await pool.query(sql,filters.map(x=>x[1]))).rows,error:null};}return q;}};
const app=express();app.use(express.json());mountScoreboardRoutes(app,{supabaseAdmin:db,getAuthenticatedUser:async()=>({user:{id:'synthetic-user'}}),fetchUserRoleRowForAuthUser:async()=>({role:'super_admin'}),nationsGamesEnabled:true,nationsGamesPool:pool});
const server=await new Promise(r=>{const s=app.listen(0,'127.0.0.1',()=>r(s));});const baseUrl=`http://127.0.0.1:${server.address().port}`;
const post=async(action,requestId)=>{const r=await fetch(`${baseUrl}/api/scoreboard/partidos/${id}/${action}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({requestId,epoch:0})});return {status:r.status,body:await r.json()};};
try{
 const key='10000000-0000-4000-8000-000000000001';const a=await post('punto/A',key);assert.equal(a.status,200);assert.equal(a.body.games_a,1);assert.equal(a.body.control_token_hash,undefined);
 const b=await post('punto/A',key);assert.equal(b.status,200);assert.equal(b.body.games_a,1);
 assert.equal((await pool.query('SELECT count(*)::int n FROM scoreboard_historial_puntos')).rows[0].n,1);
 const undo='10000000-0000-4000-8000-000000000002';const u=await post('undo',undo);assert.equal(u.status,200);assert.equal(u.body.games_a,0);
 const ur=await post('undo',undo);assert.equal(ur.status,200);assert.equal(ur.body.games_a,0);
 assert.equal((await pool.query('SELECT count(*)::int n FROM scoreboard_historial_puntos')).rows[0].n,0);
 const next='10000000-0000-4000-8000-000000000003';const rs=await Promise.all(Array.from({length:8},()=>post('punto/A',next)));assert.ok(rs.every(x=>x.status===200));assert.equal((await pool.query('SELECT count(*)::int n FROM scoreboard_historial_puntos')).rows[0].n,1);
 console.log('PASS real HTTP+PG point/retry/undo with empty history and 8 concurrent duplicates');
 const tie=await post('tiebreak','10000000-0000-4000-8000-000000000004');assert.equal(tie.status,200);assert.equal(tie.body.es_tiebreak,true);
 // Force only synthetic final fixture fields; then exercise durable worker claim.
 await pool.query("UPDATE scoreboard_partidos SET estado='terminado'");
 const row=(await pool.query('SELECT * FROM scoreboard_partidos')).rows[0];const snapshot=Object.fromEntries(['partido_torneo_id','torneo_id','sede_id','estado','sets_a','sets_b','games_a','games_b','score_a','score_b','historial_sets'].map(k=>[k,row[k]]));
 await pool.query("INSERT INTO nations_marker_private.games_finalization_intents(scoreboard_id,epoch,request_id,partido_torneo_id,final_snapshot) VALUES($1,0,$2,77,$3)",[id,next,JSON.stringify(snapshot)]);
 let applied=0;const recover=()=>recoverOneGamesFinalization({pool,db:{},apply:async()=>{applied++;await new Promise(r=>setTimeout(r,20));return {status:'completed',reason:'synthetic'};}});
 const workers=await Promise.all(Array.from({length:8},recover));assert.equal(applied,1);assert.equal(workers.filter(x=>x.status==='completed').length,1);assert.equal(workers.filter(x=>x.status==='idle').length,7);
 console.log('PASS real PG 8 recovery claimants run one finalization');
 await pool.query("UPDATE nations_marker_private.games_finalization_intents SET status='pending',occurred_at=clock_timestamp()-interval '1 day',next_attempt_at=clock_timestamp()-interval '1 second'");
 await pool.query("INSERT INTO nations_marker_private.games_finalization_intents(scoreboard_id,epoch,request_id,partido_torneo_id,final_snapshot,occurred_at) VALUES($1,1,$2,77,$3,clock_timestamp()-interval '1 minute')",[id,next,JSON.stringify(snapshot)]);
 const fair=await recover();assert.equal(fair.status,'blocked'); // newer intent is selected; mismatched epoch intentionally blocks
 const old=(await pool.query('SELECT status FROM nations_marker_private.games_finalization_intents WHERE epoch=0')).rows[0];assert.equal(old.status,'pending');
 console.log('PASS real PG recovery fairness: older pending item does not starve newer finalization');
}finally{await new Promise(r=>server.close(r));await pool.end();}
