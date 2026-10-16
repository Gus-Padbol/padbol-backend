BEGIN;
DO $test$
DECLARE admin uuid:='11111111-1111-4111-8111-111111111111';u3 uuid:='22222222-2222-4222-8222-000000000003';u4 uuid:='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';r jsonb;guest uuid;claim3 uuid;claim4 uuid;team bigint;
BEGIN
 INSERT INTO auth.users(id,raw_app_meta_data) VALUES(u4,jsonb_build_object('qa_test',true,'qa_torneo_id',555,'qa_sede_id',8));
 INSERT INTO public.jugadores_perfil(user_id,nombre,apellido,fecha_nacimiento) VALUES(u4,'Mixed Case','QA','1990-01-01');
 r:=public.gestionar_participantes_torneo(555,admin,'inscribir',jsonb_build_object('request_id',gen_random_uuid(),'nombre','Private guests','participantes',jsonb_build_array(jsonb_build_object('tipo_identidad','generico','nombre','Hidden One'),jsonb_build_object('tipo_identidad','generico','nombre','Hidden Two'))));guest:=(r#>>'{equipo,jugadores,0,participante_id}')::uuid;team:=(r#>>'{equipo,id}')::bigint;
 UPDATE public.torneos SET plan_nations=jsonb_build_object('config',jsonb_build_object('reveal_at','2099-01-01T00:00:00Z','timezone','Europe/Rome')) WHERE id=555;
 r:=public.gestionar_participantes_torneo(555,u4,'listar');IF jsonb_array_length(r->'participants')<>0 OR jsonb_array_length(r->'teams')<>0 THEN RAISE EXCEPTION 'Embargo leaked other team identities';END IF;
 INSERT INTO public.torneo_nations_planes(torneo_id,plan) VALUES(555,jsonb_build_object('config',jsonb_build_object('reveal_at','2000-01-01T00:00:00Z','timezone','Europe/Rome')));
 UPDATE public.torneos SET plan_nations=jsonb_build_object('enabled',true,'format','nations_3x5','revision',1) WHERE id=555;
 r:=public.gestionar_participantes_torneo(555,u4,'listar');IF jsonb_array_length(r->'participants')<>2 THEN RAISE EXCEPTION 'Private plan reveal did not expose confirmed guest catalog';END IF;
 DELETE FROM public.torneo_nations_planes WHERE torneo_id=555;
 r:=public.gestionar_participantes_torneo(555,u4,'listar');IF jsonb_array_length(r->'participants')<>0 THEN RAISE EXCEPTION 'Missing private plan did not fail closed';END IF;
 UPDATE public.torneos SET plan_nations=NULL WHERE id=555;
 r:=public.gestionar_participantes_torneo(555,u3,'solicitar_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',guest));claim3:=(r#>>'{solicitud,id}')::uuid;
 r:=public.gestionar_participantes_torneo(555,u4,'solicitar_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',guest));claim4:=(r#>>'{solicitud,id}')::uuid;
 PERFORM public.gestionar_participantes_torneo(555,admin,'resolver_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'solicitud_id',claim3,'decision','aprobar'));
 PERFORM public.gestionar_participantes_torneo(555,admin,'resolver_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'solicitud_id',claim4,'decision','rechazar'));
 IF NOT EXISTS(SELECT 1 FROM public.torneo_participantes WHERE id=guest AND linked_user_id=u3 AND estado_vinculacion='vinculado') THEN RAISE EXCEPTION 'Rejected competing claim downgraded approved identity';END IF;
 BEGIN INSERT INTO public.equipos(torneo_id,sede_id,nombre,creador_id,jugadores) VALUES(555,8,'Legacy duplicate',u3,jsonb_build_array(jsonb_build_object('user_id',u3,'nombre','Legacy')));RAISE EXCEPTION 'Legacy bypassed linked generic account';EXCEPTION WHEN unique_violation THEN NULL;END;
 -- A new guest claim pending before a legacy account registers cannot be approved afterwards.
 guest:=(SELECT id FROM public.torneo_participantes WHERE torneo_id=555 AND linked_user_id IS NULL LIMIT 1);
 r:=public.gestionar_participantes_torneo(555,u4,'solicitar_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',guest));claim4:=(r#>>'{solicitud,id}')::uuid;
 INSERT INTO public.equipos(torneo_id,sede_id,nombre,creador_id,jugadores) VALUES(555,8,'Legitimate legacy registration',u4,jsonb_build_array(jsonb_build_object('user_id',upper(u4::text),'nombre','Legacy First')));
 BEGIN PERFORM public.gestionar_participantes_torneo(555,admin,'resolver_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'solicitud_id',claim4,'decision','aprobar'));RAISE EXCEPTION 'Claim bypassed legacy account registration';EXCEPTION WHEN unique_violation THEN NULL;END;
 INSERT INTO public.torneo_partido_alineaciones(partido_id,equipo_id) VALUES(NULL,team);
 IF public.participante_plantel_congelado(guest) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Declared lineup did not freeze roster';END IF;
 BEGIN PERFORM public.gestionar_participantes_torneo(555,admin,'editar_participante',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',guest,'nombre','Changed'));RAISE EXCEPTION 'Roster changed after declaration';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
END $test$;
ROLLBACK;
SELECT 'PASS peer regressions: embargo, competing claims, legacy duplicate both directions, declared lineup freeze' AS result;
