BEGIN;
DO $test$
DECLARE
 admin uuid:='11111111-1111-4111-8111-111111111111';foreign_admin uuid:='99999999-9999-4999-8999-999999999999';
 cap uuid:='22222222-2222-4222-8222-000000000001';claimant uuid:='22222222-2222-4222-8222-000000000003';
 req uuid:=gen_random_uuid();r jsonb;again jsonb;team bigint;guest uuid;pending uuid;claim uuid;before_roster text;n integer;
BEGIN
 IF has_function_privilege('anon','public.gestionar_participantes_torneo(bigint,uuid,text,jsonb)','EXECUTE') OR has_function_privilege('authenticated','public.gestionar_participantes_torneo(bigint,uuid,text,jsonb)','EXECUTE') OR NOT has_function_privilege('service_role','public.gestionar_participantes_torneo(bigint,uuid,text,jsonb)','EXECUTE') THEN RAISE EXCEPTION 'RPC privileges';END IF;
 BEGIN PERFORM public.gestionar_participantes_torneo(555,foreign_admin,'crear_participante',jsonb_build_object('request_id',req,'nombre','No','tipo_identidad','generico'));RAISE EXCEPTION 'Foreign club accepted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM public.gestionar_participantes_torneo(555,cap,'crear_participante',jsonb_build_object('request_id',req,'nombre','No','tipo_identidad','generico'));RAISE EXCEPTION 'Captain mutated club catalog';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 r:=public.gestionar_participantes_torneo(555,admin,'inscribir',jsonb_build_object('request_id',req,'nombre','Guests','incluir_capitan',false,'participantes',jsonb_build_array(jsonb_build_object('tipo_identidad','generico','nombre','Sin Cuenta Uno'),jsonb_build_object('tipo_identidad','generico','nombre','Sin Cuenta Dos'))));
 team:=(r#>>'{equipo,id}')::bigint;guest:=(r#>>'{equipo,jugadores,0,participante_id}')::uuid;
 IF jsonb_array_length(r#>'{equipo,jugadores}')<>2 OR EXISTS(SELECT 1 FROM jsonb_array_elements(r#>'{equipo,jugadores}') j WHERE j->>'user_id' IS NOT NULL OR (j->>'ranking_oficial_elegible')::boolean) THEN RAISE EXCEPTION 'Admin incorrectly added account or ranking';END IF;
 again:=public.gestionar_participantes_torneo(555,admin,'inscribir',jsonb_build_object('request_id',req,'nombre','Guests','incluir_capitan',false,'participantes',jsonb_build_array(jsonb_build_object('tipo_identidad','generico','nombre','Sin Cuenta Uno'),jsonb_build_object('tipo_identidad','generico','nombre','Sin Cuenta Dos'))));
 IF again#>>'{equipo,id}'<>team::text OR again->>'status'<>'idempotent' THEN RAISE EXCEPTION 'Retry duplicated team';END IF;
 BEGIN PERFORM public.gestionar_participantes_torneo(555,admin,'inscribir',jsonb_build_object('request_id',req,'nombre','Changed','participantes','[]'::jsonb));RAISE EXCEPTION 'Changed retry accepted';EXCEPTION WHEN unique_violation THEN NULL;END;
 BEGIN PERFORM public.gestionar_participantes_torneo(555,admin,'inscribir',jsonb_build_object('request_id',gen_random_uuid(),'nombre','Duplicate','participantes',jsonb_build_array(jsonb_build_object('participante_id',guest))));RAISE EXCEPTION 'Guest duplicated';EXCEPTION WHEN unique_violation THEN NULL;END;
 SELECT jugadores::text INTO before_roster FROM public.equipos WHERE id=team;
 r:=public.gestionar_participantes_torneo(555,claimant,'solicitar_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',guest));claim:=(r#>>'{solicitud,id}')::uuid;
 BEGIN PERFORM public.gestionar_participantes_torneo(555,foreign_admin,'resolver_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'solicitud_id',claim,'decision','aprobar'));RAISE EXCEPTION 'Foreign approval accepted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 r:=public.gestionar_participantes_torneo(555,admin,'resolver_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'solicitud_id',claim,'decision','aprobar'));
 IF (r#>>'{participante,ranking_oficial_elegible}')::boolean OR r#>>'{participante,linked_user_id}'<>claimant::text OR before_roster IS DISTINCT FROM(SELECT jugadores::text FROM public.equipos WHERE id=team) OR EXISTS(SELECT 1 FROM public.tabla_puntos) THEN RAISE EXCEPTION 'Link changed historical ranking/roster';END IF;
 r:=public.gestionar_participantes_torneo(555,cap,'inscribir',jsonb_build_object('request_id',gen_random_uuid(),'nombre','Captain pending','incluir_capitan',false,'participantes',jsonb_build_array(jsonb_build_object('tipo_identidad','plaza_pendiente'))));
 IF jsonb_array_length(r#>'{equipo,jugadores}')<>2 OR r#>>'{equipo,jugadores,0,user_id}'<>cap::text THEN RAISE EXCEPTION 'Captain missing or pending blocked registration';END IF;
 pending:=(r#>>'{equipo,jugadores,1,participante_id}')::uuid;
 BEGIN PERFORM public.gestionar_participantes_torneo(555,cap,'solicitar_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',pending));RAISE EXCEPTION 'Pending placeholder claimable';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 INSERT INTO public.partidos(torneo_id,sede_id,equipo_a_id,equipo_b_id,estado) VALUES(555,8,team,(r#>>'{equipo,id}')::bigint,'pendiente');
 PERFORM public.gestionar_participantes_torneo(555,cap,'editar_participante',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',pending,'nombre','Compañero sin Cuenta','tipo_identidad','generico'));
 IF NOT EXISTS(SELECT 1 FROM public.equipos eq CROSS JOIN LATERAL jsonb_array_elements(eq.jugadores) j WHERE j->>'participante_id'=pending::text AND j->>'estado'='confirmado') THEN RAISE EXCEPTION 'Completion did not update sports snapshot';END IF;
 BEGIN PERFORM public.gestionar_participantes_torneo(555,admin,'inscribir',jsonb_build_object('request_id',gen_random_uuid(),'nombre','After draw','participantes','[]'::jsonb));RAISE EXCEPTION 'Enrollment after fixture';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 INSERT INTO public.scoreboard_partidos(partido_torneo_id) SELECT id FROM public.partidos WHERE torneo_id=555 LIMIT 1;
 BEGIN PERFORM public.gestionar_participantes_torneo(555,cap,'editar_participante',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',pending,'nombre','Changed'));RAISE EXCEPTION 'Roster changed after scoreboard';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 IF (SELECT count(*) FROM auth.users)<>11 THEN RAISE EXCEPTION 'Generic created auth identity';END IF;
END $test$;
ROLLBACK;
SELECT jsonb_build_object('status','PASS','teams_remaining',(SELECT count(*) FROM public.equipos),'participants_remaining',(SELECT count(*) FROM public.torneo_participantes),'claims_remaining',(SELECT count(*) FROM public.torneo_participante_vinculaciones),'points_remaining',(SELECT count(*) FROM public.tabla_puntos)) AS verification;
