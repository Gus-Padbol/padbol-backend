-- Isolated DB only: load 20261016_tournament_planning_bootstrap.sql + migrations first.
BEGIN;
ALTER TABLE scoreboard_partidos ADD COLUMN IF NOT EXISTS sede_id bigint;
UPDATE torneos SET estado='en_curso' WHERE id=901;
INSERT INTO partidos(id,torneo_id,sede_id,equipo_a_id,equipo_b_id,estado) VALUES(5,901,8,1,2,'pendiente'),(6,901,8,3,4,'pendiente');
DO $$ BEGIN
 BEGIN PERFORM preparar_marcador_torneo_ahora(901,5,'99999999-9999-4999-8999-999999999999',13);RAISE EXCEPTION 'Foreign actor accepted';EXCEPTION WHEN insufficient_privilege THEN NULL;END;
 BEGIN PERFORM preparar_marcador_torneo_ahora(901,5,'11111111-1111-4111-8111-111111111111',99);RAISE EXCEPTION 'Invalid court accepted';EXCEPTION WHEN invalid_parameter_value THEN NULL;END;
 PERFORM preparar_marcador_torneo_ahora(901,5,'11111111-1111-4111-8111-111111111111',13);
 IF EXISTS(SELECT 1 FROM partidos WHERE id=5 AND (fecha_hora IS NOT NULL OR cancha<>'1' OR estado<>'pendiente')) OR EXISTS(SELECT 1 FROM torneo_partidos_programacion) THEN RAISE EXCEPTION 'Implicit scheduling/start';END IF;
END $$;
-- An actual booking now blocks opening; an estimated time on this match does not.
INSERT INTO reservas(id,sede_id,sede,cancha,estado,fecha,hora,duracion_minutos) VALUES(9001,8,'QA',2,'confirmada',to_char(now() AT TIME ZONE 'Europe/Rome','YYYY-MM-DD'),to_char((now()-interval '5 minutes') AT TIME ZONE 'Europe/Rome','HH24:MI'),90);
DO $$ BEGIN
 BEGIN PERFORM preparar_marcador_torneo_ahora(901,6,'11111111-1111-4111-8111-111111111111',14);RAISE EXCEPTION 'Occupied booking accepted';EXCEPTION WHEN unique_violation THEN NULL;END;
END $$;
DELETE FROM reservas WHERE id=9001;
INSERT INTO scoreboard_partidos(id,torneo_id,sede_id,partido_torneo_id,cancha,estado) VALUES('11111111-1111-4111-8111-111111111112',901,8,5,'1','pendiente');
-- Manual labels remain legal; official numeric manual courts still share the occupation guard.
INSERT INTO scoreboard_partidos(id,sede_id,cancha,estado) VALUES('22222222-2222-4222-8222-222222222221',8,'Cancha central libre','pendiente');
UPDATE scoreboard_partidos SET estado='en_curso' WHERE id='22222222-2222-4222-8222-222222222221';
DO $$ BEGIN
 BEGIN INSERT INTO scoreboard_partidos(id,sede_id,cancha,estado) VALUES('22222222-2222-4222-8222-222222222222',8,'1','pendiente');RAISE EXCEPTION 'Manual official court collision accepted';EXCEPTION WHEN unique_violation THEN NULL;END;
END $$;
-- Simulate duplicate controls that existed before installation; operating/closing them stays possible.
ALTER TABLE scoreboard_partidos DISABLE TRIGGER proteger_cancha_marcador_activo;
INSERT INTO scoreboard_partidos(id,sede_id,cancha,estado) VALUES('33333333-3333-4333-8333-333333333331',8,'2','pendiente'),('33333333-3333-4333-8333-333333333332',8,'2','pendiente');
ALTER TABLE scoreboard_partidos ENABLE TRIGGER proteger_cancha_marcador_activo;
UPDATE scoreboard_partidos SET estado='en_curso' WHERE id='33333333-3333-4333-8333-333333333331';
UPDATE scoreboard_partidos SET estado='terminado' WHERE id IN('33333333-3333-4333-8333-333333333331','33333333-3333-4333-8333-333333333332');
DO $$ BEGIN
 BEGIN UPDATE scoreboard_partidos SET estado='pendiente',cancha='1' WHERE id='33333333-3333-4333-8333-333333333331';RAISE EXCEPTION 'Reactivation on occupied screen accepted';EXCEPTION WHEN unique_violation THEN NULL;END;
END $$;
DO $$ BEGIN
 BEGIN PERFORM preparar_marcador_torneo_ahora(901,6,'11111111-1111-4111-8111-111111111111',13);RAISE EXCEPTION 'Occupied screen accepted';EXCEPTION WHEN unique_violation THEN NULL;END;
 BEGIN INSERT INTO scoreboard_partidos(id,torneo_id,sede_id,partido_torneo_id,cancha,estado) VALUES('11111111-1111-4111-8111-111111111113',901,8,6,'1','pendiente');RAISE EXCEPTION 'Second insert accepted';EXCEPTION WHEN unique_violation THEN NULL;END;
END $$;
UPDATE scoreboard_partidos SET estado='terminado' WHERE partido_torneo_id=5;
UPDATE partidos SET estado='finalizado' WHERE id=5;
INSERT INTO scoreboard_partidos(id,torneo_id,sede_id,partido_torneo_id,cancha,estado) VALUES('44444444-4444-4444-8444-444444444444',901,8,6,NULL,'pendiente');
SELECT preparar_marcador_torneo_ahora(901,6,'11111111-1111-4111-8111-111111111111',13);
DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM scoreboard_partidos WHERE id='44444444-4444-4444-8444-444444444444' AND cancha='1' AND estado='pendiente') THEN RAISE EXCEPTION 'Progression marker was not bound to court';END IF;END $$;
ROLLBACK;
