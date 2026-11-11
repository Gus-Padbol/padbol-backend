import test from 'node:test';
import assert from 'node:assert/strict';
import { fixture, match, ACTOR, uid, readSql, seedRow, exactFunction } from './fixtures/scoreboardBulkFixture.js';
import { generarScoreboardsForTorneo, isPartidoEstadoJugable } from '../src/scoreboard/scoreboardTorneoService.js';
import { verifyControlToken } from '../src/scoreboard/scoreboardControlToken.js';
const run=(f,body={})=>generarScoreboardsForTorneo(f.pool,901,body,f.auth);
const withFixture=async(opts,fn)=>{const f=await fixture(opts);try{await fn(f);}finally{await f.close();}};

test('four future matches share three planned courts without occupying a screen or starting',()=>withFixture({matches:[match(101,1,2,null),match(102,3,4,null),match(103,5,6,null),match(104,7,8,null)]},async f=>{
 const r=await run(f,{canchas_rotacion:['1','2','3']});assert.equal(r.created,4);assert.equal(r.failed,0);assert.deepEqual(r.items.map(i=>i.cancha_prevista),['1','2','3','1']);
 const rows=await f.rows();for(const [n,i]of r.items.entries()){assert.equal(i.cancha,null);assert.equal(i.display_url,null);assert.equal(i.requires_activation,true);assert.equal(i.control_path,`/scoreboard/control/${i.scoreboard_id}`);assert.equal(i.expected_display_path,`/live/cancha/8/${i.cancha_prevista}`);assert(verifyControlToken(i.control_token,rows[n].control_token_hash));assert.equal(rows[n].cronometro_inicio,null);assert.equal(rows[n].estado,'pendiente');}
 const before=await f.rows();const second=await run(f);assert.equal(second.existing,4);assert(second.items.every(i=>i.control_token===null));assert.deepEqual(await f.rows(),before);
}));
test('Nations confirmed roster of four prepares pending from roster without lineup',()=>withFixture({nations:true},async f=>{
 const {players}=await import('./fixtures/scoreboardBulkFixture.js');await f.db.query('UPDATE equipos SET jugadores=$1 WHERE id IN (1,2)',[JSON.stringify(players(1,4))]);await f.db.query('DELETE FROM torneo_partido_alineaciones');
 const r=await run(f);assert.equal(r.created,1);assert.equal(r.failed,0);assert.equal(r.items[0].activation_path,'/api/torneos/901/nations-cup/partidos/101/marcador');
 const row=(await f.rows())[0];assert.equal(row.cancha,null);assert.deepEqual(row.equipo_a_jugadores.map(p=>p.user_id),[101,102,103,104].map(uid));
 await f.db.query('DELETE FROM torneo_partido_alineaciones');const before=await f.rows();const second=await run(f);assert.equal(second.existing,1);assert.deepEqual(await f.rows(),before);
}));
test('missing Nations lineups do not block pending preparation',()=>withFixture({nations:true},async f=>{const {players}=await import('./fixtures/scoreboardBulkFixture.js');await f.db.query('UPDATE equipos SET jugadores=$1 WHERE id IN (1,2)',[JSON.stringify(players(1,4))]);await f.db.query('DELETE FROM torneo_partido_alineaciones');const r=await run(f);assert.equal(r.created,1);assert.equal(r.items[0].status,'created');assert.equal((await f.rows()).length,1);}));
test('a failed later insert preserves prior links and tokens and reports per-item failure',()=>withFixture({matches:[match(),match(102,3,4)]},async f=>{
 await f.db.exec("CREATE FUNCTION synthetic_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.partido_torneo_id=102 THEN RAISE EXCEPTION 'synthetic'; END IF; RETURN NEW; END $$; CREATE TRIGGER synthetic_fail BEFORE INSERT ON scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION synthetic_fail();");
 const r=await run(f);assert.equal(r.ok,false);assert.equal(r.partial,true);assert.equal(r.created,1);assert.equal(r.failed,1);assert.equal(r.items[1].status,'failed');assert(r.items[1].error);assert(verifyControlToken(r.items[0].control_token,(await f.rows())[0].control_token_hash));
 await f.db.exec('DROP TRIGGER synthetic_fail ON scoreboard_partidos');const before=(await f.rows())[0];const retried=await run(f);assert.equal(retried.existing,1);assert.equal(retried.created,1);assert.deepEqual((await f.rows())[0],before);
}));
test('simultaneous calls through serialized fixture return created/existing with one token',()=>withFixture({},async f=>{const r=await Promise.all([run(f),run(f)]);assert.equal(r.reduce((n,x)=>n+x.created,0),1);assert.equal(r.reduce((n,x)=>n+x.existing,0),1);assert.equal((await f.rows()).length,1);}));
test('scope is revalidated inside transaction and client supplied role/sede are ignored',()=>withFixture({},async f=>{
 await f.db.query('UPDATE torneos SET sede_id=9');await assert.rejects(()=>run(f,{role:'super_admin',sede_id:8}),{status:403});assert.equal((await f.rows()).length,0);
 await f.db.query('UPDATE torneos SET sede_id=8');await f.db.query("UPDATE user_roles SET role='jugador'");await assert.rejects(()=>run(f),{status:403});assert.equal((await f.rows()).length,0);
}));
test('foreign match, duplicate markers fail closed; NULL-state marker is reused',()=>withFixture({existing:[{id:'legacy',partido_torneo_id:101,torneo_id:901,sede_id:8,estado:null,cancha:null}]},async f=>{
 const before=await f.rows();const r=await run(f);assert.equal(r.existing,1);assert.deepEqual(await f.rows(),before);
 await f.db.query('UPDATE partidos SET sede_id=9');assert.equal((await run(f)).items[0].error_code,'MATCH_SCOPE_MISMATCH');assert.deepEqual(await f.rows(),before);
}));
test('finished/canceled matches skip; existing running controls preserve scores/clock/hash',()=>withFixture({matches:[{...match(),estado:'en_curso'},{...match(102,3,4),estado:'finalizado'},{...match(103,5,6),estado:'cancelado'}],existing:[{id:'live',partido_torneo_id:101,torneo_id:901,sede_id:8,estado:'en_curso',cancha:'1',score_a:40,games_b:5,cronometro_inicio:'2026-11-01T12:00:00Z',control_token_hash:'synthetic-old'}]},async f=>{const before=await f.rows();const r=await run(f);assert.equal(r.existing,1);assert.equal(r.skipped,2);assert.equal(r.items[0].display_path,'/live/cancha/8/1');assert.deepEqual(await f.rows(),before);}));
test('explicit reissue only; failed reissue preserves existing hash and link',()=>withFixture({},async f=>{
 const a=await run(f,{emitir_tokens:false});assert.equal(a.items[0].control_token,null);
 const b=await run(f,{reemitir_tokens:true});assert(verifyControlToken(b.items[0].control_token,(await f.rows())[0].control_token_hash));const before=await f.rows();
 await f.db.exec("CREATE FUNCTION synthetic_token_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'synthetic'; END $$; CREATE TRIGGER synthetic_token_fail BEFORE UPDATE ON scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION synthetic_token_fail();");
 const c=await run(f,{reemitir_tokens:true});assert.equal(c.failed,1);assert.equal(c.items[0].control_token,null);assert(c.items[0].control_path);assert.deepEqual(await f.rows(),before);
}));
test('missing pool and invalid authentication fail closed before writes',async()=>{await assert.rejects(()=>generarScoreboardsForTorneo(null,901,{}, {user:{id:ACTOR}}),{status:503});await assert.rejects(()=>generarScoreboardsForTorneo(null,901),{status:401});await assert.rejects(()=>generarScoreboardsForTorneo(null,'901bad'),{status:400});});
test('activation claims one real court atomically, rejects busy court and Start before allocation',()=>withFixture({matches:[match(),match(102,3,4,'1'),match(103,1,5,'2')]},async f=>{
 const r=await run(f);assert.equal(r.created,3);const id=r.items[0].scoreboard_id;
 await assert.rejects(()=>f.db.query("UPDATE scoreboard_partidos SET estado='en_curso',cronometro_inicio=now() WHERE id=$1",[id]),{code:'55000'});
 await f.db.query('SELECT preparar_marcador_torneo_ahora(901,101,$1,13)',[ACTOR]);
 assert.equal((await f.rows())[0].cancha,'1');await assert.rejects(()=>f.db.query('SELECT preparar_marcador_torneo_ahora(901,102,$1,13)',[ACTOR]),{code:'23505'});
 await assert.rejects(()=>f.db.query('SELECT preparar_marcador_torneo_ahora(901,103,$1,14)',[ACTOR]),{code:'23505'});
 await f.db.query("UPDATE scoreboard_partidos SET estado='en_curso',cronometro_inicio=now() WHERE id=$1",[id]);assert.equal((await f.rows())[0].estado,'en_curso');assert((await f.rows()).slice(1).every(s=>s.cancha===null));
}));
test('Nations pending scheduled match activates without changing roster, token or clock',()=>withFixture({nations:true},async f=>{const {players}=await import('./fixtures/scoreboardBulkFixture.js');await f.db.query('UPDATE equipos SET jugadores=$1 WHERE id IN (1,2)',[JSON.stringify(players(1,4))]);await run(f);const before=(await f.rows())[0];await f.db.query('SELECT preparar_marcador_torneo_ahora(901,101,$1,13)',[ACTOR]);const after=(await f.rows())[0];assert.equal(after.cancha,'1');assert.equal(after.control_token_hash,before.control_token_hash);assert.deepEqual(after.equipo_a_jugadores,before.equipo_a_jugadores);assert.equal(after.cronometro_inicio,null);}));
test('legacy unlinked marker and claimed pending markers keep their occupation semantics',()=>withFixture({existing:[{id:'manual',sede_id:8,cancha:'1',estado:'pendiente'}]},async f=>{await run(f);await assert.rejects(()=>f.db.query('SELECT preparar_marcador_torneo_ahora(901,101,$1,13)',[ACTOR]),{code:'23505'});assert.equal((await f.rows()).find(s=>s.id==='manual').cancha,'1');}));
test('rollback reinstates old guard without deleting prepared markers',()=>withFixture({},async f=>{await run(f);const before=await f.rows();await f.db.exec(readSql('sql/rollbacks/scoreboard_bulk_preparation_rollback.sql'));assert.deepEqual(await f.rows(),before);}));
test('terminal state predicate remains compatible',()=>{for(const state of ['finalizado','FINALIZADO',' terminada ','cancelado'])assert.equal(isPartidoEstadoJugable(state),false);for(const state of ['pendiente','programado','en_curso',null])assert.equal(isPartidoEstadoJugable(state),true);});
test('missing migration fails closed before creating a pending marker',()=>withFixture({patched:false},async f=>{await assert.rejects(()=>run(f),{code:'BULK_MIGRATION_REQUIRED'});assert.equal((await f.rows()).length,0);}));
test('reviewed candidates exist without deployable duplicates and clock-only Start cannot bypass activation',()=>withFixture({},async f=>{
 for(const name of ['20261109120000_scoreboard_bulk_preparation.sql','20261109121000_nations_marker_trigger_context.sql'])assert.ok(readSql(`sql/candidates/${name}`).length>0);
 await run(f);await assert.rejects(()=>f.db.query('UPDATE scoreboard_partidos SET cronometro_inicio=now()'),{code:'55000'});
}));

test('migration preserves suspension wrapper profile and rollback restores exact function fingerprints',()=>withFixture({patched:false},async f=>{
 await f.db.exec(exactFunction('sql/20261021140000_scoreboard_suspend_candidate.sql','proteger_cancha_marcador_activo'));
 await f.db.exec('ALTER FUNCTION preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint) RENAME TO preparar_marcador_antes_ocupacion_candidate');
 let source=(await f.db.query("SELECT pg_get_functiondef('preparar_marcador_antes_ocupacion_candidate(bigint,bigint,uuid,bigint)'::regprocedure) AS source")).rows[0].source;
 const changes=readSql('sql/20261021175000_scoreboard_suspended_readers_candidate.sql');const section=changes.slice(changes.indexOf(" source := pg_get_functiondef(to_regprocedure('public.preparar_marcador_antes"));
 for(const [,old,next]of section.matchAll(/replace\((?:source|patched), \$old\$([^]*?)\$old\$, \$new\$([^]*?)\$new\$\)/g))source=source.replaceAll(old,next);
 await f.db.exec(source);let wrapper=readSql('sql/20261021173000_scoreboard_prepare_order_candidate.sql');await f.db.exec(wrapper.slice(wrapper.indexOf('CREATE FUNCTION'),wrapper.indexOf('REVOKE ALL ON FUNCTION public.preparar_marcador_torneo_ahora')));
 const fingerprints=async()=>(await f.db.query("SELECT proname,md5(pg_get_functiondef(oid)) AS digest FROM pg_proc WHERE proname IN ('proteger_marcador_nations','proteger_cancha_marcador_activo','preparar_marcador_torneo_ahora','preparar_marcador_antes_ocupacion_candidate') ORDER BY proname")).rows;
 const before=await fingerprints();await f.db.exec(readSql('sql/candidates/20261109120000_scoreboard_bulk_preparation.sql'));
 const occupancy=(await f.db.query("SELECT pg_get_functiondef('proteger_cancha_marcador_activo()'::regprocedure) AS source")).rows[0].source;assert(occupancy.includes("'cancelado','suspendido'"));assert(!/FROM (?:canchas|partidos|equipos|torneos|scoreboard_partidos) /.test(occupancy));
 await f.db.exec(readSql('sql/rollbacks/scoreboard_bulk_preparation_rollback.sql'));assert.deepEqual(await fingerprints(),before);
}));
test('migration refuses duplicate nullable legacy markers without deleting either',()=>withFixture({patched:false,existing:[{id:'a',partido_torneo_id:101,torneo_id:901,sede_id:8,estado:null},{id:'b',partido_torneo_id:101,torneo_id:901,sede_id:8,estado:'pendiente'}]},async f=>{
 const before=await f.rows();await assert.rejects(()=>f.db.exec(readSql('sql/candidates/20261109120000_scoreboard_bulk_preparation.sql')),{code:'23505'});await f.db.query('ROLLBACK');assert.deepEqual(await f.rows(),before);
}));
test('unknown function drift aborts migration rather than discarding protections',()=>withFixture({patched:false},async f=>{
 await f.db.exec("ALTER FUNCTION proteger_cancha_marcador_activo() SET work_mem='12MB'");await assert.rejects(()=>f.db.exec(readSql('sql/candidates/20261109120000_scoreboard_bulk_preparation.sql')),/fingerprint/);await f.db.query('ROLLBACK');
}));
test('unresolved teams and terminated matches skip; a complete pending final still prepares',()=>withFixture({matches:[match(101,null,2),{...match(102,3,4),estado:'terminado'},match(103,5,6)]},async f=>{
 const r=await run(f);assert.equal(r.created,1);assert.equal(r.skipped,2);assert.deepEqual(r.items.map(i=>i.skip_reason),['missing_teams','estado_no_jugable',null]);assert.equal(r.items[2].status,'created');
}));
test('Nations confirmed roster 2, 3 and 4 prepares without auto starters',()=>withFixture({nations:true},async f=>{
 const {players}=await import('./fixtures/scoreboardBulkFixture.js');
 for (const n of [2,3,4]) { await f.db.query('DELETE FROM scoreboard_partidos'); await f.db.query('UPDATE equipos SET jugadores=$1 WHERE id IN (1,2)',[JSON.stringify(players(1,n))]); const r=await run(f); assert.equal(r.created,1,`roster ${n}`); assert.equal((await f.rows())[0].estado,'pendiente'); }
 await f.db.query('DELETE FROM scoreboard_partidos'); await f.db.query('UPDATE equipos SET jugadores=$1 WHERE id=1',[JSON.stringify(players(1,8))]); assert.equal((await run(f)).items[0].skip_reason,'national_roster_incomplete');
}));
test('canceled, suspended and unknown existing rows keep links without false allocation or token changes',()=>withFixture({matches:[match(),match(102,3,4),match(103,5,6)],existing:[{id:'a',partido_torneo_id:101,torneo_id:901,sede_id:8,estado:'cancelado',cancha:null,control_token_hash:'old-a'},{id:'b',partido_torneo_id:102,torneo_id:901,sede_id:8,estado:'suspendido',cancha:null,control_token_hash:'old-b'},{id:'c',partido_torneo_id:103,torneo_id:901,sede_id:8,estado:null,cancha:null,control_token_hash:'old-c'}]},async f=>{
 const before=await f.rows();const r=await run(f);assert.equal(r.existing,3);assert(r.items.every(i=>i.control_path&&i.estado_preparacion==='requiere_revision'));assert.deepEqual(await f.rows(),before);
 // Explicit reissue is suppressed for suspended/canceled controls.
 await f.db.query('DELETE FROM scoreboard_partidos WHERE id=$1',['c']);await f.db.query('DELETE FROM partidos WHERE id=103');const remaining=await f.rows();const reissued=await run(f,{reemitir_tokens:true});assert(reissued.items.every(i=>i.control_token===null));assert.deepEqual(await f.rows(),remaining);
}));
test('sin partidos concretos no crea links ni marcadores y explica el gate',()=>withFixture({matches:[],nations:true},async f=>{const r=await run(f);assert.equal(r.total,0);assert.equal(r.created,0);assert.equal(r.code,'NO_ELIGIBLE_MATCHES');assert.match(r.message,/grupos estén armados/);assert.equal((await f.rows()).length,0);}));
test('partido placeholder/TBD no prepara ni emite display esperado',()=>withFixture({matches:[match(101,null,2)],nations:true},async f=>{const r=await run(f);assert.equal(r.created,0);assert.equal(r.skipped,1);assert.equal(r.items[0].skip_reason,'missing_teams');assert.equal(r.items[0].expected_display_path,null);assert.equal(r.items[0].display_path,null);assert.equal((await f.rows()).length,0);}));
test('scoreboard existente de partido placeholder se preserva sin nuevos links',()=>withFixture({matches:[match(101,null,2)],nations:true,existing:[{id:'legacy',partido_torneo_id:101,torneo_id:901,sede_id:8,estado:'pendiente',cancha:null}]},async f=>{const r=await run(f);assert.equal(r.skipped,1);assert.equal(r.items[0].skip_reason,'missing_teams');assert.equal(r.items[0].expected_display_path,null);assert.equal(r.items[0].control_path,null);assert.equal((await f.rows()).length,1);}));
