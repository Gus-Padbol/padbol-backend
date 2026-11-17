import {PGlite} from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
import assert from 'node:assert/strict';
const db=new PGlite();
const load=async p=>db.exec(await readFile(p,'utf8'));
await db.exec(`CREATE SCHEMA IF NOT EXISTS extensions; CREATE SCHEMA IF NOT EXISTS nations_operator; CREATE FUNCTION nations_operator.has_grant(uuid,bigint,text) RETURNS boolean LANGUAGE sql IMMUTABLE AS $$ SELECT false $$; CREATE TABLE IF NOT EXISTS public.torneo_nations_planes(torneo_id bigint PRIMARY KEY, plan jsonb, updated_at timestamptz DEFAULT now()); CREATE FUNCTION extensions.digest(text,text) RETURNS bytea LANGUAGE sql IMMUTABLE AS $$ SELECT decode(md5($1),'hex') $$; CREATE ROLE anon; CREATE ROLE authenticated; CREATE ROLE service_role;`);
for(const p of [
 'sql/tests/20261016_selection_integrated_bootstrap.sql',
 'sql/20261010150000_padbol_national_rosters_lineups.sql',
 'sql/migrations/20261016100000_tournament_planning.sql',
 'sql/migrations/20261016140000_tournament_generic_participants.sql',
 'sql/migrations/20261016103000_generic_selection_lineups.sql',
 'sql/migrations/20261016160000_generic_selection_compatibility.sql',
 'sql/tests/20261016_nations_registry_bootstrap.sql',
 'sql/20261011150000_nations_cup_event_plan.sql',
 '/Users/padbol2022/Documents/Codex/2026-11-16/Cierre-Torneo/ACTUAL-guardar_plan_nations_before_occupancy_candidate.sql',
 '/Users/padbol2022/Documents/Codex/2026-11-16/Cierre-Torneo/ACTUAL-finalizar_torneo_seleccion.sql',
 '/Users/padbol2022/Documents/Codex/2026-11-16/Cierre-Torneo/ACTUAL-proteger_plan_nations.sql',
 '/Users/padbol2022/Documents/Codex/2026-11-16/Cierre-Torneo/ACTUAL-GUARDAR-PLAN-NATIONS.sql',
 'sql/20261117_nations57_tour500_guard.sql',
 'sql/migrations/20261016150000_participant_official_accreditation.sql',
 'sql/migrations/20261016170000_nations_registered_participants.sql',
 'sql/migrations/20261016180000_participant_ranking_closure_snapshot.sql',
 'sql/migrations/20261016190000_sync_linked_scoreboard_final_result.sql',
 'sql/20261021174000_scoreboard_final_result_order_candidate.sql',
 'sql/20261116_nations_awards_finalize.sql',
]) await load(p);
await db.exec('CREATE TABLE IF NOT EXISTS public.scoreboard_linked_suspend_candidate(id bigint,partido_id bigint,scoreboard_id bigint,estado text,booking_id bigint,open_id bigint); CREATE TABLE IF NOT EXISTS public.torneo_nations_programacion(partido_id bigint,torneo_id bigint,court_id bigint,inicio timestamptz,duration_minutes integer,timezone text,actor_id uuid,revision bigint,updated_at timestamptz DEFAULT now(),UNIQUE(partido_id)); ALTER TABLE public.scoreboard_partidos ADD COLUMN IF NOT EXISTS reserva_id bigint, ADD COLUMN IF NOT EXISTS partido_abierto_id bigint; CREATE TABLE IF NOT EXISTS public.partidos_abiertos(id bigint,reserva_id bigint);');
await load('sql/tests/20261116_nations_awards_registry_assertions.sql');
console.log('ok - canonical finalization with awards migration');
// Awards RPC: replay, void/reactivation, stale revision, policy gate and rollback.
await db.exec(`INSERT INTO public.torneos(id,sede_id,es_prueba,deporte,modalidad_plantel,formato_equipo,estado,tipo_torneo,costo_inscripcion,nivel_torneo,fecha_inicio,fecha_fin) VALUES(91000,8,true,'padbol','selecciones','dobles','en_curso','grupos_knockout',0,'internacional','2026-11-20','2026-11-22');
INSERT INTO public.torneo_nations_planes(torneo_id,plan) VALUES(91000,'{"revision":4,"award_policy":{"confirmed":true,"denominatorMode":"max_player_sets","bonusProration":"none"}}');
INSERT INTO public.user_roles(user_id,role,sede_id) VALUES('11111111-1111-4111-8111-111111111111','super_admin',NULL) ON CONFLICT(user_id) DO UPDATE SET role='super_admin',sede_id=NULL;`);
const awards=(rows,rev=4)=>db.query(`SELECT public.guardar_nations_awards(91000,$1::jsonb) AS r`,[JSON.stringify({definitive:true,sourceRevision:rev,policy:{denominatorMode:'max_player_sets',bonusProration:'none'},rows})]);
const row=(id,name,points,digest='a'.repeat(64))=>({playerId:id,playerName:name,key:`91000:${id}`,position:'1',base:points,bonus:0,coefficient:1,points,sourceDigest:digest});
await awards([row('p1','Player One',500),row('p2','Player Two',300)]);
assert.equal((await db.query("SELECT count(*)::int n FROM public.nations_awards WHERE torneo_id=91000 AND status='awarded'")).rows[0].n,2);
await awards([row('p1','Player One',500),row('p2','Player Two',300)]);
assert.equal((await db.query("SELECT count(*)::int n FROM public.nations_awards WHERE torneo_id=91000 AND status='awarded'")).rows[0].n,2);
await awards([row('p1','Player One',500)]);
assert.equal((await db.query("SELECT status FROM public.nations_awards WHERE torneo_id=91000 AND player_id='p2'")).rows[0].status,'void');
await awards([row('p1','Player One',500),row('p2','Player Two',300)]);
assert.equal((await db.query("SELECT status FROM public.nations_awards WHERE torneo_id=91000 AND player_id='p2'")).rows[0].status,'awarded');
await db.exec("UPDATE public.torneo_nations_planes SET plan=jsonb_set(plan,'{revision}','5') WHERE torneo_id=91000");
let stale=false;try{await awards([row('p1','Player One',500)],4);}catch(e){stale=true;}assert.equal(stale,true);
await db.exec("UPDATE public.torneo_nations_planes SET plan=jsonb_set(plan,'{award_policy,confirmed}','false') WHERE torneo_id=91000");
let policy=false;try{await awards([row('p1','Player One',500)],5);}catch(e){policy=true;}assert.equal(policy,true);
await db.exec("UPDATE public.torneo_nations_planes SET plan=jsonb_set(plan,'{award_policy,confirmed}','true') WHERE torneo_id=91000");
const before=(await db.query("SELECT count(*)::int n FROM public.nations_awards WHERE torneo_id=91000")).rows[0].n;
await db.exec('BEGIN');
await awards([row('p3','Player Three',100, 'b'.repeat(64))],5);
let invalid=false;try{await awards([{playerId:'p4',key:'91000:p4',position:'1',base:10,bonus:0,coefficient:1,points:10,sourceDigest:'c'.repeat(64)}],5);}catch(e){invalid=true;}
await db.exec('ROLLBACK');
assert.equal(invalid,true);assert.equal((await db.query("SELECT count(*)::int n FROM public.nations_awards WHERE torneo_id=91000")).rows[0].n,before);
console.log('ok - awards RPC replay/void/reactivation/stale/policy/rollback');
await db.exec(`CREATE SCHEMA IF NOT EXISTS nations_marker_private; CREATE TABLE IF NOT EXISTS nations_marker_private.nations_marker_match(match_id text PRIMARY KEY,revision int,games_epoch int); INSERT INTO public.partidos(id,torneo_id) VALUES(999,91000); INSERT INTO nations_marker_private.nations_marker_match VALUES('999',3,2); ALTER TABLE public.scoreboard_partidos DISABLE TRIGGER USER; INSERT INTO public.scoreboard_partidos(id,torneo_id,partido_torneo_id) VALUES(999,91000,999); ALTER TABLE public.scoreboard_partidos ENABLE TRIGGER USER;`);
const withVersions=(rev)=>({definitive:true,sourceRevision:5,policy:{denominatorMode:'max_player_sets',bonusProration:'none'},sourceVersions:[{scoreboard_id:'999',revision:3,epoch:2}],rows:[row('p1','Player One',500)]});
await db.query(`SELECT public.guardar_nations_awards(91000,$1::jsonb)`,[JSON.stringify(withVersions())]);
let staleVersion=false;try{await db.query(`SELECT public.guardar_nations_awards(91000,$1::jsonb)`,[JSON.stringify({...withVersions(),sourceVersions:[{scoreboard_id:'999',revision:2,epoch:2}]})]);}catch(e){staleVersion=true;}assert.equal(staleVersion,true);console.log('ok - source version CAS rejects stale scoreboard/marker');
await db.close();
