-- CANDIDATE ONLY. No historical backfill. New RPC remains unused until explicit integration.
-- Requires existing partidos/torneos/equipos/user_roles. Service RPC is the only date writer.
BEGIN;
CREATE TABLE public.partido_fecha_juego (
  partido_id bigint PRIMARY KEY,
  torneo_id bigint NOT NULL,
  sede_id bigint NOT NULL,
  fecha_juego date NOT NULL,
  procedencia text NOT NULL DEFAULT 'declaracion_operador' CHECK (procedencia = 'declaracion_operador'),
  revision bigint NOT NULL CHECK (revision > 0),
  vigente boolean NOT NULL DEFAULT true,
  resultado_snapshot jsonb NOT NULL,
  equipo_a_id bigint NOT NULL,
  equipo_b_id bigint NOT NULL,
  ganador_equipo_id bigint,
  participantes_a uuid[],
  participantes_b uuid[],
  participantes_procedencia text NOT NULL CHECK (participantes_procedencia IN ('plantel_al_registrar_resultado','sin_evidencia_historica')),
  registrado_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actualizado_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid NOT NULL,
  CHECK ((participantes_procedencia='sin_evidencia_historica' AND participantes_a IS NULL AND participantes_b IS NULL)
    OR (participantes_procedencia='plantel_al_registrar_resultado' AND participantes_a IS NOT NULL
      AND participantes_b IS NOT NULL AND cardinality(participantes_a)=2 AND cardinality(participantes_b)=2))
);
CREATE INDEX partido_fecha_juego_mes_idx ON public.partido_fecha_juego(sede_id, fecha_juego) WHERE vigente;
CREATE TABLE public.partido_fecha_juego_auditoria (
  partido_id bigint NOT NULL,
  revision bigint NOT NULL,
  evento text NOT NULL CHECK (evento IN ('declaracion', 'correccion', 'invalidacion_partido', 'invalidacion_torneo')),
  fecha_anterior date,
  fecha_juego date NOT NULL,
  registrado_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  actor_id uuid,
  motivo text,
  evidencia_snapshot jsonb NOT NULL,
  PRIMARY KEY (partido_id, revision)
);
ALTER TABLE public.partido_fecha_juego ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.partido_fecha_juego_auditoria ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.partido_fecha_juego, public.partido_fecha_juego_auditoria FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT ON public.partido_fecha_juego, public.partido_fecha_juego_auditoria TO service_role;
COMMENT ON TABLE public.partido_fecha_juego IS 'Fecha declarada por operador autorizado, no verificación física independiente. Registro del servidor, sin backfill ni efecto financiero.';

-- Normalizes only complete best-of-three manual results, not scoreboard events.
-- Internal function: no client can use it to write or claim a sporting date.
CREATE FUNCTION public.normalizar_resultado_manual_fecha(input jsonb) RETURNS jsonb
 LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE r jsonb := input; h jsonb := '[]'::jsonb; item jsonb; raw text;
 i integer := 0; a integer; b integer; wins_a integer := 0; wins_b integer := 0;
BEGIN
 WHILE jsonb_typeof(r)='string' AND i<4 LOOP r := (r #>> '{}')::jsonb; i := i+1; END LOOP;
 IF jsonb_typeof(r) IS DISTINCT FROM 'object' THEN RAISE EXCEPTION 'RESULTADO_MANUAL_INVALIDO' USING ERRCODE='22023'; END IF;
 IF r ? 'historial_sets' THEN
   h := r->'historial_sets';
 ELSIF r ? 'set1' OR r ? 'set2' OR r ? 'set3' THEN
   FOR i IN 1..3 LOOP
     raw := regexp_replace(btrim(r->>('set'||i::text)), '[[:space:]]', '', 'g');
     IF i=3 AND COALESCE(btrim(raw),'')='' THEN EXIT; END IF;
     IF (raw ~ '^[0-9]{1,2}-[0-9]{1,2}$') IS NOT TRUE THEN RAISE EXCEPTION 'RESULTADO_MANUAL_INVALIDO' USING ERRCODE='22023'; END IF;
     h := h || jsonb_build_array(jsonb_build_object('set',i,'a',split_part(raw,'-',1)::integer,'b',split_part(raw,'-',2)::integer));
   END LOOP;
 ELSE
   -- Existing authenticated manual writer permits a complete set tally without game history.
   IF (r->'goles_a' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb)
       AND r->'goles_b' IN ('0'::jsonb,'1'::jsonb,'2'::jsonb)
       AND ((r->>'goles_a'='2' AND r->>'goles_b' IN ('0','1'))
         OR (r->>'goles_b'='2' AND r->>'goles_a' IN ('0','1')))) IS NOT TRUE
   THEN RAISE EXCEPTION 'RESULTADO_MANUAL_INVALIDO' USING ERRCODE='22023'; END IF;
   RETURN jsonb_build_object('goles_a',r->'goles_a','goles_b',r->'goles_b','fuente_resultado','manual_admin');
 END IF;
 IF (r ? 'historial_sets') AND (r ? 'set1' OR r ? 'set2' OR r ? 'set3') THEN
   RAISE EXCEPTION 'RESULTADO_MANUAL_FORMATOS_MEZCLADOS' USING ERRCODE='22023';
 END IF;
 IF jsonb_typeof(h) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'RESULTADO_MANUAL_INVALIDO' USING ERRCODE='22023'; END IF;
 IF jsonb_array_length(h) NOT IN (2,3) THEN RAISE EXCEPTION 'RESULTADO_MANUAL_INVALIDO' USING ERRCODE='22023'; END IF;
 i:=0;
 FOR item IN SELECT value FROM jsonb_array_elements(h) LOOP
   i:=i+1;
   IF jsonb_typeof(item->'a') IS DISTINCT FROM 'number' OR jsonb_typeof(item->'b') IS DISTINCT FROM 'number'
     OR (item->>'a' ~ '^[0-7]$') IS NOT TRUE OR (item->>'b' ~ '^[0-7]$') IS NOT TRUE
     OR item->'set' IS DISTINCT FROM to_jsonb(i) OR wins_a=2 OR wins_b=2
   THEN RAISE EXCEPTION 'RESULTADO_MANUAL_INVALIDO' USING ERRCODE='22023'; END IF;
   a:=(item->>'a')::integer; b:=(item->>'b')::integer;
   IF NOT ((greatest(a,b)=6 AND least(a,b)<=4) OR (greatest(a,b)=7 AND least(a,b) IN (5,6)))
   THEN RAISE EXCEPTION 'RESULTADO_MANUAL_INVALIDO' USING ERRCODE='22023'; END IF;
   IF a>b THEN wins_a:=wins_a+1; ELSE wins_b:=wins_b+1; END IF;
 END LOOP;
 IF greatest(wins_a,wins_b)<>2 THEN RAISE EXCEPTION 'RESULTADO_MANUAL_INVALIDO' USING ERRCODE='22023'; END IF;
 IF r ? 'goles_a' OR r ? 'goles_b' THEN
   IF r->'goles_a' IS DISTINCT FROM to_jsonb(wins_a) OR r->'goles_b' IS DISTINCT FROM to_jsonb(wins_b)
   THEN RAISE EXCEPTION 'RESULTADO_MANUAL_INVALIDO' USING ERRCODE='22023'; END IF;
 END IF;
 -- Strip arbitrary input fields: actor, clock, winner and provenance are not client controlled.
 SELECT jsonb_agg(jsonb_build_object('set',v->'set','a',v->'a','b',v->'b') ORDER BY (v->>'set')::integer)
 INTO h FROM jsonb_array_elements(h) v;
 RETURN jsonb_build_object('goles_a',wins_a,'goles_b',wins_b,'historial_sets',h,'fuente_resultado','manual_admin');
EXCEPTION WHEN invalid_text_representation OR numeric_value_out_of_range THEN
 RAISE EXCEPTION 'RESULTADO_MANUAL_INVALIDO' USING ERRCODE='22023';
END $$;
REVOKE ALL ON FUNCTION public.normalizar_resultado_manual_fecha(jsonb) FROM PUBLIC,anon,authenticated,service_role;

-- Authoritative bound role only. Legacy email rows must be bound by a separate verified flow.
CREATE FUNCTION public.autorizar_operador_fecha_juego(p_actor_id uuid,p_sede_id bigint)
 RETURNS void LANGUAGE plpgsql SET search_path=pg_catalog AS $$
DECLARE r public.user_roles%ROWTYPE; role_count integer:=0;
BEGIN
 -- Only the currently bound account role is accepted. No email allowlist or role supplied by the client.
 FOR r IN SELECT * FROM public.user_roles WHERE user_id = p_actor_id FOR SHARE LOOP
   role_count := role_count + 1;
   IF (r.role = 'super_admin' OR (r.role = 'admin_club' AND r.sede_id = p_sede_id)) IS NOT TRUE THEN
     RAISE EXCEPTION 'FECHA_JUEGO_NO_AUTORIZADA' USING ERRCODE = '42501'; END IF;
 END LOOP;
 IF role_count <> 1 THEN RAISE EXCEPTION 'FECHA_JUEGO_NO_AUTORIZADA' USING ERRCODE = '42501'; END IF;
END $$;
REVOKE ALL ON FUNCTION public.autorizar_operador_fecha_juego(uuid,bigint) FROM PUBLIC,anon,authenticated,service_role;

CREATE FUNCTION public.registrar_fecha_juego_manual(
 p_torneo_id bigint, p_partido_id bigint, p_actor_id uuid, p_fecha_juego date,
 p_expected_revision bigint DEFAULT 0, p_motivo text DEFAULT NULL, p_resultado jsonb DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE p public.partidos%ROWTYPE; t public.torneos%ROWTYPE;
 d public.partido_fecha_juego%ROWTYPE;
 result_json jsonb; depth integer := 0;
 stamp timestamptz := clock_timestamp(); event_name text; new_revision bigint;
 normalized jsonb; requested jsonb; winner_id bigint; result_status text := 'idempotent';
 team public.equipos%ROWTYPE; player jsonb; uid uuid; team_count integer := 0;
 players_a uuid[]; players_b uuid[]; players uuid[];
 participant_source text := 'sin_evidencia_historica'; evidence jsonb;
BEGIN
 IF p_torneo_id IS NULL OR p_partido_id IS NULL OR p_torneo_id <= 0 OR p_partido_id <= 0
   OR p_actor_id IS NULL OR p_fecha_juego IS NULL OR NOT isfinite(p_fecha_juego)
   OR p_fecha_juego > (stamp AT TIME ZONE 'UTC')::date
   OR p_fecha_juego < DATE '0001-01-01' OR p_expected_revision IS NULL OR p_expected_revision < 0
 THEN RAISE EXCEPTION 'FECHA_JUEGO_INVALIDA' USING ERRCODE = '22023'; END IF;
 SELECT * INTO p FROM public.partidos WHERE id = p_partido_id FOR UPDATE;
 IF NOT FOUND OR p.torneo_id IS DISTINCT FROM p_torneo_id THEN
   RAISE EXCEPTION 'PARTIDO_TORNEO_NO_COINCIDE' USING ERRCODE = 'P0002'; END IF;
 SELECT * INTO t FROM public.torneos WHERE id = p_torneo_id FOR SHARE;
 IF NOT FOUND OR t.sede_id IS NULL OR (p.sede_id IS NOT NULL AND p.sede_id <> t.sede_id) THEN
   RAISE EXCEPTION 'PARTIDO_SEDE_NO_COINCIDE' USING ERRCODE = 'P0002'; END IF;
 PERFORM public.autorizar_operador_fecha_juego(p_actor_id,t.sede_id);
 stamp := clock_timestamp();
 IF t.deporte IS DISTINCT FROM 'padbol' OR t.formato_equipo IS DISTINCT FROM 'dobles' THEN
   RAISE EXCEPTION 'FECHA_JUEGO_TORNEO_INVALIDO' USING ERRCODE='22023'; END IF;
 IF p_resultado IS NOT NULL THEN
   requested := public.normalizar_resultado_manual_fecha(p_resultado);
   winner_id := CASE WHEN (requested->>'goles_a')::integer=2 THEN p.equipo_a_id ELSE p.equipo_b_id END;
   IF p.equipo_a_id IS NULL OR p.equipo_b_id IS NULL OR p.equipo_a_id=p.equipo_b_id THEN
     RAISE EXCEPTION 'RESULTADO_EQUIPOS_INVALIDOS' USING ERRCODE='22023'; END IF;
   IF p.estado='finalizado' THEN
     IF public.normalizar_resultado_manual_fecha(p.resultado) IS DISTINCT FROM requested
       OR (p.ganador_equipo_id IS NOT NULL AND p.ganador_equipo_id<>winner_id) THEN
       RAISE EXCEPTION 'RESULTADO_YA_FINALIZADO_DISTINTO' USING ERRCODE='40001'; END IF;
   ELSE
     IF (p.estado IN ('pendiente','en_curso','activo')) IS NOT TRUE THEN
       RAISE EXCEPTION 'RESULTADO_ESTADO_INVALIDO' USING ERRCODE='22023'; END IF;
     -- Lock both roster rows in stable order; freeze UUIDs only, never names or contact details.
     FOR team IN SELECT * FROM public.equipos WHERE id IN (p.equipo_a_id,p.equipo_b_id) ORDER BY id FOR SHARE LOOP
       team_count := team_count+1;
       IF team.torneo_id IS DISTINCT FROM t.id OR (team.sede_id IS NOT NULL AND team.sede_id<>t.sede_id)
         OR team.inscripcion_estado IS DISTINCT FROM 'confirmado'
         OR jsonb_typeof(team.jugadores) IS DISTINCT FROM 'array' THEN
         RAISE EXCEPTION 'RESULTADO_PARTICIPANTES_INVALIDOS' USING ERRCODE='22023'; END IF;
       IF jsonb_array_length(team.jugadores)<>2 THEN
         RAISE EXCEPTION 'RESULTADO_PARTICIPANTES_INVALIDOS' USING ERRCODE='22023'; END IF;
       players := ARRAY[]::uuid[];
       FOR player IN SELECT value FROM jsonb_array_elements(team.jugadores) LOOP
         BEGIN
           uid := CASE WHEN jsonb_typeof(player)='string' THEN (player #>> '{}')::uuid ELSE (player->>'user_id')::uuid END;
         EXCEPTION WHEN invalid_text_representation THEN
           RAISE EXCEPTION 'RESULTADO_PARTICIPANTES_INVALIDOS' USING ERRCODE='22023';
         END;
         IF uid IS NULL OR uid=ANY(players) THEN RAISE EXCEPTION 'RESULTADO_PARTICIPANTES_INVALIDOS' USING ERRCODE='22023'; END IF;
         players := array_append(players,uid);
       END LOOP;
       IF team.id=p.equipo_a_id THEN players_a:=players; ELSE players_b:=players; END IF;
     END LOOP;
     IF team_count<>2 OR players_a && players_b THEN
       RAISE EXCEPTION 'RESULTADO_PARTICIPANTES_INVALIDOS' USING ERRCODE='22023'; END IF;
     participant_source := 'plantel_al_registrar_resultado';
     UPDATE public.partidos SET estado='finalizado',resultado=requested,ganador_equipo_id=winner_id,
       updated_at=stamp AT TIME ZONE 'UTC' WHERE id=p.id RETURNING * INTO p;
     result_status := 'finalized';
   END IF;
 END IF;
 result_json := p.resultado;
 WHILE jsonb_typeof(result_json) = 'string' AND depth < 4 LOOP
   BEGIN result_json := (result_json #>> '{}')::jsonb;
   EXCEPTION WHEN invalid_text_representation THEN RAISE EXCEPTION 'RESULTADO_MANUAL_REQUERIDO' USING ERRCODE = '22023'; END;
   depth := depth + 1;
 END LOOP;
 IF p.estado IS DISTINCT FROM 'finalizado' OR p.equipo_a_id IS NULL OR p.equipo_b_id IS NULL
   OR p.equipo_a_id = p.equipo_b_id OR jsonb_typeof(result_json) IS DISTINCT FROM 'object'
   OR NOT (COALESCE(result_json->>'fuente_resultado', '') = 'manual_admin'
     OR (NOT (result_json ? 'fuente_resultado') AND result_json ? 'set1' AND result_json ? 'set2'))
 THEN RAISE EXCEPTION 'RESULTADO_MANUAL_REQUERIDO' USING ERRCODE = '22023'; END IF;
 normalized := public.normalizar_resultado_manual_fecha(p.resultado);
 winner_id := CASE WHEN (normalized->>'goles_a')::integer=2 THEN p.equipo_a_id ELSE p.equipo_b_id END;
 IF (p.ganador_equipo_id IS NULL AND NOT (result_json ? 'ganador_id'))
   OR (p.ganador_equipo_id IS NOT NULL AND p.ganador_equipo_id <> winner_id)
   OR (result_json ? 'ganador_id' AND result_json->>'ganador_id' IS DISTINCT FROM winner_id::text)
 THEN RAISE EXCEPTION 'RESULTADO_GANADOR_INVALIDO' USING ERRCODE='22023'; END IF;
 SELECT * INTO d FROM public.partido_fecha_juego WHERE partido_id = p_partido_id FOR UPDATE;
 -- Date correction never changes a historical roster. An invalidated sporting snapshot is not
 -- revived from today's team roster by the date-only operation.
 IF result_status <> 'finalized' AND d.torneo_id=t.id AND d.sede_id=t.sede_id
   AND d.resultado_snapshot=p.resultado
   AND d.equipo_a_id=p.equipo_a_id AND d.equipo_b_id=p.equipo_b_id
   AND d.ganador_equipo_id IS NOT DISTINCT FROM p.ganador_equipo_id THEN
   players_a:=d.participantes_a; players_b:=d.participantes_b;
   participant_source:=d.participantes_procedencia;
 END IF;
 IF d.partido_id IS NOT NULL AND d.vigente AND d.fecha_juego = p_fecha_juego
   AND d.torneo_id=t.id AND d.sede_id=t.sede_id
   AND d.resultado_snapshot = p.resultado AND d.equipo_a_id = p.equipo_a_id
   AND d.equipo_b_id = p.equipo_b_id AND d.ganador_equipo_id IS NOT DISTINCT FROM p.ganador_equipo_id
 THEN
   RETURN jsonb_build_object('fecha_juego',d.fecha_juego,'revision',d.revision,'vigente',true,
    'procedencia',d.procedencia,'registrado_at',d.registrado_at,'actualizado_at',d.actualizado_at,
    'resultado',normalized-'fuente_resultado','ganador_equipo_id',winner_id,'partido_id',p.id,'torneo_id',t.id,'status',result_status);
 END IF;
 IF COALESCE(d.revision, 0) <> p_expected_revision THEN
   RAISE EXCEPTION 'FECHA_JUEGO_REVISION_CAMBIO' USING ERRCODE = '40001'; END IF;
 IF d.revision IS NOT NULL AND (length(btrim(COALESCE(p_motivo,''))) < 5 OR length(p_motivo) > 300) THEN
   RAISE EXCEPTION 'FECHA_JUEGO_MOTIVO_REQUERIDO' USING ERRCODE = '22023'; END IF;
 new_revision := COALESCE(d.revision,0) + 1;
 event_name := CASE WHEN d.revision IS NULL THEN 'declaracion' ELSE 'correccion' END;
 INSERT INTO public.partido_fecha_juego(partido_id,torneo_id,sede_id,fecha_juego,revision,vigente,
   resultado_snapshot,equipo_a_id,equipo_b_id,ganador_equipo_id,participantes_a,participantes_b,participantes_procedencia,registrado_at,actualizado_at,actor_id)
 VALUES(p.id,t.id,t.sede_id,p_fecha_juego,new_revision,true,p.resultado,p.equipo_a_id,p.equipo_b_id,
   p.ganador_equipo_id,players_a,players_b,participant_source,stamp,stamp,p_actor_id)
 ON CONFLICT(partido_id) DO UPDATE SET torneo_id=EXCLUDED.torneo_id,sede_id=EXCLUDED.sede_id,
   fecha_juego=EXCLUDED.fecha_juego,revision=EXCLUDED.revision,vigente=true,
   resultado_snapshot=EXCLUDED.resultado_snapshot,equipo_a_id=EXCLUDED.equipo_a_id,equipo_b_id=EXCLUDED.equipo_b_id,
   ganador_equipo_id=EXCLUDED.ganador_equipo_id,participantes_a=EXCLUDED.participantes_a,participantes_b=EXCLUDED.participantes_b,
   participantes_procedencia=EXCLUDED.participantes_procedencia,actualizado_at=EXCLUDED.actualizado_at,actor_id=EXCLUDED.actor_id
 RETURNING to_jsonb(partido_fecha_juego)-'actor_id' INTO evidence;
 INSERT INTO public.partido_fecha_juego_auditoria(partido_id,revision,evento,fecha_anterior,fecha_juego,registrado_at,actor_id,motivo,evidencia_snapshot)
 VALUES(p.id,new_revision,event_name,d.fecha_juego,p_fecha_juego,stamp,p_actor_id,
   CASE WHEN event_name='correccion' THEN btrim(p_motivo) ELSE NULL END,evidence);
 RETURN jsonb_build_object('fecha_juego',p_fecha_juego,'revision',new_revision,'vigente',true,
   'procedencia','declaracion_operador','registrado_at',COALESCE(d.registrado_at,stamp),'actualizado_at',stamp,
   'resultado',normalized-'fuente_resultado','ganador_equipo_id',winner_id,'partido_id',p.id,'torneo_id',t.id,'status',result_status);
END $$;
REVOKE ALL ON FUNCTION public.registrar_fecha_juego_manual(bigint,bigint,uuid,date,bigint,text,jsonb) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.registrar_fecha_juego_manual(bigint,bigint,uuid,date,bigint,text,jsonb) TO service_role;

-- The read contract applies exactly the same current account/scope authorization as the writer.
CREATE FUNCTION public.leer_fecha_juego_manual(p_torneo_id bigint,p_partido_id bigint,p_actor_id uuid)
 RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE p public.partidos%ROWTYPE; t public.torneos%ROWTYPE; d public.partido_fecha_juego%ROWTYPE;
BEGIN
 SELECT * INTO p FROM public.partidos WHERE id=p_partido_id FOR SHARE;
 IF NOT FOUND OR p.torneo_id IS DISTINCT FROM p_torneo_id THEN
   RAISE EXCEPTION 'PARTIDO_TORNEO_NO_COINCIDE' USING ERRCODE='P0002'; END IF;
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id FOR SHARE;
 IF NOT FOUND OR t.sede_id IS NULL OR (p.sede_id IS NOT NULL AND p.sede_id<>t.sede_id) THEN
   RAISE EXCEPTION 'PARTIDO_SEDE_NO_COINCIDE' USING ERRCODE='P0002'; END IF;
 PERFORM public.autorizar_operador_fecha_juego(p_actor_id,t.sede_id);
 SELECT * INTO d FROM public.partido_fecha_juego WHERE partido_id=p_partido_id;
 IF NOT FOUND THEN RETURN NULL; END IF;
 RETURN jsonb_build_object('fecha_juego',d.fecha_juego,'revision',d.revision,'vigente',d.vigente,
   'procedencia',d.procedencia,'registrado_at',d.registrado_at,'actualizado_at',d.actualizado_at);
END $$;
REVOKE ALL ON FUNCTION public.leer_fecha_juego_manual(bigint,bigint,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.leer_fecha_juego_manual(bigint,bigint,uuid) TO service_role;

CREATE FUNCTION public.invalidar_fecha_juego_partido() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE d public.partido_fecha_juego%ROWTYPE; stamp timestamptz := clock_timestamp();
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.estado,NEW.resultado,NEW.torneo_id,NEW.sede_id,NEW.equipo_a_id,NEW.equipo_b_id,NEW.ganador_equipo_id)
   IS NOT DISTINCT FROM ROW(OLD.estado,OLD.resultado,OLD.torneo_id,OLD.sede_id,OLD.equipo_a_id,OLD.equipo_b_id,OLD.ganador_equipo_id)
 THEN RETURN NEW; END IF;
 UPDATE public.partido_fecha_juego SET vigente=false,revision=revision+1,actualizado_at=stamp
 WHERE partido_id=OLD.id AND vigente RETURNING * INTO d;
 IF FOUND THEN
   INSERT INTO public.partido_fecha_juego_auditoria(partido_id,revision,evento,fecha_anterior,fecha_juego,registrado_at,evidencia_snapshot)
   VALUES(d.partido_id,d.revision,'invalidacion_partido',d.fecha_juego,d.fecha_juego,stamp,to_jsonb(d)-'actor_id');
 END IF;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION public.invalidar_fecha_juego_partido() FROM PUBLIC, anon, authenticated, service_role;
CREATE TRIGGER invalidar_fecha_juego_partido AFTER UPDATE OR DELETE ON public.partidos
 FOR EACH ROW EXECUTE FUNCTION public.invalidar_fecha_juego_partido();
CREATE FUNCTION public.invalidar_fecha_juego_torneo() RETURNS trigger
 LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE d public.partido_fecha_juego%ROWTYPE; stamp timestamptz:=clock_timestamp();
BEGIN
 IF TG_OP='UPDATE' AND ROW(NEW.sede_id,NEW.deporte,NEW.formato_equipo)
   IS NOT DISTINCT FROM ROW(OLD.sede_id,OLD.deporte,OLD.formato_equipo) THEN RETURN NEW; END IF;
 FOR d IN UPDATE public.partido_fecha_juego SET vigente=false,revision=revision+1,actualizado_at=stamp
   WHERE torneo_id=OLD.id AND vigente RETURNING * LOOP
   INSERT INTO public.partido_fecha_juego_auditoria(partido_id,revision,evento,fecha_anterior,fecha_juego,registrado_at,evidencia_snapshot)
   VALUES(d.partido_id,d.revision,'invalidacion_torneo',d.fecha_juego,d.fecha_juego,stamp,to_jsonb(d)-'actor_id');
 END LOOP;
 IF TG_OP='DELETE' THEN RETURN OLD; ELSE RETURN NEW; END IF;
END $$;
REVOKE ALL ON FUNCTION public.invalidar_fecha_juego_torneo() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER invalidar_fecha_juego_torneo AFTER UPDATE OR DELETE ON public.torneos
 FOR EACH ROW EXECUTE FUNCTION public.invalidar_fecha_juego_torneo();
COMMENT ON COLUMN public.partido_fecha_juego.participantes_procedencia IS 'Plantel persistido al registrar resultado, no presencia física comprobada. Legado finalizado no reconstruye personas desde equipos actuales.';
NOTIFY pgrst, 'reload schema';
COMMIT;
