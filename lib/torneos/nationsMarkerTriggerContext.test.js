import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, readSql } from '../fixtures/scoreboardBulkFixture.js';
import { generarScoreboardsForTorneo } from '../../src/scoreboard/scoreboardTorneoService.js';
const base='supabase/migrations/20261108222114_nations_marker_durable.sql';
const repair='supabase/migrations/20261109121000_nations_marker_trigger_context.sql';
async function setup(){const f=await fixture();await generarScoreboardsForTorneo(f.pool,901,{},f.auth);await f.db.exec(readSql(base));await f.db.exec(readSql(repair));await f.db.exec('GRANT SELECT,UPDATE ON scoreboard_partidos,torneos TO service_role');return f;}
test('service role without private schema grants can revoke legacy token and update tracked clock/final state',async()=>{
 const f=await setup();try{
 const id=(await f.rows())[0].id;
 assert.equal((await f.db.query("SELECT has_schema_privilege('service_role','nations_marker_private','USAGE') AS allowed")).rows[0].allowed,false);
 await f.db.exec('SET ROLE service_role');await f.db.query('UPDATE scoreboard_partidos SET control_token_revoked_at=now() WHERE id=$1',[id]);await f.db.exec('RESET ROLE');assert((await f.rows())[0].control_token_revoked_at);
 await f.db.query("INSERT INTO nations_marker_private.nations_marker_match(match_id,states)VALUES($1,'{}')",[id]);
 await f.db.exec('SET ROLE service_role');await f.db.query("UPDATE scoreboard_partidos SET estado='finalizado' WHERE id=$1",[id]);await f.db.exec('RESET ROLE');
 assert.equal(Number((await f.db.query('SELECT revision FROM nations_marker_private.nations_marker_clock_revision WHERE scoreboard_id=$1',[id])).rows[0].revision),1);
 assert.equal((await f.db.query('SELECT * FROM nations_marker_private.nations_marker_terminal WHERE match_id=$1',[id])).rows.length,1);
 }finally{await f.close();}
});
test('definer functions reject a fake table before accessing private state; no data grants to anon/authenticated',async()=>{
 const f=await setup();try{
 const id=(await f.rows())[0].id;await f.db.query("INSERT INTO nations_marker_private.nations_marker_match(match_id,states)VALUES($1,'{}')",[id]);
 for(const name of ['nations_marker_clock_bump','nations_marker_terminal_stamp']){
 await f.db.exec(`CREATE TABLE fake_marker (LIKE scoreboard_partidos); CREATE TRIGGER fake AFTER UPDATE ON fake_marker FOR EACH ROW EXECUTE FUNCTION nations_marker_private.${name}();`);
 await f.db.query("INSERT INTO fake_marker(id,estado)VALUES($1,'pendiente')",[id]);
 await assert.rejects(()=>f.db.query("UPDATE fake_marker SET estado='finalizado'"),/INVALID_MARKER_TRIGGER_CONTEXT/);await f.db.exec('DROP TABLE fake_marker');
 }
 assert.equal((await f.db.query('SELECT * FROM nations_marker_private.nations_marker_clock_revision')).rows.length,0);
 assert.equal((await f.db.query('SELECT * FROM nations_marker_private.nations_marker_terminal')).rows.length,0);
 for(const role of ['anon','authenticated','service_role']){
 await f.db.exec(`SET ROLE ${role}`);await assert.rejects(()=>f.db.query('SELECT * FROM nations_marker_private.nations_marker_match'),{code:'42501'});await f.db.exec('RESET ROLE');
 }
 const defs=(await f.db.query("SELECT prosecdef,proconfig FROM pg_proc WHERE proname IN('nations_marker_clock_bump','nations_marker_terminal_stamp')")).rows;assert(defs.every(d=>d.prosecdef&&d.proconfig.includes('search_path=pg_catalog')));
 await f.db.exec(readSql('sql/rollbacks/nations_marker_trigger_context_rollback.sql'));
 assert((await f.db.query("SELECT prosecdef FROM pg_proc WHERE proname IN('nations_marker_clock_bump','nations_marker_terminal_stamp')")).rows.every(r=>!r.prosecdef));
 }finally{await f.close();}
});
