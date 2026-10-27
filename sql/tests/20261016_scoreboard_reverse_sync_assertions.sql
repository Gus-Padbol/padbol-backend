BEGIN;
DO $test$
DECLARE sid bigint;stamp timestamptz;
BEGIN
 UPDATE torneos SET modalidad_plantel='dobles',deporte='padbol',estado='en_curso' WHERE id=555;
 INSERT INTO equipos(id,torneo_id,nombre,jugadores,inscripcion_estado) VALUES(91001,555,'QA A','[]','confirmado'),(91002,555,'QA B','[]','confirmado');
 INSERT INTO partidos(id,torneo_id,equipo_a_id,equipo_b_id,estado) VALUES(92001,555,91001,91002,'pendiente');
 INSERT INTO scoreboard_partidos(torneo_id,partido_torneo_id,estado)VALUES(555,92001,'pendiente')RETURNING id INTO sid;
 UPDATE partidos SET estado='finalizado',resultado='{"goles_a":2,"goles_b":1,"historial_sets":[{"a":6,"b":4},{"a":3,"b":6},{"a":6,"b":2}]}',ganador_equipo_id=91001 WHERE id=92001;
 IF NOT EXISTS(SELECT 1 FROM scoreboard_partidos WHERE id=sid AND estado='terminado'AND sets_a=2 AND sets_b=1 AND historial_sets='[{"a":6,"b":4},{"a":3,"b":6},{"a":6,"b":2}]'AND sync_torneo_status='synced') THEN RAISE EXCEPTION 'Manual result left marker stale';END IF;
 SELECT synced_to_torneo_at INTO stamp FROM scoreboard_partidos WHERE id=sid;
 UPDATE partidos SET estado='finalizado' WHERE id=92001;
 IF (SELECT synced_to_torneo_at FROM scoreboard_partidos WHERE id=sid)IS DISTINCT FROM stamp THEN RAISE EXCEPTION 'Retry rewrote terminal marker';END IF;
 BEGIN UPDATE partidos SET resultado='{"goles_a":1,"goles_b":1}'WHERE id=92001;RAISE EXCEPTION 'Unfinished score accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 UPDATE partidos SET resultado='{"goles_a":2,"goles_b":0}'WHERE id=92001;
 IF (SELECT historial_sets FROM scoreboard_partidos WHERE id=sid)IS NOT NULL THEN RAISE EXCEPTION 'Missing games became invented or stale games';END IF;
 IF (SELECT count(*)FROM scoreboard_partidos WHERE torneo_id=555)<>1 THEN RAISE EXCEPTION 'Projection created markers';END IF;
 IF EXISTS(SELECT 1 FROM games) THEN RAISE EXCEPTION 'Projection fabricated games';END IF;
 RAISE NOTICE 'PASS reverse sync: authoritative manual sets/games projected, retry no write, unfinished result rollback, missing games stays NULL, no marker/game creation';
END $test$;
ROLLBACK;
