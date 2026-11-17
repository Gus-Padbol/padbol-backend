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

try { await load('sql/tests/20261117_nations57_tour500_close_assertions.sql'); console.log('PASS: Tour50057 actual38-match closure, GS home/away bonus, invalid points denied, atomic rollback and replay'); } catch (e) { console.error(e.message,e.code,e.where);process.exitCode=1; } finally { await db.close(); }
