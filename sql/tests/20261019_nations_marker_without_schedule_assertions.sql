-- Requires the production guard fixture BEFORE the new migration, including selection guards.
BEGIN;
UPDATE torneos SET estado='en_curso',plan_nations='{}',modalidad_plantel='selecciones' WHERE id=901;
INSERT INTO partidos(id,torneo_id,sede_id,equipo_a_id,equipo_b_id,estado) VALUES(71,901,8,1,2,'pendiente'),(72,901,8,3,4,'pendiente');
UPDATE equipos e SET jugadores=(SELECT jsonb_agg(jsonb_build_object('participante_id',('22222222-2222-4222-8222-'||lpad((e.id*10+i)::text,12,'0')),'nombre','QA jugador '||i,'estado','confirmado') ORDER BY i) FROM generate_series(1,8) i);
INSERT INTO torneo_partido_alineaciones(partido_id,equipo_id,iniciales,suplentes) SELECT m.id,e.id,ARRAY(SELECT (j->>'participante_id')::uuid FROM jsonb_array_elements(e.jugadores) WITH ORDINALITY p(j,n) WHERE n<=2 ORDER BY n),ARRAY(SELECT (j->>'participante_id')::uuid FROM jsonb_array_elements(e.jugadores) WITH ORDINALITY p(j,n) WHERE n IN(3,4) ORDER BY n) FROM partidos m JOIN equipos e ON e.id IN(m.equipo_a_id,m.equipo_b_id) WHERE m.id IN(71,72);
-- A linked future marker can remain pending without court or estimated time; it owns no screen.
INSERT INTO scoreboard_partidos(id,torneo_id,sede_id,partido_torneo_id,cancha,estado) VALUES('77777777-7777-4777-8777-777777777771',901,8,71,NULL,'pendiente');
UPDATE canchas SET estado='inactiva' WHERE id=13;
DO $$ BEGIN BEGIN PERFORM preparar_marcador_torneo_ahora(901,71,'11111111-1111-4111-8111-111111111111',13);RAISE EXCEPTION 'Inactive Nations court accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;END $$;
UPDATE canchas SET estado='activa',deporte='padel' WHERE id=13;
DO $$ BEGIN BEGIN PERFORM preparar_marcador_torneo_ahora(901,71,'11111111-1111-4111-8111-111111111111',13);RAISE EXCEPTION 'Wrong Nations sport accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;END $$;
UPDATE canchas SET deporte='padbol' WHERE id=13;
SELECT preparar_marcador_torneo_ahora(901,71,'11111111-1111-4111-8111-111111111111',13);
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM torneo_nations_programacion WHERE partido_id=71) OR EXISTS(SELECT 1 FROM partidos WHERE id=71 AND fecha_hora IS NOT NULL) THEN RAISE EXCEPTION 'Nations needs no estimated schedule';END IF;
 IF NOT EXISTS(SELECT 1 FROM scoreboard_partidos WHERE partido_torneo_id=71 AND cancha='1' AND estado='pendiente' AND jsonb_array_length(equipo_a_jugadores)=4 AND jsonb_array_length(equipo_b_jugadores)=4) THEN RAISE EXCEPTION 'Four-player selection guard/progression binding failed';END IF;
 BEGIN INSERT INTO scoreboard_partidos(id,torneo_id,sede_id,partido_torneo_id,cancha,estado) VALUES('77777777-7777-4777-8777-777777777772',901,9,72,'1','pendiente');RAISE EXCEPTION 'Wrong Nations venue accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 BEGIN INSERT INTO scoreboard_partidos(id,torneo_id,sede_id,partido_torneo_id,cancha,estado) VALUES('77777777-7777-4777-8777-777777777773',901,8,72,'2','pendiente');RAISE EXCEPTION 'Unassigned Nations court accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
END $$;
-- Explicit control action is independent of optional schedule; terminal state frees the screen.
UPDATE scoreboard_partidos SET estado='en_curso' WHERE partido_torneo_id=71;
UPDATE scoreboard_partidos SET estado='terminado' WHERE partido_torneo_id=71;
UPDATE partidos SET estado='finalizado' WHERE id=71;
SELECT preparar_marcador_torneo_ahora(901,72,'11111111-1111-4111-8111-111111111111',13);
INSERT INTO scoreboard_partidos(id,torneo_id,sede_id,partido_torneo_id,cancha,estado) VALUES('77777777-7777-4777-8777-777777777774',901,8,72,'1','pendiente');
ROLLBACK;
