BEGIN;
DO $test$
DECLARE admin uuid:='11111111-1111-4111-8111-111111111111';cap uuid:='22222222-2222-4222-8222-000000000001';super uuid:='33333333-3333-4333-8333-333333333333';
 r jsonb;participant uuid;request uuid;guest uuid;old_roster text;
BEGIN
 INSERT INTO auth.users(id) VALUES(super);INSERT INTO public.user_roles(user_id,role) VALUES(super,'super_admin');
 UPDATE public.torneos SET nivel_torneo='internacional',fipa_registration_enabled=true,fipa_required_fields='["fecha_nacimiento"]' WHERE id IN(555,557);
 r:=public.gestionar_participantes_torneo(557,cap,'inscribir',jsonb_build_object('request_id',gen_random_uuid(),'nombre','Synthetic official doubles','participantes',jsonb_build_array(jsonb_build_object('tipo_identidad','generico','nombre','Unlinked Guest'))));
 participant:=(r#>>'{equipo,jugadores,0,participante_id}')::uuid;guest:=(r#>>'{equipo,jugadores,1,participante_id}')::uuid;old_roster:=r#>>'{equipo,jugadores}';
 BEGIN UPDATE public.torneo_participantes SET ranking_oficial_elegible=true WHERE id=guest;RAISE EXCEPTION 'Unaudited eligibility accepted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM public.gestionar_acreditacion_participante(557,cap,'solicitar',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',guest));RAISE EXCEPTION 'Unlinked guest could request official ranking';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 r:=public.gestionar_acreditacion_participante(557,cap,'solicitar',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',participant));request:=(r#>>'{solicitud,id}')::uuid;
 BEGIN PERFORM public.gestionar_acreditacion_participante(557,admin,'resolver',jsonb_build_object('request_id',gen_random_uuid(),'acreditacion_id',request,'decision','aprobar'));RAISE EXCEPTION 'Club approved official accreditation';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM public.gestionar_acreditacion_participante(557,super,'resolver',jsonb_build_object('request_id',gen_random_uuid(),'acreditacion_id',request,'decision','aprobar'));RAISE EXCEPTION 'Approval without homologation';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 BEGIN PERFORM public.gestionar_acreditacion_participante(555,super,'homologar',jsonb_build_object('request_id',gen_random_uuid(),'referencia_oficial','LOCAL SYNTHETIC QA DOCUMENT','evidencia','Manual synthetic evidence for local rollback only','confirmar_evento_oficial',true,'confirmar_requisitos',true,'habilitar_inscripcion_fipa',true));RAISE EXCEPTION 'QA event approved';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 UPDATE public.torneos SET fipa_registration_enabled=false WHERE id=557;
 BEGIN PERFORM public.gestionar_acreditacion_participante(557,super,'homologar',jsonb_build_object('request_id',gen_random_uuid(),'referencia_oficial','LOCAL SYNTHETIC QA DOCUMENT','evidencia','Manual synthetic evidence for local rollback only','confirmar_evento_oficial',true,'confirmar_requisitos',true));RAISE EXCEPTION 'Client confirmations bypassed actual event setting';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 r:=public.gestionar_acreditacion_participante(557,super,'homologar',jsonb_build_object('request_id',gen_random_uuid(),'referencia_oficial','LOCAL SYNTHETIC QA DOCUMENT','evidencia','Manual synthetic evidence for local rollback only','confirmar_evento_oficial',true,'confirmar_requisitos',true,'habilitar_inscripcion_fipa',true));
 IF (SELECT fipa_registration_enabled FROM public.torneos WHERE id=557) IS DISTINCT FROM true THEN RAISE EXCEPTION 'Explicit reviewed enablement did not persist';END IF;
 PERFORM public.gestionar_acreditacion_participante(557,super,'homologar',jsonb_build_object('request_id',gen_random_uuid(),'referencia_oficial','LOCAL SYNTHETIC QA DOCUMENT','evidencia','Manual synthetic evidence for local rollback only','confirmar_evento_oficial',true,'confirmar_requisitos',true));
 UPDATE public.jugadores_perfil SET fecha_nacimiento=NULL WHERE user_id=cap;
 BEGIN PERFORM public.gestionar_acreditacion_participante(557,super,'resolver',jsonb_build_object('request_id',gen_random_uuid(),'acreditacion_id',request,'decision','aprobar','referencia_oficial','LOCAL ACCOUNT PROOF 01','evidencia','Synthetic account requirements verified only inside local rollback','confirmar_identidad',true,'confirmar_requisitos',true));RAISE EXCEPTION 'Missing configured requirement accepted';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 UPDATE public.jugadores_perfil SET fecha_nacimiento='1990-01-01' WHERE user_id=cap;
 r:=public.gestionar_acreditacion_participante(557,super,'resolver',jsonb_build_object('request_id',gen_random_uuid(),'acreditacion_id',request,'decision','aprobar','referencia_oficial','LOCAL ACCOUNT PROOF 01','evidencia','Synthetic account requirements verified only inside local rollback','confirmar_identidad',true,'confirmar_requisitos',true));
 IF r#>>'{solicitud,estado}'<>'aprobado' OR (r#>>'{participante,ranking_oficial_elegible}')::boolean IS DISTINCT FROM true THEN RAISE EXCEPTION 'Explicit reviewed account could not become eligible';END IF;
 IF EXISTS(SELECT 1 FROM public.tabla_puntos) OR (SELECT jugadores::text FROM public.equipos WHERE torneo_id=557) IS DISTINCT FROM old_roster THEN RAISE EXCEPTION 'Accreditation awarded retroactive points or mutated roster';END IF;
 r:=public.gestionar_participantes_torneo(557,super,'listar');
 IF (r->>'can_accredit')::boolean IS DISTINCT FROM true OR jsonb_array_length(r->'accreditation_requests')<>1 THEN RAISE EXCEPTION 'Review not visible';END IF;

 UPDATE public.torneos SET estado='finalizado' WHERE id=557;
 IF (SELECT participantes FROM public.torneo_participante_ranking_cierres WHERE torneo_id=557) IS DISTINCT FROM jsonb_build_array(jsonb_build_object('participante_id',participant,'user_id',cap)) THEN RAISE EXCEPTION 'Preclosure approval not frozen';END IF;
 BEGIN UPDATE public.torneo_participante_ranking_cierres SET participantes='[]' WHERE torneo_id=557;RAISE EXCEPTION 'Snapshot mutable';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 BEGIN DELETE FROM public.torneo_participante_ranking_cierres WHERE torneo_id=557;RAISE EXCEPTION 'Official snapshot deletable';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 r:=public.gestionar_participantes_torneo(557,'22222222-2222-4222-8222-000000000003','solicitar_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',guest));
 PERFORM public.gestionar_participantes_torneo(557,admin,'resolver_vinculacion',jsonb_build_object('request_id',gen_random_uuid(),'solicitud_id',r#>>'{solicitud,id}','decision','aprobar'));
 r:=public.gestionar_acreditacion_participante(557,'22222222-2222-4222-8222-000000000003','solicitar',jsonb_build_object('request_id',gen_random_uuid(),'participante_id',guest));
 PERFORM public.gestionar_acreditacion_participante(557,super,'resolver',jsonb_build_object('request_id',gen_random_uuid(),'acreditacion_id',r#>>'{solicitud,id}','decision','aprobar','referencia_oficial','LOCAL LATE ACCOUNT PROOF','evidencia','Synthetic late identity approved only inside local rollback','confirmar_identidad',true,'confirmar_requisitos',true));
 IF (SELECT jsonb_array_length(participantes) FROM public.torneo_participante_ranking_cierres WHERE torneo_id=557)<>1 THEN RAISE EXCEPTION 'Later approval changed closed eligibility';END IF;
 UPDATE public.torneos SET estado='finalizado' WHERE id=557;
 IF (SELECT count(*) FROM public.torneo_participante_ranking_cierres WHERE torneo_id=557)<>1 THEN RAISE EXCEPTION 'Idempotent closure changed snapshot';END IF;

 r:=public.gestionar_participantes_torneo(555,admin,'inscribir',jsonb_build_object('request_id',gen_random_uuid(),'nombre','QA empty closure','participantes',jsonb_build_array(jsonb_build_object('tipo_identidad','generico','nombre','Guest One'),jsonb_build_object('tipo_identidad','generico','nombre','Guest Two'))));
 UPDATE public.torneos SET estado='finalizado' WHERE id=555;
 IF (SELECT participantes FROM public.torneo_participante_ranking_cierres WHERE torneo_id=555) IS DISTINCT FROM '[]'::jsonb THEN RAISE EXCEPTION 'QA acquired eligibility';END IF;
 DELETE FROM public.torneo_participante_ranking_cierres WHERE torneo_id=555;
 IF has_table_privilege('authenticated','public.torneo_participante_ranking_cierres','SELECT') OR has_table_privilege('anon','public.torneo_participante_ranking_cierres','SELECT') OR has_table_privilege('service_role','public.torneo_participante_ranking_cierres','INSERT') OR has_table_privilege('service_role','public.torneo_participante_ranking_cierres','UPDATE') THEN RAISE EXCEPTION 'Snapshot privileges too broad';END IF;
END $test$;
ROLLBACK;
SELECT 'PASS: preclosure approval frozen; postclosure approval not retroactive; snapshot immutable; rollback' AS result;
