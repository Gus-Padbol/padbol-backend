BEGIN;
DO $qa$
DECLARE actor uuid:='11111111-1111-4111-8111-111111111111';arr uuid[];roster jsonb;res jsonb;mid bigint;
BEGIN
 UPDATE torneos SET modalidad_plantel='selecciones' WHERE id=901;
 INSERT INTO torneo_participantes SELECT ('33333333-3333-4333-8333-'||lpad(i::text,12,'0'))::uuid,901,8,'generico' FROM generate_series(1,8)i;
 SELECT array_agg(id ORDER BY id),jsonb_agg(jsonb_build_object('participante_id',id,'user_id',NULL,'nombre','QA sin cuenta '||id,'estado','confirmado','tipo_identidad','generico') ORDER BY id) INTO arr,roster FROM torneo_participantes WHERE torneo_id=901;
 UPDATE equipos SET jugadores=roster,creador_id=actor,inscripcion_estado='confirmado' WHERE id=1;
 INSERT INTO partidos(torneo_id,sede_id,equipo_a_id,equipo_b_id,estado) VALUES(901,8,1,2,'pendiente') RETURNING id INTO mid;
 res:=guardar_alineacion_participantes(901,mid,1,actor,false,arr[1:2],arr[3:4],0);
 IF (res->>'revision')::int<>1 OR jsonb_array_length(res->'iniciales')<>2 OR jsonb_array_length(res->'suplentes')<>2 THEN RAISE EXCEPTION 'Generic declared four invalid';END IF;
 BEGIN PERFORM guardar_alineacion_participantes(901,mid,1,actor,false,arr[1:2],arr[3:4],0);RAISE EXCEPTION 'stale revision accepted';EXCEPTION WHEN serialization_failure THEN NULL;END;
 BEGIN PERFORM guardar_alineacion_participantes(901,mid,1,'99999999-9999-4999-8999-999999999999',true,arr[1:2],arr[3:4],1);RAISE EXCEPTION 'foreign role accepted client admin flag';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 INSERT INTO scoreboard_partidos(id,torneo_id,partido_torneo_id,estado) VALUES('44444444-4444-4444-8444-444444444444',901,mid,'pendiente');
 BEGIN PERFORM guardar_alineacion_participantes(901,mid,1,actor,false,arr[5:6],arr[7:8],1);RAISE EXCEPTION 'frozen lineup accepted';EXCEPTION WHEN object_not_in_prerequisite_state THEN NULL;END;
 RAISE NOTICE 'PASS generic8 roster, declared4, actual persisted participant references, CAS, storedscope, scoreboardfreeze';
END $qa$;
ROLLBACK;
