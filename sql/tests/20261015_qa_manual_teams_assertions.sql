BEGIN;
DO $test$
DECLARE actor uuid:='11111111-1111-4111-8111-111111111111';a uuid:='22222222-2222-4222-8222-000000000001';b uuid:='22222222-2222-4222-8222-000000000002';c uuid:='22222222-2222-4222-8222-000000000003';r jsonb;
BEGIN
 r:=public.gestionar_dupla_qa(555,actor,'listar');IF jsonb_array_length(r->'players')<>8 OR (r->>'can_write')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'catalog failed';END IF;
 IF EXISTS(SELECT 1 FROM public.equipos) THEN RAISE EXCEPTION 'catalog enrolled players';END IF;
 BEGIN PERFORM public.gestionar_dupla_qa(555,'99999999-9999-4999-8999-999999999999','listar');RAISE EXCEPTION 'foreign role allowed';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM public.gestionar_dupla_qa(555,'88888888-8888-4888-8888-888888888888','listar');RAISE EXCEPTION 'null scope allowed';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM public.gestionar_dupla_qa(557,actor,'listar');RAISE EXCEPTION 'real event allowed';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 BEGIN PERFORM public.gestionar_dupla_qa(555,actor,'crear','QA',ARRAY[a,a],'44444444-4444-4444-8444-444444444444');RAISE EXCEPTION 'duplicate ids allowed';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 UPDATE public.jugadores_perfil SET fecha_nacimiento=current_date-interval '15 years' WHERE user_id=c;
 r:=public.gestionar_dupla_qa(555,actor,'listar');IF jsonb_array_length(r->'players')<>7 THEN RAISE EXCEPTION 'minor not filtered';END IF;
 BEGIN PERFORM public.gestionar_dupla_qa(555,actor,'crear','QA minor',ARRAY[a,c],'44444444-4444-4444-8444-444444444445');RAISE EXCEPTION 'minor enrolled';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 UPDATE auth.users SET raw_app_meta_data='{}' WHERE id=c;
 r:=public.gestionar_dupla_qa(555,actor,'crear','QA Pair',ARRAY[a,b],'44444444-4444-4444-8444-444444444446');IF r->>'status'<>'created' OR (r->'equipo'->>'torneo_id')::bigint<>555 THEN RAISE EXCEPTION 'create receipt failed';END IF;
 r:=public.gestionar_dupla_qa(555,actor,'crear','QA Pair',ARRAY[a,b],'44444444-4444-4444-8444-444444444446');IF r->>'status'<>'idempotent' OR (SELECT count(*) FROM public.equipos)<>1 THEN RAISE EXCEPTION 'retry duplicate';END IF;
 BEGIN PERFORM public.gestionar_dupla_qa(555,actor,'crear','QA Other',ARRAY[a,b],'44444444-4444-4444-8444-444444444447');RAISE EXCEPTION 'player double registration';EXCEPTION WHEN unique_violation THEN NULL;END;
 INSERT INTO public.partidos(id,torneo_id) VALUES(1,555);
 r:=public.gestionar_dupla_qa(555,actor,'listar');IF (r->>'can_write')::boolean IS DISTINCT FROM false THEN RAISE EXCEPTION 'draw did not close writes';END IF;
 BEGIN PERFORM public.gestionar_dupla_qa(555,actor,'crear','QA Late',ARRAY['22222222-2222-4222-8222-000000000004'::uuid,'22222222-2222-4222-8222-000000000005'::uuid],'44444444-4444-4444-8444-444444444448');RAISE EXCEPTION 'postfixture registration allowed';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
END $test$;
ROLLBACK;
SELECT CASE WHEN (SELECT count(*) FROM public.equipos)=0 AND (SELECT count(*) FROM public.torneo_qa_inscripcion_requests)=0 THEN '12 checks PASS; all test writes rolled back' ELSE 'FAILED' END AS result;
