BEGIN;
DO $qa$
DECLARE actor uuid:='11111111-1111-4111-8111-111111111111'; payload jsonb;rec jsonb;config jsonb;groups jsonb:='[]';group_ids jsonb;countries text[]:=ARRAY['IT','AR','UY','ES','FR','GB','US','BR','DE','PT','BE','NL','RO','CL','MX'];team_ids bigint[]:='{}';idsa uuid[];idsb uuid[];e bigint;m public.partidos;rev bigint:=0;i integer;j integer;k integer;matches jsonb:='[]';qualified jsonb;points jsonb;placements jsonb;before_auth integer;before_tournaments integer;baseline jsonb; close_id uuid:=gen_random_uuid(); close_payload jsonb; saved jsonb;
BEGIN
 SELECT count(*) INTO before_auth FROM auth.users;SELECT count(*) INTO before_tournaments FROM torneos;
 SELECT jsonb_agg(to_jsonb(t) ORDER BY id) INTO baseline FROM torneos t;
 INSERT INTO torneos(id,sede_id,es_prueba,deporte,modalidad_plantel,formato_equipo,estado,tipo_torneo,costo_inscripcion,nivel_torneo,fecha_inicio,fecha_fin) VALUES(57,8,true,'padbol','selecciones','dobles','abierto','grupos_knockout',0,'internacional','2026-11-20','2026-11-22');
 FOR i IN 1..15 LOOP
  SELECT jsonb_build_object('nombre','QA Nations invitados '||i,'incluir_capitan',false,'request_id',gen_random_uuid(),'participantes',jsonb_agg(jsonb_build_object('tipo_identidad','generico','nombre','QA N'||i||' jugador'||x))) INTO payload FROM generate_series(1,8)x;
  rec:=gestionar_participantes_torneo(57,actor,'inscribir',payload);team_ids:=array_append(team_ids,(rec->'equipo'->>'id')::bigint);
 END LOOP;
 IF current_setting('padbol.test_partial_roster',true)='1' THEN
  UPDATE torneo_participantes p SET nombre='',tipo_identidad='plaza_pendiente' WHERE p.id IN(SELECT (x.j->>'participante_id')::uuid FROM equipos team CROSS JOIN LATERAL jsonb_array_elements(team.jugadores)WITH ORDINALITY x(j,ord) WHERE team.torneo_id=57 AND ord>4);
  UPDATE equipos team SET jugadores=(SELECT jsonb_agg(CASE WHEN ord>4 THEN x.j||jsonb_build_object('nombre','','tipo_identidad','plaza_pendiente','estado','pendiente') ELSE x.j END ORDER BY ord) FROM jsonb_array_elements(team.jugadores)WITH ORDINALITY x(j,ord)) WHERE team.torneo_id=57;
 END IF;
 SELECT jsonb_build_object('format','nations_3x5','timezone','Europe/Rome','rules',jsonb_build_object('placement_policy','group_seed','minimum_rest_minutes',0,'third_place_match',true),'award_policy',jsonb_build_object('confirmed',true,'confirmedTour500',true,'denominatorMode','max_player_sets','bonusProration','none','minimumSets',1),'country_by_team',(SELECT jsonb_object_agg(team_ids[x]::text,countries[x]) FROM generate_series(1,15)x),'points_policy_snapshot',jsonb_build_object('model','percentage_of_base','version',1,'policy_version',repeat('a',64),'config',jsonb_build_object('niveles',jsonb_build_object('internacional',300),'posiciones',(SELECT jsonb_object_agg(x::text,100) FROM generate_series(1,15)x)))) INTO config;
 PERFORM guardar_plan_nations(57,actor,'config',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('config',config));rev:=rev+1;
 PERFORM guardar_plan_nations(57,actor,'aprobar-reglas',rev,gen_random_uuid(),repeat('b',64),'{}');rev:=rev+1;
 FOR i IN 0..2 LOOP
  SELECT jsonb_agg(team_ids[x]) INTO group_ids FROM generate_series(i*5+1,i*5+5)x;
  groups:=groups||jsonb_build_array(jsonb_build_object('label',chr(65+i),'team_ids',group_ids));
  FOR j IN i*5+1..i*5+4 LOOP FOR k IN j+1..i*5+5 LOOP matches:=matches||jsonb_build_array(jsonb_build_object('grupo',chr(65+i),'equipo_a_id',team_ids[j],'equipo_b_id',team_ids[k]));END LOOP;END LOOP;
 END LOOP;
 PERFORM guardar_plan_nations(57,actor,'sorteo',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('groups',groups,'matches',matches));rev:=rev+1;
 FOR m IN SELECT * FROM partidos WHERE torneo_id=57 ORDER BY id LOOP
  IF m.id=(SELECT min(id) FROM partidos WHERE torneo_id=57) THEN UPDATE partidos SET equipo_a_id=m.equipo_b_id,equipo_b_id=m.equipo_a_id WHERE id=m.id; SELECT * INTO m FROM partidos WHERE id=m.id; END IF;
  SELECT array_agg((x.j->>'participante_id')::uuid ORDER BY x.ord) INTO idsa FROM equipos e CROSS JOIN LATERAL jsonb_array_elements(e.jugadores)WITH ORDINALITY x(j,ord) WHERE e.id=m.equipo_a_id;
  SELECT array_agg((x.j->>'participante_id')::uuid ORDER BY x.ord) INTO idsb FROM equipos e CROSS JOIN LATERAL jsonb_array_elements(e.jugadores)WITH ORDINALITY x(j,ord) WHERE e.id=m.equipo_b_id;
  PERFORM guardar_alineacion_participantes(57,m.id,m.equipo_a_id,actor,true,idsa[1:2],idsa[3:4],0);
  PERFORM guardar_alineacion_participantes(57,m.id,m.equipo_b_id,actor,true,idsb[1:2],idsb[3:4],0);
  PERFORM guardar_plan_nations(57,actor,'programacion',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('schedule',jsonb_build_array(jsonb_build_object('partido_id',m.id,'court_id',13,'fecha_hora','2026-11-20T10:00Z'::timestamptz+(rev*2)*interval '1minute','duration_minutes',1))));rev:=rev+1;
  INSERT INTO scoreboard_partidos(torneo_id,partido_torneo_id,cancha,estado) VALUES(57,m.id,'1','pendiente');
  PERFORM finalizar_partido_seleccion(m.id,CASE WHEN m.id=(SELECT min(id) FROM partidos WHERE torneo_id=57) THEN '{"goles_a":0,"goles_b":2,"historial_sets":[{"a":0,"b":6},{"a":0,"b":6}]}'::jsonb ELSE '{"goles_a":2,"goles_b":0,"historial_sets":[{"a":6,"b":0},{"a":6,"b":0}]}'::jsonb END,actor,'scoreboard');
 END LOOP;
 -- Deterministic fixture: earlier team wins every group match; qualifiers are 1,6,11 /2,7,12 /3,8.
 team_ids:=ARRAY[team_ids[1],team_ids[6],team_ids[11],team_ids[2],team_ids[7],team_ids[12],team_ids[3],team_ids[8]];
 SELECT jsonb_agg(jsonb_build_object('equipo_id',team_ids[x],'seed',x)) INTO qualified FROM generate_series(1,8)x;
 matches:='[]';FOR i IN 1..4 LOOP matches:=matches||jsonb_build_array(jsonb_build_object('bracket_round',1,'bracket_position',i,'ronda',2,'equipo_a_id',team_ids[i],'equipo_b_id',team_ids[9-i]));END LOOP;
 FOR i IN 1..2 LOOP matches:=matches||jsonb_build_array(jsonb_build_object('bracket_round',2,'bracket_position',i,'ronda',3));END LOOP;
 FOR i IN 1..2 LOOP matches:=matches||jsonb_build_array(jsonb_build_object('bracket_round',3,'bracket_position',i,'ronda',4));END LOOP;
 PERFORM guardar_plan_nations(57,actor,'avanzar',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('source',nations_source_snapshot(57),'qualified',qualified,'matches',matches,'standings','[]'::jsonb,'thirds','[]'::jsonb,'tie_resolutions','[]'::jsonb));rev:=rev+1;
 FOR m IN SELECT * FROM partidos WHERE torneo_id=57 AND bracket_round IS NOT NULL ORDER BY bracket_round,bracket_position LOOP
  -- Reload after prior results propagated their winners.
  SELECT * INTO m FROM partidos WHERE id=m.id;
  IF m.equipo_a_id IS NULL OR m.equipo_b_id IS NULL THEN RAISE EXCEPTION 'Bracket progression missing';END IF;
  SELECT array_agg((x.j->>'participante_id')::uuid ORDER BY x.ord) INTO idsa FROM equipos e CROSS JOIN LATERAL jsonb_array_elements(e.jugadores)WITH ORDINALITY x(j,ord) WHERE e.id=m.equipo_a_id;
  SELECT array_agg((x.j->>'participante_id')::uuid ORDER BY x.ord) INTO idsb FROM equipos e CROSS JOIN LATERAL jsonb_array_elements(e.jugadores)WITH ORDINALITY x(j,ord) WHERE e.id=m.equipo_b_id;
  PERFORM guardar_alineacion_participantes(57,m.id,m.equipo_a_id,actor,true,idsa[1:2],idsa[3:4],0);
  PERFORM guardar_alineacion_participantes(57,m.id,m.equipo_b_id,actor,true,idsb[1:2],idsb[3:4],0);
  PERFORM guardar_plan_nations(57,actor,'programacion',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('schedule',jsonb_build_array(jsonb_build_object('partido_id',m.id,'court_id',13,'fecha_hora','2026-11-20T10:00Z'::timestamptz+(rev*2)*interval '1minute','duration_minutes',1))));rev:=rev+1;
  INSERT INTO scoreboard_partidos(torneo_id,partido_torneo_id,cancha,estado) VALUES(57,m.id,'1','pendiente');
  PERFORM finalizar_partido_seleccion(m.id,'{"goles_a":2,"goles_b":0,"historial_sets":[{"a":6,"b":0},{"a":6,"b":0}]}',actor,'scoreboard');
  -- The ordinary winner advancement is performed by the application service, not a DB trigger.
  -- Supply that service's persisted update here; its execution is covered separately by JS tests.
  IF m.partido_siguiente_id IS NOT NULL THEN
   UPDATE partidos SET equipo_a_id=CASE WHEN m.partido_siguiente_slot='A' THEN m.equipo_a_id ELSE equipo_a_id END,equipo_b_id=CASE WHEN m.partido_siguiente_slot='B' THEN m.equipo_a_id ELSE equipo_b_id END WHERE id=m.partido_siguiente_id;
  END IF;
  -- Simulate the application service's bronze propagation: loser of SF1/SF2 to third-place slot A/B.
  IF m.bracket_round=2 THEN
   UPDATE partidos SET
    equipo_a_id=CASE WHEN m.bracket_position=1 THEN m.equipo_b_id ELSE equipo_a_id END,
    equipo_b_id=CASE WHEN m.bracket_position=2 THEN m.equipo_b_id ELSE equipo_b_id END
   WHERE torneo_id=57 AND bracket_round=3 AND bracket_position=2;
  END IF;
 END LOOP;
 WITH ranking AS (
 SELECT e.id,row_number()OVER(ORDER BY CASE
 WHEN e.id=(SELECT ganador_equipo_id FROM partidos WHERE torneo_id=57 AND bracket_round=3 AND bracket_position=1) THEN 1
 WHEN e.id IN(SELECT equipo_a_id FROM partidos WHERE torneo_id=57 AND bracket_round=3 AND bracket_position=1 UNION SELECT equipo_b_id FROM partidos WHERE torneo_id=57 AND bracket_round=3 AND bracket_position=1) THEN 2
 WHEN e.id=(SELECT ganador_equipo_id FROM partidos WHERE torneo_id=57 AND bracket_round=3 AND bracket_position=2) THEN 3
 WHEN e.id IN(SELECT equipo_a_id FROM partidos WHERE torneo_id=57 AND bracket_round=3 AND bracket_position=2 UNION SELECT equipo_b_id FROM partidos WHERE torneo_id=57 AND bracket_round=3 AND bracket_position=2) THEN 4
 WHEN e.id IN(SELECT (q->>'equipo_id')::bigint FROM jsonb_array_elements(qualified) q) THEN 5 ELSE 9 END,e.id) pos
 FROM equipos e WHERE e.torneo_id=57)
 SELECT jsonb_agg(jsonb_build_object('torneo_id',57,'equipo_id',id,'posicion',pos,'puntos',
 CASE pos WHEN 1 THEN 500 WHEN 2 THEN 300 WHEN 3 THEN 190 WHEN 4 THEN 170 ELSE CASE WHEN pos<=8 THEN 90 ELSE 20+3*(SELECT count(*) FROM partidos gm WHERE gm.torneo_id=57 AND gm.grupo IS NOT NULL AND gm.bracket_round IS NULL AND gm.ganador_equipo_id=ranking.id) END END)),
 jsonb_agg(jsonb_build_object('equipo_id',id,'posicion',pos)) INTO points,placements FROM ranking;
 UPDATE public.torneo_nations_planes SET plan=jsonb_set(plan,'{award_policy}',jsonb_build_object('confirmed',true,'confirmedTour500',true,'denominatorMode','max_player_sets','bonusProration','none','minimumSets',1),true) WHERE torneo_id=57;
 UPDATE public.torneos SET plan_nations=jsonb_set(coalesce(plan_nations,'{}'::jsonb),'{award_policy}',jsonb_build_object('confirmed',true,'confirmedTour500',true,'denominatorMode','max_player_sets','bonusProration','none','minimumSets',1),true) WHERE id=57;
 close_payload:=jsonb_build_object('source',nations_source_snapshot(57),'puntos',points,'placements',placements,'tie_resolutions','[]'::jsonb,'awards',jsonb_build_object('definitive',true,'sourceRevision',rev,'policy',jsonb_build_object('denominatorMode','max_player_sets','bonusProration','none'),'rows',jsonb_build_array(jsonb_build_object('playerId','fixture-player','playerName','Fixture Player','key','57:fixture-player','position','1','base',500,'bonus',0,'coefficient',1,'points',500,'sourceDigest',repeat('d',64)))));
 BEGIN
  PERFORM guardar_plan_nations(57,actor,'finalizar',rev,gen_random_uuid(),repeat('b',64),jsonb_set(close_payload,'{puntos,0,puntos}','501'));
  RAISE EXCEPTION 'Wrong Tour500 points accepted';
 EXCEPTION WHEN invalid_parameter_value THEN NULL; END;
 IF (SELECT estado FROM torneos WHERE id=57)='finalizado' OR EXISTS(SELECT 1 FROM tabla_puntos WHERE torneo_id=57) THEN RAISE EXCEPTION 'Invalid close changed event'; END IF;
 BEGIN
  PERFORM guardar_plan_nations(57,actor,'finalizar',rev,gen_random_uuid(),repeat('b',64),close_payload #- '{awards,rows,0,playerName}');
  RAISE EXCEPTION 'Invalid award unexpectedly accepted';
 EXCEPTION WHEN not_null_violation THEN NULL; END;
 IF (SELECT estado FROM torneos WHERE id=57)='finalizado' OR EXISTS(SELECT 1 FROM tabla_puntos WHERE torneo_id=57) THEN RAISE EXCEPTION 'Award failure did not roll back closure'; END IF;
 saved:=guardar_plan_nations(57,actor,'finalizar',rev,close_id,repeat('b',64),close_payload);
 rec:=guardar_plan_nations(57,actor,'finalizar',rev,close_id,repeat('b',64),close_payload);
 IF rec->>'status'<>'idempotent' THEN RAISE EXCEPTION 'Close replay not idempotent'; END IF;
 IF (SELECT puntos FROM tabla_puntos WHERE torneo_id=57 AND posicion=1)<>500 OR (SELECT puntos FROM tabla_puntos WHERE torneo_id=57 AND posicion=4)<>170 THEN RAISE EXCEPTION 'Wrong podium points'; END IF;
 IF EXISTS(SELECT 1 FROM tabla_puntos p WHERE p.torneo_id=57 AND p.posicion BETWEEN 5 AND 8 AND p.puntos<>90) THEN RAISE EXCEPTION 'Wrong QF points'; END IF;
 IF EXISTS(SELECT 1 FROM tabla_puntos p WHERE p.torneo_id=57 AND p.posicion>=9 AND p.puntos<>20+3*(SELECT count(*) FROM partidos gm WHERE gm.torneo_id=57 AND gm.grupo IS NOT NULL AND gm.bracket_round IS NULL AND gm.ganador_equipo_id=p.equipo_id)) THEN RAISE EXCEPTION 'GS bonus mismatch'; END IF;
 IF NOT EXISTS(SELECT 1 FROM partidos WHERE torneo_id=57 AND grupo IS NOT NULL AND ganador_equipo_id=equipo_b_id) THEN RAISE EXCEPTION 'No away group win exercised'; END IF;

 IF (SELECT count(*) FROM public.nations_awards WHERE torneo_id=57 AND status='awarded')<>1 THEN RAISE EXCEPTION 'Wrapper did not persist awards'; END IF;
 IF (SELECT count(*) FROM scoreboard_partidos WHERE torneo_id=57)<>38 OR EXISTS(SELECT 1 FROM scoreboard_partidos WHERE torneo_id=57 AND (jsonb_array_length(equipo_a_jugadores)<>4 OR jsonb_array_length(equipo_b_jugadores)<>4)) THEN RAISE EXCEPTION '38 markers must freeze precisely4+4';END IF;
 IF EXISTS(SELECT 1 FROM scoreboard_partidos WHERE torneo_id=57 AND (estado<>'terminado' OR greatest(sets_a,sets_b)<>2 OR sync_torneo_status<>'synced')) THEN RAISE EXCEPTION 'Nations manual result left linked marker stale';END IF;
 IF (SELECT estado FROM torneos WHERE id=57)<>'finalizado' OR (SELECT count(*) FROM torneo_partido_participacion WHERE torneo_id=57)<>38 OR EXISTS(SELECT 1 FROM equipos WHERE torneo_id=57 AND cardinality(participantes_ranking)<>0) THEN RAISE EXCEPTION 'Closure/evidence/guest eligibility invalid';END IF;
 IF (SELECT count(*) FROM auth.users)<>before_auth THEN RAISE EXCEPTION 'Guest generated auth account';END IF;
 IF (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM torneos t WHERE id<>57) IS DISTINCT FROM baseline THEN RAISE EXCEPTION 'Existing event changed';END IF;
 IF public.puede_leer_nations(57,NULL,NULL) THEN RAISE EXCEPTION 'Anonymous private Nations access expanded';END IF;
 RAISE NOTICE 'PASS Nations awards fixture: bronze propagation, 38 markers, close, rollback';
END $qa$;
ROLLBACK;
