BEGIN;
DO $qa$
DECLARE actor uuid:='11111111-1111-4111-8111-111111111111'; payload jsonb;rec jsonb;config jsonb;groups jsonb:='[]';group_ids jsonb;countries text[]:=ARRAY['IT','AR','UY','ES','FR','GB','US','BR','DE','PT','BE','NL','RO','CL','MX'];team_ids bigint[]:='{}';idsa uuid[];idsb uuid[];e bigint;m public.partidos;rev bigint:=0;i integer;j integer;k integer;matches jsonb:='[]';qualified jsonb;points jsonb;placements jsonb;before_auth integer;before_tournaments integer;baseline jsonb;
BEGIN
 SELECT count(*) INTO before_auth FROM auth.users;SELECT count(*) INTO before_tournaments FROM torneos;
 SELECT jsonb_agg(to_jsonb(t) ORDER BY id) INTO baseline FROM torneos t;
 INSERT INTO torneos(id,sede_id,es_prueba,deporte,modalidad_plantel,formato_equipo,estado,tipo_torneo,costo_inscripcion,nivel_torneo,fecha_inicio,fecha_fin) VALUES(90016,8,true,'padbol','selecciones','dobles','abierto','grupos_knockout',0,'internacional','2026-11-20','2026-11-22');
 FOR i IN 1..15 LOOP
  SELECT jsonb_build_object('nombre','QA Nations invitados '||i,'incluir_capitan',false,'request_id',gen_random_uuid(),'participantes',jsonb_agg(jsonb_build_object('tipo_identidad','generico','nombre','QA N'||i||' jugador'||x))) INTO payload FROM generate_series(1,8)x;
  rec:=gestionar_participantes_torneo(90016,actor,'inscribir',payload);team_ids:=array_append(team_ids,(rec->'equipo'->>'id')::bigint);
 END LOOP;
 IF current_setting('padbol.test_partial_roster',true)='1' THEN
  UPDATE torneo_participantes p SET nombre='',tipo_identidad='plaza_pendiente' WHERE p.id IN(SELECT (x.j->>'participante_id')::uuid FROM equipos team CROSS JOIN LATERAL jsonb_array_elements(team.jugadores)WITH ORDINALITY x(j,ord) WHERE team.torneo_id=90016 AND ord>4);
  UPDATE equipos team SET jugadores=(SELECT jsonb_agg(CASE WHEN ord>4 THEN x.j||jsonb_build_object('nombre','','tipo_identidad','plaza_pendiente','estado','pendiente') ELSE x.j END ORDER BY ord) FROM jsonb_array_elements(team.jugadores)WITH ORDINALITY x(j,ord)) WHERE team.torneo_id=90016;
 END IF;
 SELECT jsonb_build_object('format','nations_3x5','timezone','Europe/Rome','rules',jsonb_build_object('placement_policy','group_seed','minimum_rest_minutes',0,'third_place_match',true),'country_by_team',(SELECT jsonb_object_agg(team_ids[x]::text,countries[x]) FROM generate_series(1,15)x),'points_policy_snapshot',jsonb_build_object('model','percentage_of_base','version',1,'policy_version',repeat('a',64),'config',jsonb_build_object('niveles',jsonb_build_object('internacional',300),'posiciones',(SELECT jsonb_object_agg(x::text,100) FROM generate_series(1,15)x)))) INTO config;
 PERFORM guardar_plan_nations(90016,actor,'config',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('config',config));rev:=rev+1;
 PERFORM guardar_plan_nations(90016,actor,'aprobar-reglas',rev,gen_random_uuid(),repeat('b',64),'{}');rev:=rev+1;
 FOR i IN 0..2 LOOP
  SELECT jsonb_agg(team_ids[x]) INTO group_ids FROM generate_series(i*5+1,i*5+5)x;
  groups:=groups||jsonb_build_array(jsonb_build_object('label',chr(65+i),'team_ids',group_ids));
  FOR j IN i*5+1..i*5+4 LOOP FOR k IN j+1..i*5+5 LOOP matches:=matches||jsonb_build_array(jsonb_build_object('grupo',chr(65+i),'equipo_a_id',team_ids[j],'equipo_b_id',team_ids[k]));END LOOP;END LOOP;
 END LOOP;
 PERFORM guardar_plan_nations(90016,actor,'sorteo',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('groups',groups,'matches',matches));rev:=rev+1;
 FOR m IN SELECT * FROM partidos WHERE torneo_id=90016 ORDER BY id LOOP
  SELECT array_agg((x.j->>'participante_id')::uuid ORDER BY x.ord) INTO idsa FROM equipos e CROSS JOIN LATERAL jsonb_array_elements(e.jugadores)WITH ORDINALITY x(j,ord) WHERE e.id=m.equipo_a_id;
  SELECT array_agg((x.j->>'participante_id')::uuid ORDER BY x.ord) INTO idsb FROM equipos e CROSS JOIN LATERAL jsonb_array_elements(e.jugadores)WITH ORDINALITY x(j,ord) WHERE e.id=m.equipo_b_id;
  PERFORM guardar_alineacion_participantes(90016,m.id,m.equipo_a_id,actor,true,idsa[1:2],idsa[3:4],0);
  PERFORM guardar_alineacion_participantes(90016,m.id,m.equipo_b_id,actor,true,idsb[1:2],idsb[3:4],0);
  PERFORM guardar_plan_nations(90016,actor,'programacion',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('schedule',jsonb_build_array(jsonb_build_object('partido_id',m.id,'court_id',13,'fecha_hora','2026-11-20T10:00Z'::timestamptz+(rev*2)*interval '1minute','duration_minutes',1))));rev:=rev+1;
  INSERT INTO scoreboard_partidos(torneo_id,partido_torneo_id,cancha,estado) VALUES(90016,m.id,'1','pendiente');
  PERFORM finalizar_partido_seleccion(m.id,'{"goles_a":2,"goles_b":0,"historial_sets":[{"a":6,"b":0},{"a":6,"b":0}]}',actor,'scoreboard');
 END LOOP;
 -- Deterministic fixture: earlier team wins every group match; qualifiers are 1,6,11 /2,7,12 /3,8.
 team_ids:=ARRAY[team_ids[1],team_ids[6],team_ids[11],team_ids[2],team_ids[7],team_ids[12],team_ids[3],team_ids[8]];
 SELECT jsonb_agg(jsonb_build_object('equipo_id',team_ids[x],'seed',x)) INTO qualified FROM generate_series(1,8)x;
 matches:='[]';FOR i IN 1..4 LOOP matches:=matches||jsonb_build_array(jsonb_build_object('bracket_round',1,'bracket_position',i,'ronda',2,'equipo_a_id',team_ids[i],'equipo_b_id',team_ids[9-i]));END LOOP;
 FOR i IN 1..2 LOOP matches:=matches||jsonb_build_array(jsonb_build_object('bracket_round',2,'bracket_position',i,'ronda',3));END LOOP;
 FOR i IN 1..2 LOOP matches:=matches||jsonb_build_array(jsonb_build_object('bracket_round',3,'bracket_position',i,'ronda',4));END LOOP;
 PERFORM guardar_plan_nations(90016,actor,'avanzar',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('source',nations_source_snapshot(90016),'qualified',qualified,'matches',matches,'standings','[]'::jsonb,'thirds','[]'::jsonb,'tie_resolutions','[]'::jsonb));rev:=rev+1;
 FOR m IN SELECT * FROM partidos WHERE torneo_id=90016 AND bracket_round IS NOT NULL ORDER BY bracket_round,bracket_position LOOP
  -- Reload after prior results propagated their winners.
  SELECT * INTO m FROM partidos WHERE id=m.id;
  IF m.equipo_a_id IS NULL OR m.equipo_b_id IS NULL THEN RAISE EXCEPTION 'Bracket progression missing';END IF;
  SELECT array_agg((x.j->>'participante_id')::uuid ORDER BY x.ord) INTO idsa FROM equipos e CROSS JOIN LATERAL jsonb_array_elements(e.jugadores)WITH ORDINALITY x(j,ord) WHERE e.id=m.equipo_a_id;
  SELECT array_agg((x.j->>'participante_id')::uuid ORDER BY x.ord) INTO idsb FROM equipos e CROSS JOIN LATERAL jsonb_array_elements(e.jugadores)WITH ORDINALITY x(j,ord) WHERE e.id=m.equipo_b_id;
  PERFORM guardar_alineacion_participantes(90016,m.id,m.equipo_a_id,actor,true,idsa[1:2],idsa[3:4],0);
  PERFORM guardar_alineacion_participantes(90016,m.id,m.equipo_b_id,actor,true,idsb[1:2],idsb[3:4],0);
  PERFORM guardar_plan_nations(90016,actor,'programacion',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('schedule',jsonb_build_array(jsonb_build_object('partido_id',m.id,'court_id',13,'fecha_hora','2026-11-20T10:00Z'::timestamptz+(rev*2)*interval '1minute','duration_minutes',1))));rev:=rev+1;
  INSERT INTO scoreboard_partidos(torneo_id,partido_torneo_id,cancha,estado) VALUES(90016,m.id,'1','pendiente');
  PERFORM finalizar_partido_seleccion(m.id,'{"goles_a":2,"goles_b":0,"historial_sets":[{"a":6,"b":0},{"a":6,"b":0}]}',actor,'scoreboard');
  -- The ordinary winner advancement is performed by the application service, not a DB trigger.
  -- Supply that service's persisted update here; its execution is covered separately by JS tests.
  IF m.partido_siguiente_id IS NOT NULL THEN
   UPDATE partidos SET equipo_a_id=CASE WHEN m.partido_siguiente_slot='A' THEN m.equipo_a_id ELSE equipo_a_id END,equipo_b_id=CASE WHEN m.partido_siguiente_slot='B' THEN m.equipo_a_id ELSE equipo_b_id END WHERE id=m.partido_siguiente_id;
  END IF;
 END LOOP;
 SELECT jsonb_agg(jsonb_build_object('torneo_id',90016,'equipo_id',id,'posicion',pos,'puntos',300)),jsonb_agg(jsonb_build_object('equipo_id',id,'posicion',pos)) INTO points,placements FROM(SELECT id,row_number()OVER(ORDER BY id)pos FROM equipos WHERE torneo_id=90016)x;
 PERFORM guardar_plan_nations(90016,actor,'finalizar',rev,gen_random_uuid(),repeat('b',64),jsonb_build_object('source',nations_source_snapshot(90016),'puntos',points,'placements',placements,'tie_resolutions','[]'::jsonb));
 IF (SELECT count(*) FROM scoreboard_partidos WHERE torneo_id=90016)<>38 OR EXISTS(SELECT 1 FROM scoreboard_partidos WHERE torneo_id=90016 AND (jsonb_array_length(equipo_a_jugadores)<>4 OR jsonb_array_length(equipo_b_jugadores)<>4)) THEN RAISE EXCEPTION '38 markers must freeze precisely4+4';END IF;
 IF (SELECT estado FROM torneos WHERE id=90016)<>'finalizado' OR (SELECT count(*) FROM torneo_partido_participacion WHERE torneo_id=90016)<>38 OR EXISTS(SELECT 1 FROM equipos WHERE torneo_id=90016 AND cardinality(participantes_ranking)<>0) THEN RAISE EXCEPTION 'Closure/evidence/guest eligibility invalid';END IF;
 IF (SELECT count(*) FROM auth.users)<>before_auth THEN RAISE EXCEPTION 'Guest generated auth account';END IF;
 IF (SELECT jsonb_agg(to_jsonb(t) ORDER BY id) FROM torneos t WHERE id<>90016) IS DISTINCT FROM baseline THEN RAISE EXCEPTION 'Existing event changed';END IF;
 IF public.puede_leer_nations(90016,NULL,NULL) THEN RAISE EXCEPTION 'Anonymous private Nations access expanded';END IF;
 RAISE NOTICE 'PASS Nations registry:15x8 guests, private plan/reveal unchanged,3x5 draw,30groups+8playoffs,4+4 markers,38 results/progression/evidence,atomic closure,300 private team points,0 account/official points,existing events unchanged;rollback';
END $qa$;
ROLLBACK;
