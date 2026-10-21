import { PGlite } from '@electric-sql/pglite';
import {readFile} from 'node:fs/promises';
const base = process.cwd() + '/';
const db=new PGlite();
const files=['sql/tests/20261016_selection_integrated_bootstrap.sql','sql/20261010150000_padbol_national_rosters_lineups.sql','sql/migrations/20261016100000_tournament_planning.sql','sql/migrations/20261016140000_tournament_generic_participants.sql','sql/migrations/20261016103000_generic_selection_lineups.sql','sql/migrations/20261016160000_generic_selection_compatibility.sql','sql/tests/20261016_nations_registry_bootstrap.sql','sql/20261011150000_nations_cup_event_plan.sql','sql/20261013120000_nations_third_place.sql','sql/migrations/20261016150000_participant_official_accreditation.sql','sql/migrations/20261016170000_nations_registered_participants.sql','sql/migrations/20261016180000_participant_ranking_closure_snapshot.sql','sql/migrations/20261016190000_sync_linked_scoreboard_final_result.sql','sql/20261021130000_tournament_registration_date.sql'];
try {
 await db.exec('CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;');
 for(const file of files){try {await db.exec(await readFile(base+file,'utf8'));console.log('OK',file)} catch(e){console.log('FAILED',file,e.message);throw e}}
 await db.exec(`BEGIN;
 UPDATE torneos SET fecha_fin=current_date+2 WHERE id=555;
 DO $q$ DECLARE act uuid:='11111111-1111-4111-8111-111111111111'; req uuid:=gen_random_uuid(); payload jsonb; first_result jsonb; retry jsonb; listing jsonb;
 BEGIN
 payload:=jsonb_build_object('request_id',req,'nombre','Synthetic Guests','incluir_capitan',false,'participantes',jsonb_build_array(jsonb_build_object('tipo_identidad','generico','nombre','Guest One'),jsonb_build_object('tipo_identidad','generico','nombre','Guest Two')));
 first_result:=public.gestionar_participantes_torneo(555,act,'inscribir',payload);
 UPDATE torneos SET fecha_fin=current_date-2 WHERE id=555;
 retry:=public.gestionar_participantes_torneo(555,act,'inscribir',payload);
 IF retry->>'status'<>'idempotent' THEN RAISE EXCEPTION 'retry failed'; END IF;
 listing:=public.gestionar_participantes_torneo(555,act,'listar','{}');
 IF (listing->>'can_register')::boolean THEN RAISE EXCEPTION 'old tournament shown open'; END IF;
 BEGIN PERFORM public.gestionar_participantes_torneo(555,act,'inscribir',jsonb_set(payload,'{request_id}',to_jsonb(gen_random_uuid()))); RAISE EXCEPTION 'expired enrollment accepted'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 END $q$;
 UPDATE torneos SET modalidad_plantel='selecciones',fecha_fin=current_date-2 WHERE id=556;
 DO $q$ BEGIN
 BEGIN PERFORM public.guardar_plantel_seleccion(556,NULL,'22222222-2222-4222-8222-000000000001',false,'crear','QA synthetic',8,false,ARRAY[]::uuid[],NULL); RAISE EXCEPTION 'expired team creation accepted'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 END $q$;
 DO $q$ DECLARE team_id bigint; actor uuid:='22222222-2222-4222-8222-000000000001'; roster jsonb;
 BEGIN
 SELECT jsonb_agg(jsonb_build_object('id',user_id,'user_id',user_id,'nombre',nombre,'estado','confirmado')) INTO roster FROM jugadores_perfil WHERE user_id::text LIKE '22222222%' AND right(user_id::text,1) IN ('1','2','3','4');
 INSERT INTO equipos(torneo_id,sede_id,nombre,creador_id,jugadores,solicitudes,cupo_maximo,equipo_abierto,tipo_equipo,plantel_revision,inscripcion_estado)
 VALUES(556,9,'QA expired selection',actor,roster,'[]',8,false,'dobles',1,'pendiente') RETURNING id INTO team_id;
 BEGIN PERFORM public.guardar_plantel_seleccion(556,team_id,actor,true,'confirmar','',NULL,false,ARRAY[]::uuid[],1); RAISE EXCEPTION 'expired confirmation accepted'; EXCEPTION WHEN SQLSTATE '55000' THEN NULL; END;
 IF (SELECT inscripcion_estado FROM equipos WHERE id=team_id)<>'pendiente' THEN RAISE EXCEPTION 'expired confirmation changed data'; END IF;
 END $q$;
 ROLLBACK;`);console.log('TEST OK real functions expired and idempotent');
 for(const file of ['sql/tests/20261016_participants_assertions.sql']) { try { await db.exec(await readFile(base+file,'utf8')); console.log('TEST OK',file); } catch(e) { console.log('TEST FAILED',file,e.message); throw e; } }
}finally{await db.close()}

