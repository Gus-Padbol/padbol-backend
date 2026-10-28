import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';

test('watch mutation keeps history atomic, deduplicates retries and conflicts with phone writes',async()=>{
 const db=new PGlite();
 try {
 await db.exec('CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role; CREATE TABLE sedes(id int primary key); CREATE TABLE torneos(id int primary key);');
 await db.exec(await readFile(new URL('../docs/sql/scoreboard.sql',import.meta.url),'utf8'));
 let history=await readFile(new URL('../docs/sql/scoreboard_historial_puntos.sql',import.meta.url),'utf8');
 history=history.replace('id BIGSERIAL PRIMARY KEY','id UUID PRIMARY KEY DEFAULT gen_random_uuid()'); await db.exec(history);
 await db.exec(await readFile(new URL('../sql/20261021120000_scoreboard_atomic_mutation.sql',import.meta.url),'utf8'));
 await db.exec(await readFile(new URL('../sql/20261028230000_scoreboard_watch_production.sql',import.meta.url),'utf8'));
 const {rows:[board]}=await db.query("INSERT INTO scoreboard_partidos(equipo_a_nombre,equipo_b_nombre,estado,cronometro_inicio) VALUES('A','B','en_curso',now()) RETURNING *");
 const {rows:[session]}=await db.query("INSERT INTO scoreboard_control_sessions(scoreboard_id,device_id,expires_at,token_hash) VALUES($1,'watch-unit',now()+interval '1 hour','hash') RETURNING *",[board.id]);
 const call=async(action,revision,updated,next,kind='update',h=null)=>{
  const {rows:[r]}=await db.query('SELECT scoreboard_apply_watch_action($1,$2,$3,$4,$5,$6,$7,$8,$9) AS result',[session.id,action,'watch-unit',revision,updated,JSON.stringify(next),kind,h&&JSON.stringify(h),null]);return r.result;
 };
 const h={equipo:'A',score_a_antes:0,score_b_antes:0,set_numero:1,games_a_antes:0,games_b_antes:0,sets_a_antes:0,sets_b_antes:0,es_tiebreak_antes:false,estado_antes:'en_curso',historial_sets_antes:[],saque_actual_antes:'A'};
 const first=await call('action-0001',0,board.updated_at,{score_a:15,historial_puntos:[{}]},'point',h);
 assert.equal(first.status,'applied');assert.equal(first.revision,1);
 const duplicate=await call('action-0001',0,board.updated_at,{score_a:30},'point',h);assert.equal(duplicate.deduplicated,true);
 const {rows:[count]}=await db.query('SELECT count(*)::int AS n FROM scoreboard_historial_puntos');assert.equal(count.n,1);
 await db.query("UPDATE scoreboard_partidos SET score_b=15 WHERE id=$1",[board.id]);
 const conflict=await call('action-0002',1,first.scoreboard.updated_at,{score_a:30});assert.equal(conflict.status,'conflict');assert.equal(conflict.revision,2);
 const {rows:[current]}=await db.query('SELECT score_a,score_b,revision FROM scoreboard_partidos');assert.deepEqual(current,{score_a:15,score_b:15,revision:2});
 await db.query('UPDATE scoreboard_control_sessions SET revoked_at=now() WHERE id=$1',[session.id]);
 await assert.rejects(call('action-0001',0,board.updated_at,{}),/CONTROL_SESSION_INACTIVE/);
 await db.exec('SET ROLE authenticated');
 await assert.rejects(db.query('SELECT * FROM scoreboard_control_sessions'),/permission denied/);
 }finally{await db.close();}
});

test('pairing is one-use, bound to one device, and stores only a token hash',async()=>{
 const db=new PGlite();try{
 await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;CREATE TABLE sedes(id int primary key);CREATE TABLE torneos(id int primary key);');
 await db.exec(await readFile(new URL('../docs/sql/scoreboard.sql',import.meta.url),'utf8'));
 // The production migration delegates mutations to an already-existing routine.
 await db.exec('CREATE FUNCTION scoreboard_commit_mutation(uuid,timestamptz,jsonb,text,jsonb,uuid) RETURNS jsonb LANGUAGE SQL AS $$ SELECT NULL::jsonb $$');
 await db.exec(await readFile(new URL('../sql/20261028230000_scoreboard_watch_production.sql',import.meta.url),'utf8'));
 const {rows:[b]}=await db.query("INSERT INTO scoreboard_partidos(equipo_a_nombre,equipo_b_nombre) VALUES('A','B') RETURNING id");
 await db.query("INSERT INTO scoreboard_control_sessions(scoreboard_id,pairing_code_hash,pairing_expires_at,expires_at) VALUES($1,'code-hash',now()+interval '5 minutes',now()+interval '1 hour')",[b.id]);
 const {rows:[first]}=await db.query("SELECT scoreboard_claim_watch_pairing('code-hash','watch-one',repeat('a',64)) AS r");assert.equal(first.r.status,'claimed');assert.equal('control_token' in first.r,false);
 const {rows:[again]}=await db.query("SELECT scoreboard_claim_watch_pairing('code-hash','watch-two',repeat('b',64)) AS r");assert.equal(again.r.status,'invalid');
 const {rows:[s]}=await db.query('SELECT device_id,token_hash,pairing_code_hash FROM scoreboard_control_sessions');assert.deepEqual(s,{device_id:'watch-one',token_hash:'a'.repeat(64),pairing_code_hash:null});
 }finally{await db.close();}
});
