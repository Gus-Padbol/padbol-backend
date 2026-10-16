BEGIN;
DO $test$
DECLARE actor uuid:='11111111-1111-4111-8111-111111111111';i integer;ids bigint[];r jsonb;bad jsonb;good jsonb;
BEGIN
 BEGIN PERFORM public.guardar_fixture_qa(555,actor,NULL,'[{"torneo_id":555,"sede_id":8,"estado":"pendiente"}]'::jsonb);RAISE EXCEPTION 'empty snapshot accepted';EXCEPTION WHEN serialization_failure THEN NULL;END;
 FOR i IN 0..3 LOOP
  PERFORM public.gestionar_dupla_qa(555,actor,'crear','QA Pair '||i,ARRAY[('22222222-2222-4222-8222-'||lpad((i*2+1)::text,12,'0'))::uuid,('22222222-2222-4222-8222-'||lpad((i*2+2)::text,12,'0'))::uuid],('44444444-4444-4444-8444-'||lpad(i::text,12,'0'))::uuid);
 END LOOP;
 SELECT array_agg(id ORDER BY id) INTO ids FROM public.equipos WHERE torneo_id=555;
 good:=jsonb_build_array(jsonb_build_object('torneo_id',555,'sede_id',8,'equipo_a_id',ids[1],'equipo_b_id',ids[2],'estado','pendiente','ronda',1,'bracket_round',1,'bracket_position',1),jsonb_build_object('torneo_id',555,'sede_id',8,'equipo_a_id',ids[3],'equipo_b_id',ids[4],'estado','pendiente','ronda',1,'bracket_round',1,'bracket_position',2),jsonb_build_object('torneo_id',555,'sede_id',8,'estado','pendiente','ronda',2,'bracket_round',2,'bracket_position',1));
 BEGIN PERFORM public.guardar_fixture_qa(555,actor,ids[1:2],good);RAISE EXCEPTION 'stale snapshot accepted';EXCEPTION WHEN serialization_failure THEN NULL;END;
 bad:=jsonb_set(good,'{2,bracket_position}','9');
 BEGIN PERFORM public.guardar_fixture_qa(555,actor,ids,bad);RAISE EXCEPTION 'bad links accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 IF EXISTS(SELECT 1 FROM public.partidos WHERE torneo_id=555) OR (SELECT estado FROM public.torneos WHERE id=555)<>'abierto' THEN RAISE EXCEPTION 'partial fixture survived failure';END IF;
 r:=public.guardar_fixture_qa(555,actor,ids,good);
 IF (r->>'total')::integer<>3 OR (SELECT count(*) FROM public.partidos WHERE torneo_id=555 AND partido_siguiente_id IS NOT NULL)<>2 OR (SELECT estado FROM public.torneos WHERE id=555)<>'en_curso' THEN RAISE EXCEPTION 'atomic fixture failed';END IF;
 BEGIN PERFORM public.guardar_fixture_qa(555,actor,ids,good);RAISE EXCEPTION 'draw repeat allowed';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
 BEGIN PERFORM public.gestionar_dupla_qa(555,actor,'crear','QA Late',ARRAY['22222222-2222-4222-8222-000000000001'::uuid,'22222222-2222-4222-8222-000000000002'::uuid],'44444444-4444-4444-8444-111111111111');RAISE EXCEPTION 'entry after draw allowed';EXCEPTION WHEN SQLSTATE '55000' THEN NULL;END;
END $test$;
ROLLBACK;
SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM public.equipos) AND NOT EXISTS(SELECT 1 FROM public.partidos) AND (SELECT estado FROM public.torneos WHERE id=555)='abierto' THEN '7 fixture checks PASS; error rollback and links atomic' ELSE 'FAILED' END AS result;
