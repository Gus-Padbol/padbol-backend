// Entirely local PGlite: real mutation RPC, occupancy wrapper, ledger and guard.
// PGlite is single-connection; the START interleaving is deterministic, not a
// claim of a multi-session PostgreSQL deadlock/concurrency test.
import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite();
const id='00000000-0000-4000-8000-000000000001';
let request=0;
const load=async name=>db.exec(await readFile(new URL(`../${name}`,import.meta.url),'utf8'));
try {
 await db.exec(`CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;
 CREATE TABLE public.scoreboard_partidos(id uuid PRIMARY KEY,estado text,saque_actual text,
 score_a int,score_b int,games_a int,games_b int,sets_a int,sets_b int,historial_sets jsonb,
 es_tiebreak bool,ultimo_punto text,historial_puntos jsonb,updated_at timestamptz,
 cronometro_inicio timestamptz,cronometro_pausado bool,cronometro_segundos int,
 control_token_hash text,control_token_revoked_at timestamptz,sync_torneo_status text,
 partido_torneo_id bigint,torneo_id bigint,sede_id bigint);
 CREATE TABLE public.scoreboard_historial_puntos(id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
 partido_id uuid,equipo text,score_a_antes text,score_b_antes text,set_numero int,
 games_a_antes int,games_b_antes int,sets_a_antes jsonb,sets_b_antes jsonb,
 es_tiebreak_antes bool,estado_antes text,historial_sets_antes jsonb,saque_actual_antes text);
 CREATE SCHEMA nations_marker_private;
 CREATE TABLE nations_marker_private.nations_marker_match(match_id text PRIMARY KEY,
 revision int,states jsonb,receipts jsonb,updated_at timestamptz);
 CREATE TABLE nations_marker_private.nations_marker_audit(match_id text,revision int,kind text,actor text,payload jsonb);
 INSERT INTO scoreboard_partidos(id,estado,saque_actual,score_a,score_b,games_a,games_b,sets_a,sets_b,
 historial_sets,es_tiebreak,historial_puntos,updated_at,cronometro_inicio,cronometro_pausado,cronometro_segundos)
 VALUES('${id}','pendiente','A',0,0,0,0,0,0,'[]',false,'[]',now(),null,false,0);`);
 await load('20261021120000_scoreboard_atomic_mutation.sql');
 await load('20261021172000_scoreboard_mutation_order_candidate.sql');
 await load('candidates/nations_games_atomic_history.sql');
 await load('candidates/nations_games_commands.sql');
 await load('candidates/nations_games_legacy_guard.sql');
 const row=async()=>(await db.query('SELECT *,updated_at::text AS version FROM scoreboard_partidos WHERE id=$1',[id])).rows[0];
 const history=()=>({equipo:'A',games_a_antes:0,games_b_antes:0,historial_sets_antes:[]});
 const legacy=async(next,kind='update',h=null,hid=null)=>(await db.query(
  'SELECT public.scoreboard_commit_mutation($1,$2,$3,$4,$5,$6) result',
  [id,(await row()).version,JSON.stringify(next),kind,h===null?null:JSON.stringify(h),hid])).rows[0].result;
 const command=async(kind,next,h=null,hid=null)=>{
  const key=`10000000-0000-4000-8000-${String(++request).padStart(12,'0')}`;
  return (await db.query('SELECT nations_marker_private.commit_games_command_candidate($1,$2,$3,$4,$5,$6,$7) result',
   [id,key,JSON.stringify({kind,epoch:0,actorId:'test-referee',...(kind==='point'?{team:'A'}:{}),...(hid?{historyId:hid}:{})}),
    (await row()).version,JSON.stringify(next),h===null?null:JSON.stringify(h),hid])).rows[0].result;
 };
 const context=async()=>(await db.query("SELECT current_setting('padbol.nations_games_command',true) value")).rows[0].value;
 const reset={estado:'pendiente',score_a:0,score_b:0,games_a:0,games_b:0,sets_a:0,sets_b:0,
  historial_sets:[],historial_puntos:[],es_tiebreak:false,ultimo_punto:null,
  cronometro_inicio:null,cronometro_pausado:false,cronometro_segundos:0};
 // Legacy untracked writes continue working.
 await legacy({estado:'en_curso',cronometro_inicio:'2026-11-10T00:00:00Z'});
 await legacy({score_a:15},'point',history());
 const oldHistory=(await db.query('SELECT id FROM scoreboard_historial_puntos')).rows[0].id;
 await legacy({score_a:0},'undo',null,oldHistory);
 await legacy(reset);
 await db.query('UPDATE scoreboard_partidos SET torneo_id=9,partido_torneo_id=77,sede_id=3 WHERE id=$1',[id]);
 console.log('PASS untracked legacy point, undo and reset remain available');

 // Request A observed no tracking. Request B then performs START's lock/insert
 // transaction. Request A continues with a fresh version to isolate the guard.
 assert.equal((await db.query('SELECT * FROM nations_marker_private.nations_marker_match')).rows.length,0);
 await db.exec('BEGIN');
 await db.exec("SELECT pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0))");
 await db.query('SELECT id FROM scoreboard_partidos WHERE id=$1 FOR UPDATE',[id]);
 await db.query("INSERT INTO nations_marker_private.nations_marker_match(match_id,revision,states,receipts,updated_at) VALUES($1,0,'{}','{}',now())",[id]);
 await legacy({estado:'en_curso',cronometro_inicio:'2026-11-10T00:00:00Z'});
 await db.exec('COMMIT');
 for(const field of ['torneo_id','partido_torneo_id','sede_id']){
  for(const value of [null,999])await assert.rejects(
   db.query(`UPDATE scoreboard_partidos SET ${field}=$2 WHERE id=$1`,[id,value]),/GAME_TRACKING_SCOPE_FROZEN/);
 }
 await db.query('UPDATE scoreboard_partidos SET torneo_id=9,partido_torneo_id=77,sede_id=3 WHERE id=$1',[id]);
 // Scope guard runs before the command context, and cannot be bypassed by it.
 await db.exec('BEGIN');
 await db.query("SELECT set_config('padbol.nations_games_command',$1,true)",[JSON.stringify({scoreboardId:id,requestId:'internal',kind:'reset'})]);
 await db.exec('SAVEPOINT changed_scope');
 await assert.rejects(db.query('UPDATE scoreboard_partidos SET torneo_id=NULL WHERE id=$1',[id]),/GAME_TRACKING_SCOPE_FROZEN/);
 await db.exec('ROLLBACK TO SAVEPOINT changed_scope');
 await db.exec('ROLLBACK');
 console.log('PASS tracked scope rejects reassignment/null and command context bypass; identical links remain valid');
 await assert.rejects(legacy({score_a:15},'point',history()),/GAME_COMMAND_REQUIRED/);
 await assert.rejects(legacy(reset),/GAME_COMMAND_REQUIRED/);
 assert.equal((await row()).score_a,0);
 console.log('PASS lookup-untracked then START interleaving rejects legacy point and zero-score reset');

 // Even a no-score-change point/history insert cannot bypass the command gate.
 await assert.rejects(legacy({},'point',history()),/GAME_COMMAND_REQUIRED/);
 await assert.rejects(db.query('INSERT INTO scoreboard_historial_puntos(partido_id) VALUES($1)',[id]),/GAME_COMMAND_REQUIRED/);
 await assert.rejects(db.query('UPDATE scoreboard_partidos SET score_a=15 WHERE id=$1',[id]),/GAME_COMMAND_REQUIRED/);
 console.log('PASS history-only and direct score writers also fail closed');

 await legacy({cronometro_inicio:null,cronometro_pausado:true,cronometro_segundos:12});
 await legacy({cronometro_inicio:'2026-11-10T00:00:15Z',cronometro_pausado:false});
 await db.query("UPDATE scoreboard_partidos SET estado='suspendido',control_token_hash='rotated',control_token_revoked_at=now(),sync_torneo_status='synced' WHERE id=$1",[id]);
 await db.query("UPDATE scoreboard_partidos SET estado='en_curso' WHERE id=$1",[id]);
 assert.equal((await row()).control_token_hash,'rotated');
 assert.equal((await row()).cronometro_segundos,12);
 console.log('PASS start/pause/resume, ordinary status, token and sync metadata remain permitted');

 await command('point',{score_a:15},history());
 assert.equal((await row()).score_a,15);
 assert.ok(!await context());
 const hid=(await db.query('SELECT id FROM scoreboard_historial_puntos')).rows[0].id;
 await db.exec('BEGIN');
 await db.query("SELECT set_config('padbol.nations_games_command',$1,true)",[JSON.stringify({scoreboardId:id,requestId:'tiebreak-test',kind:'tiebreak'})]);
 await db.query('UPDATE scoreboard_partidos SET es_tiebreak=true,score_a=0,score_b=0 WHERE id=$1',[id]);
 assert.equal((await row()).es_tiebreak,true);
 await db.exec('SAVEPOINT tiebreak_no_history');
 await assert.rejects(db.query('INSERT INTO scoreboard_historial_puntos(partido_id) VALUES($1)',[id]),/GAME_COMMAND_REQUIRED/);
 await db.exec('ROLLBACK TO SAVEPOINT tiebreak_no_history');
 await assert.rejects(db.query('DELETE FROM scoreboard_historial_puntos WHERE id=$1',[hid]),/GAME_COMMAND_REQUIRED/);
 await db.exec('ROLLBACK TO SAVEPOINT tiebreak_no_history');
 await db.exec('ROLLBACK');
 assert.equal((await row()).score_a,15);
 console.log('PASS scoped tiebreak context permits scoreboard update but rejects history INSERT/DELETE');
 await assert.rejects(legacy({score_a:0},'undo',null,hid),/GAME_COMMAND_REQUIRED/);
 assert.equal((await db.query('SELECT count(*)::int n FROM scoreboard_historial_puntos')).rows[0].n,1);
 await command('undo',{score_a:0},null,hid);
 assert.equal((await row()).score_a,0);
 assert.equal((await db.query('SELECT count(*)::int n FROM scoreboard_historial_puntos')).rows[0].n,0);
 console.log('PASS real Nations point/undo succeeds; rejected legacy undo preserves history');

 // Internal context is board-scoped and restored within a surrounding transaction.
 await db.exec('BEGIN');
 const sentinel=JSON.stringify({scoreboardId:'00000000-0000-4000-8000-000000000099',requestId:'outer',kind:'point'});
 await db.query("SELECT set_config('padbol.nations_games_command',$1,true)",[sentinel]);
 await command('point',{score_a:15},history());
 assert.equal(await context(),sentinel);
 await db.exec('SAVEPOINT wrong_board');
 await assert.rejects(legacy({score_a:30},'point',history()),/GAME_COMMAND_REQUIRED/);
 await db.exec('ROLLBACK TO SAVEPOINT wrong_board');
 await db.exec('ROLLBACK');
 assert.equal((await row()).score_a,0);
 console.log('PASS context is scoped, restored on success and outer rollback removes score/receipt');

 await db.exec(`CREATE FUNCTION fail_guard_test() RETURNS trigger LANGUAGE plpgsql AS $$
 BEGIN IF NEW.score_a=99 THEN RAISE EXCEPTION 'synthetic guard test'; END IF; RETURN NEW; END $$;
 CREATE TRIGGER z_fail_guard_test BEFORE UPDATE ON scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION fail_guard_test();`);
 await db.exec('BEGIN');
 await db.query("SELECT set_config('padbol.nations_games_command',$1,true)",[sentinel]);
 await db.exec('SAVEPOINT failed_command');
 await assert.rejects(command('point',{score_a:99},history()),/synthetic guard test/);
 await db.exec('ROLLBACK TO SAVEPOINT failed_command');
 assert.equal(await context(),sentinel);
 assert.equal((await row()).score_a,0);
 await db.exec('ROLLBACK');
 assert.ok(!await context());
 console.log('PASS failing real command restores context and rolls back score/history');

 await command('reset',reset);
 assert.equal((await row()).estado,'pendiente');
 const aggregate=(await db.query('SELECT games_epoch,tracking_status FROM nations_marker_private.nations_marker_match')).rows[0];
 assert.equal(aggregate.games_epoch,1);assert.equal(aggregate.tracking_status,'reset_pending');
 assert.ok(!await context());
 assert.equal((await db.query("SELECT has_function_privilege('authenticated','nations_marker_private.guard_games_legacy_mutation_candidate()','execute') ok")).rows[0].ok,false);
 console.log('PASS real Nations reset succeeds atomically and guard has no public execute grant');

 // A pending durable intent pins identity even if its aggregate is absent.
 const orphan='00000000-0000-4000-8000-000000000002';
 await db.query('INSERT INTO scoreboard_partidos(id,torneo_id,partido_torneo_id,sede_id) VALUES($1,9,78,3)',[orphan]);
 await db.query(`INSERT INTO nations_marker_private.games_finalization_intents
  (scoreboard_id,epoch,request_id,partido_torneo_id,final_snapshot) VALUES($1,0,gen_random_uuid(),78,'{}')`,[orphan]);
 for(const field of ['torneo_id','partido_torneo_id','sede_id']){
  await assert.rejects(db.query(`UPDATE scoreboard_partidos SET ${field}=NULL WHERE id=$1`,[orphan]),/GAME_TRACKING_SCOPE_FROZEN/);
 }
 await db.query("UPDATE scoreboard_partidos SET control_token_hash='new',sync_torneo_status='synced' WHERE id=$1",[orphan]);
 await db.query("UPDATE nations_marker_private.games_finalization_intents SET status='completed' WHERE scoreboard_id=$1",[orphan]);
 await db.query('UPDATE scoreboard_partidos SET torneo_id=NULL,partido_torneo_id=NULL,sede_id=NULL WHERE id=$1',[orphan]);
 await db.query("INSERT INTO nations_marker_private.nations_marker_match(match_id,revision,states,receipts) VALUES($1,0,'{}','{}')",[orphan]);
 for(const field of ['torneo_id','partido_torneo_id','sede_id']){
  await assert.rejects(db.query(`UPDATE scoreboard_partidos SET ${field}=999 WHERE id=$1`,[orphan]),/GAME_TRACKING_SCOPE_FROZEN/);
 }
 console.log('PASS pending intent alone pins scope; tracked null-to-value changes reject; metadata and untracked completed intent remain unchanged');
} finally {await db.close();}
