// Disposable local PostgreSQL proof. NEVER accepts a remote URL or production DB.
import pg from 'pg';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createHash,randomUUID} from 'node:crypto';
const url='postgresql://postgres@127.0.0.1:55438/nations_result_recovery_test';
const cp=new pg.Client({connectionString:url}).connectionParameters;
assert.equal(cp.host,'127.0.0.1');assert.equal(Number(cp.port),55438);assert.equal(cp.database,'nations_result_recovery_test');
const pool=new pg.Pool({connectionString:url});
const GIACOMO='80838a2c-d465-4b39-b7a3-c32984e77791',OTHER='77777777-7777-4777-8777-777777777777';
const migrationPath='supabase/migrations/20261120130000_nations_official_result_recovery.sql';
const migration=fs.readFileSync(migrationPath,'utf8'),sha=createHash('sha256').update(migration).digest('hex');
console.log('MIGRATION_SHA256',sha);
const results=[];
const run=async(name,fn)=>{try{await fn();results.push({name,status:'PASS'});console.log('PASS',name);}catch(e){results.push({name,status:'FAIL',message:e.message});console.log('FAIL',name,e.message);}};
const normal={goles_a:2,goles_b:0,historial_sets:[{set:1,a:6,b:3},{set:2,a:6,b:1}]};
const tb={goles_a:2,goles_b:1,historial_sets:[{set:1,a:6,b:3},{set:2,a:2,b:6},{set:3,a:1,b:0,type:'super_tiebreak',points_a:10,points_b:9,target:10,win_by:1}]};
const call=(id,score=normal,actor=GIACOMO,q=pool)=>q.query('SELECT recuperar_resultado_equipo_nations($1,$2::jsonb,$3::uuid) result',[id,JSON.stringify(score),actor]);
const snapshot=async id=>JSON.stringify((await pool.query('SELECT estado,resultado,ganador_equipo_id,(SELECT count(*) FROM nations_official_result_recoveries WHERE partido_id=$1) audit_count FROM partidos WHERE id=$1',[id])).rows[0]);
async function deny(id,score=normal,actor=GIACOMO){const before=await snapshot(id);let denied=false;try{await call(id,score,actor);}catch(e){denied=true;}assert(denied,'RPC accepted an invalid/forbidden recovery');assert.equal(await snapshot(id),before,'rejected recovery changed match/audit');}
try{
 await pool.query(`DROP SCHEMA IF EXISTS nations_operator,auth CASCADE;DROP SCHEMA public CASCADE;CREATE SCHEMA public;CREATE SCHEMA auth;CREATE SCHEMA nations_operator;
 CREATE TABLE auth.users(id uuid PRIMARY KEY,email_confirmed_at timestamptz,banned_until timestamptz,deleted_at timestamptz);
 CREATE TABLE user_roles(user_id uuid PRIMARY KEY,role text,sede_id bigint);
 CREATE TABLE torneos(id bigint PRIMARY KEY,sede_id bigint,modalidad_plantel text,estado text,deporte text);
 CREATE TABLE equipos(id bigint PRIMARY KEY,torneo_id bigint,inscripcion_estado text,jugadores jsonb);
 CREATE TABLE partidos(id bigint PRIMARY KEY,torneo_id bigint,equipo_a_id bigint,equipo_b_id bigint,estado text,resultado jsonb,ganador_equipo_id bigint,grupo text);
 CREATE TABLE scoreboard_partidos(id uuid PRIMARY KEY,partido_torneo_id bigint);
 CREATE TABLE torneo_partido_alineaciones(partido_id bigint,equipo_id bigint);
 CREATE TABLE torneo_partido_participacion(partido_id bigint);
 CREATE TABLE torneo_participante_ranking_cierres(participante_id uuid);
 CREATE TABLE nations_operator.grants(id uuid PRIMARY KEY,user_id uuid,torneo_id bigint,revoked_at timestamptz,expires_at timestamptz);
 INSERT INTO torneos VALUES(57,9,'selecciones','en_curso','padbol'),(58,9,'selecciones','en_curso','padbol');
 INSERT INTO equipos VALUES(101,57,'confirmado','[{},{},{},{}]'),(102,57,'confirmado','[{},{},{},{}]');
 INSERT INTO partidos SELECT g,57,101,102,'pendiente',NULL,NULL,'A' FROM generate_series(100,150)g;
 UPDATE partidos SET torneo_id=58 WHERE id=110;
 INSERT INTO scoreboard_partidos VALUES(gen_random_uuid(),111);`);
 await pool.query('INSERT INTO auth.users VALUES($1,now(),NULL,NULL),($2,now(),NULL,NULL)',[GIACOMO,OTHER]);
 await pool.query("INSERT INTO nations_operator.grants VALUES($1,$2,57,NULL,now()+interval '1 day')",[randomUUID(),GIACOMO]);
 // Use the real existing national result guard, not a fake success callback.
 const national=fs.readFileSync('sql/20261010150000_padbol_national_rosters_lineups.sql','utf8');
 await pool.query(national.slice(national.indexOf('CREATE OR REPLACE FUNCTION public.proteger_resultado_seleccion'),national.indexOf('CREATE OR REPLACE FUNCTION public.proteger_marcador_seleccion')));
 await pool.query(migration);
 await run('no lineup pendingmatch recovers team result + audit without participation/awards',async()=>{
  const out=await call(100);assert.equal(out.rows[0].result.status,'recovered');
  const m=(await pool.query('SELECT * FROM partidos WHERE id=100')).rows[0];assert.equal(m.estado,'finalizado');assert.equal(Number(m.ganador_equipo_id),101);assert.deepEqual(m.resultado,normal);
  assert.equal((await pool.query('SELECT count(*)::int n FROM nations_official_result_recoveries WHERE partido_id=100')).rows[0].n,1);
  for(const table of ['torneo_partido_alineaciones','torneo_partido_participacion','torneo_participante_ranking_cierres'])assert.equal((await pool.query('SELECT count(*)::int n FROM '+table)).rows[0].n,0);
 });
 await run('same score replay idempotent single audit',async()=>{assert.equal((await call(100)).rows[0].result.status,'idempotent');assert.equal((await pool.query('SELECT count(*)::int n FROM nations_official_result_recoveries WHERE partido_id=100')).rows[0].n,1);});
 await run('conflicting result refuses overwrite',()=>deny(100,{...normal,goles_a:0,goles_b:2,historial_sets:[{set:1,a:1,b:6},{set:2,a:0,b:6}]}));
 await run('other actor without grant denied',()=>deny(101,normal,OTHER));
 await run('expired grant denied',async()=>{await pool.query("UPDATE nations_operator.grants SET expires_at=now()-interval '1 second'");try{await deny(102);}finally{await pool.query("UPDATE nations_operator.grants SET expires_at=now()+interval '1 day'");}});
 await run('wrong tournament denied',()=>deny(110));
 await run('existing scoreboard denied',()=>deny(111));
 await run('historical winner mismatches set totals denied',()=>deny(112,{goles_a:2,goles_b:0,historial_sets:[{set:1,a:1,b:6},{set:2,a:2,b:6}]}));
 await run('legal split plus TB10 sudden death accepted',async()=>{assert.equal((await call(113,tb)).rows[0].result.status,'recovered');});
 await run('invalid thirdset TB points denied',()=>deny(114,{...tb,historial_sets:[...tb.historial_sets.slice(0,2),{...tb.historial_sets[2],points_a:11,points_b:9}]}));
 await run('wrong TB metadata denied',()=>deny(115,{...tb,historial_sets:[...tb.historial_sets.slice(0,2),{...tb.historial_sets[2],target:7,win_by:2}]}));
 await run('third set after 2-0 denied',()=>deny(116,{goles_a:2,goles_b:1,historial_sets:[{set:1,a:6,b:0},{set:2,a:6,b:0},{set:3,a:0,b:1,type:'super_tiebreak',points_a:0,points_b:10,target:10,win_by:1}]}));
 await run('noncanonical normal set 6-5 denied',()=>deny(117,{...normal,historial_sets:[{set:1,a:6,b:5},{set:2,a:6,b:1}]}));
 await run('sequence fields not forged',()=>deny(118,{...normal,historial_sets:[{set:9,a:6,b:3},{set:1,a:6,b:1}]}));
 await run('setting restored inside caller transaction',async()=>{const c=await pool.connect();try{await c.query('BEGIN');await c.query("SELECT set_config('padbol.national_final_rpc','test-before',true)");await call(119,normal,GIACOMO,c);assert.equal((await c.query("SELECT current_setting('padbol.national_final_rpc',true) value")).rows[0].value,'test-before');await c.query('ROLLBACK');}finally{c.release();}});
 await run('all nine mapped scoresheet results accepted without invented player evidence',async()=>{
  const preview=JSON.parse(fs.readFileSync('/Users/padbol2022/Documents/Codex/2026-11-20/INCIDENTE-INICIAR-MARCADOR/ROOT-SCORESHEET-9-MATCHES-PREVIEW.json','utf8'));
  assert.equal(preview.matches.length,9);
  for(const row of preview.matches){await pool.query("INSERT INTO partidos VALUES($1,57,101,102,'pendiente',NULL,NULL,'A')",[row.partido_id]);const result={goles_a:row.sets_a,goles_b:row.sets_b,historial_sets:row.historial_sets};const saved=await call(row.partido_id,result);assert.equal(saved.rows[0].result.status,'recovered');}
  assert.equal((await pool.query('SELECT count(*)::int n FROM torneo_partido_participacion')).rows[0].n,0);
  assert.equal((await pool.query('SELECT count(*)::int n FROM torneo_participante_ranking_cierres')).rows[0].n,0);
 });
 const report={migrationPath,migrationSha256:sha,results,productionWrites:false,fixtureDatabase:'nations_result_recovery_test'};
 fs.writeFileSync('/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical/.verification/official-operator-repro/result-recovery-report.json',JSON.stringify(report,null,2));
 console.log(JSON.stringify({pass:results.filter(r=>r.status==='PASS').length,fail:results.filter(r=>r.status==='FAIL').length}));
 if(results.some(r=>r.status==='FAIL'))process.exitCode=1;
}finally{await pool.end();}
