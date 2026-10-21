-- Experimental candidate: no production deployment until reactivation and court occupancy are integrated and tested.
CREATE OR REPLACE FUNCTION public.proteger_cancha_marcador_activo() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE c public.canchas;m public.partidos;
BEGIN
 IF NEW.sede_id IS NULL OR NEW.cancha IS NULL OR lower(coalesce(NEW.estado,'')) IN('terminado','finalizado','cancelado','suspendido') THEN RETURN NEW;END IF;
 -- Preserve historical active controls: only a new claim, reassignment or reactivation acquires a screen.
 IF TG_OP='UPDATE' AND NEW.sede_id IS NOT DISTINCT FROM OLD.sede_id AND NEW.cancha IS NOT DISTINCT FROM OLD.cancha AND lower(coalesce(OLD.estado,'')) NOT IN('terminado','finalizado','cancelado','suspendido') THEN RETURN NEW;END IF;
 SELECT * INTO c FROM canchas x WHERE x.sede_id=NEW.sede_id AND coalesce(x.orden,(SELECT count(*)::int FROM canchas y WHERE y.sede_id=x.sede_id AND y.id<=x.id))::text=NEW.cancha ORDER BY id LIMIT 1 FOR UPDATE;
 IF c.id IS NULL THEN
  -- Manual/legacy markers accept free-text court labels; this migration does not redefine them.
  IF NEW.partido_torneo_id IS NOT NULL AND EXISTS(SELECT 1 FROM partidos WHERE id=NEW.partido_torneo_id AND cancha_id IS NOT NULL) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Valid court required';END IF;
  RETURN NEW;
 END IF;
 IF lower(coalesce(c.estado,'')) IN('inactiva','inactivo','cerrada','mantenimiento') THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Court not eligible';END IF;
 IF NEW.partido_torneo_id IS NOT NULL THEN
  SELECT * INTO m FROM partidos WHERE id=NEW.partido_torneo_id;
  IF EXISTS(SELECT 1 FROM torneos WHERE id=m.torneo_id AND coalesce(deporte,'padbol')<>coalesce(c.deporte,'padbol')) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Court sport mismatch';END IF;
  PERFORM id FROM equipos WHERE id IN(m.equipo_a_id,m.equipo_b_id) ORDER BY id FOR UPDATE;
  IF EXISTS(SELECT 1 FROM scoreboard_partidos s JOIN partidos p ON p.id=s.partido_torneo_id WHERE s.id IS DISTINCT FROM NEW.id AND p.id<>m.id AND (m.equipo_a_id IN(p.equipo_a_id,p.equipo_b_id) OR m.equipo_b_id IN(p.equipo_a_id,p.equipo_b_id)) AND lower(coalesce(s.estado,'')) NOT IN('terminado','finalizado','cancelado')) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Team already using a scoreboard';END IF;
 END IF;
 IF EXISTS(SELECT 1 FROM scoreboard_partidos s WHERE s.sede_id=NEW.sede_id AND s.cancha=NEW.cancha AND s.id IS DISTINCT FROM NEW.id AND lower(coalesce(s.estado,'')) NOT IN('terminado','finalizado','cancelado','suspendido')) THEN RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court screen occupied';END IF;
 RETURN NEW;
END $$;

-- Lock tournament and match first, consistent with their integrity triggers;
-- CAS checks the marker again after acquiring those locks. Scoring/history are untouched.
CREATE OR REPLACE FUNCTION public.scoreboard_suspend_candidate(
 p_id uuid, p_expected timestamptz, p_actor uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE initial public.scoreboard_partidos; current_row public.scoreboard_partidos;
        m public.partidos; r public.user_roles; elapsed integer := 0;
BEGIN
 SELECT * INTO initial FROM public.scoreboard_partidos WHERE id=p_id;
 IF initial.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.user_roles WHERE user_id=p_actor FOR SHARE;
 IF NOT (r.role='super_admin' OR r.role IN('admin_club','admin_sede') AND r.sede_id=initial.sede_id) IS TRUE THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scoreboard control scope denied';
 END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 -- Other linked entities require their own atomic handling; fail closed.
 IF initial.partido_abierto_id IS NOT NULL OR initial.reserva_id IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Linked open matches or reservations require supported suspension';
 END IF;
 IF initial.torneo_id IS NOT NULL THEN
  PERFORM id FROM public.torneos WHERE id=initial.torneo_id FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION USING ERRCODE='23503',MESSAGE='Tournament missing'; END IF;
 END IF;
 IF initial.partido_torneo_id IS NOT NULL THEN
  SELECT * INTO m FROM public.partidos WHERE id=initial.partido_torneo_id FOR UPDATE;
  IF m.id IS NULL OR m.torneo_id IS DISTINCT FROM initial.torneo_id OR m.sede_id IS DISTINCT FROM initial.sede_id
     OR lower(coalesce(m.estado,'')) IN('finalizado','terminado','cancelado','suspendido') THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Linked match cannot be suspended';
  END IF;
 END IF;
 SELECT * INTO current_row FROM public.scoreboard_partidos WHERE id=p_id FOR UPDATE;
 IF current_row.updated_at IS DISTINCT FROM p_expected THEN RETURN NULL; END IF;
 IF current_row.torneo_id IS DISTINCT FROM initial.torneo_id OR current_row.partido_torneo_id IS DISTINCT FROM initial.partido_torneo_id
    OR current_row.sede_id IS DISTINCT FROM initial.sede_id OR current_row.partido_abierto_id IS NOT NULL OR current_row.reserva_id IS NOT NULL THEN RETURN NULL; END IF;
 IF current_row.estado IS DISTINCT FROM 'en_curso' THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Only ongoing matches can be suspended';
 END IF;
 IF current_row.cronometro_inicio IS NOT NULL AND NOT coalesce(current_row.cronometro_pausado,false) THEN
  elapsed := greatest(0,floor(extract(epoch FROM (clock_timestamp()-current_row.cronometro_inicio)))::integer);
 END IF;
 IF current_row.partido_torneo_id IS NOT NULL THEN
  UPDATE public.partidos SET estado='suspendido' WHERE id=current_row.partido_torneo_id;
 END IF;
 UPDATE public.scoreboard_partidos SET estado='suspendido',cronometro_inicio=NULL,
  cronometro_pausado=true,cronometro_segundos=greatest(0,coalesce(cronometro_segundos,0))+elapsed
 WHERE id=p_id RETURNING * INTO current_row;
 RETURN to_jsonb(current_row)-'control_token_hash'-'control_token_created_at'-'control_token_revoked_at';
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_suspend_candidate(uuid,timestamptz,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_suspend_candidate(uuid,timestamptz,uuid) TO service_role;

-- Candidate helper, strict about ambiguous legacy date/time representations.
CREATE OR REPLACE FUNCTION public.scoreboard_local_interval_candidate(p_date text,p_time text,p_minutes integer)
RETURNS tsrange LANGUAGE plpgsql IMMUTABLE SET search_path=pg_catalog AS $$
DECLARE start_at timestamp;
BEGIN
 IF p_date IS NULL OR p_date !~ '^\d{4}-\d{2}-\d{2}$' OR p_time IS NULL OR p_time !~ '^\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?$'
    OR coalesce(p_minutes,0) NOT BETWEEN 1 AND 1440 THEN RETURN NULL; END IF;
 BEGIN start_at:=(p_date||' '||p_time)::timestamp; EXCEPTION WHEN invalid_datetime_format OR datetime_field_overflow THEN RETURN NULL; END;
 RETURN tsrange(start_at,start_at+p_minutes*interval '1 minute','[)');
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_local_interval_candidate(text,text,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_local_interval_candidate(text,text,integer) TO service_role;

CREATE OR REPLACE FUNCTION public.scoreboard_class_overlap_candidate(p_range tsrange,p_day date,p_start time,p_end time)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path=pg_catalog AS $$
 SELECT p_range IS NULL OR p_day IS NULL OR p_start IS NULL OR p_end IS NULL OR
 tsrange(p_day+p_start,(p_day+p_end)+CASE WHEN p_end<=p_start THEN interval '1 day' ELSE interval '0' END,'[)') && p_range
$$;
REVOKE ALL ON FUNCTION public.scoreboard_class_overlap_candidate(tsrange,date,time,time) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_class_overlap_candidate(tsrange,date,time,time) TO service_role;

-- Experimental history: schedule replacements retain their previous snapshot.
CREATE TABLE IF NOT EXISTS public.scoreboard_resumption_history_candidate (
 id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, scoreboard_id uuid NOT NULL,
 actor_id uuid NOT NULL, previous_schedule jsonb NOT NULL,
 new_court_id bigint NOT NULL, resumed_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
ALTER TABLE public.scoreboard_resumption_history_candidate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scoreboard_resumption_history_candidate FROM PUBLIC,anon,authenticated,service_role;

-- Experimental only: this function does not yet cover every writer of court
-- occupancy, and refuses matches with historical fixture schedule rows.
CREATE OR REPLACE FUNCTION public.scoreboard_resume_candidate(
 p_id uuid, p_expected timestamptz, p_actor uuid, p_court_id bigint, p_duration_minutes integer
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE initial public.scoreboard_partidos; current_row public.scoreboard_partidos;
        m public.partidos; r public.user_roles; t public.torneos; c public.canchas;
        zone text; court_number integer; at_now timestamptz; local_range tsrange;
        old_schedule jsonb; has_general boolean:=false; has_nations boolean:=false;
BEGIN
 SELECT * INTO initial FROM public.scoreboard_partidos WHERE id=p_id;
 IF initial.id IS NULL THEN RETURN NULL; END IF;
 SELECT * INTO r FROM public.user_roles WHERE user_id=p_actor FOR SHARE;
 IF NOT (r.role='super_admin' OR r.role IN('admin_club','admin_sede') AND r.sede_id=initial.sede_id) IS TRUE THEN
  RAISE EXCEPTION USING ERRCODE='42501',MESSAGE='Scoreboard control scope denied';
 END IF;
 IF initial.partido_abierto_id IS NOT NULL OR initial.reserva_id IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Linked open matches or reservations require supported resumption';
 END IF;
 -- Shared with the experimental booking candidate; other live writers have not
 -- been migrated to this lock, so this candidate must not be deployed yet.
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 IF initial.torneo_id IS NOT NULL THEN
  SELECT * INTO t FROM public.torneos WHERE id=initial.torneo_id FOR UPDATE;
  IF t.id IS NULL OR t.sede_id IS DISTINCT FROM initial.sede_id THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Tournament unavailable';
  END IF;
 END IF;
 IF initial.partido_torneo_id IS NOT NULL THEN
  SELECT * INTO m FROM public.partidos WHERE id=initial.partido_torneo_id FOR UPDATE;
  IF m.id IS NULL OR m.torneo_id IS DISTINCT FROM initial.torneo_id OR m.sede_id IS DISTINCT FROM initial.sede_id
     OR m.estado IS DISTINCT FROM 'suspendido' THEN
   RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Linked match is not suspended';
  END IF;
  SELECT to_jsonb(s) INTO old_schedule FROM public.torneo_partidos_programacion s WHERE s.partido_id=m.id FOR UPDATE;
  has_general:=FOUND;
  PERFORM 1 FROM public.torneo_nations_programacion WHERE partido_id=m.id FOR UPDATE;
  has_nations:=FOUND;
  IF has_nations OR (has_general AND t.plan_nations IS NOT NULL) THEN
   RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Nations fixture resumption not implemented';
  END IF;
 END IF;
 SELECT * INTO c FROM public.canchas WHERE id=p_court_id AND sede_id=initial.sede_id FOR UPDATE;
 IF c.id IS NULL OR lower(coalesce(c.estado,'')) IN('inactiva','inactivo','cerrada','mantenimiento')
    OR (t.id IS NOT NULL AND coalesce(c.deporte,'padbol')<>coalesce(t.deporte,'padbol')) THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Court not eligible';
 END IF;
 SELECT * INTO current_row FROM public.scoreboard_partidos WHERE id=p_id FOR UPDATE;
 IF current_row.updated_at IS DISTINCT FROM p_expected OR current_row.torneo_id IS DISTINCT FROM initial.torneo_id
    OR current_row.partido_torneo_id IS DISTINCT FROM initial.partido_torneo_id OR current_row.sede_id IS DISTINCT FROM initial.sede_id THEN RETURN NULL; END IF;
 IF current_row.estado IS DISTINCT FROM 'suspendido' THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Scoreboard is not suspended';
 END IF;
 -- Derive the start only after all potentially blocking row locks have completed.
 at_now:=clock_timestamp();
 court_number:=coalesce(c.orden,(SELECT count(*)::int FROM public.canchas WHERE sede_id=c.sede_id AND id<=c.id));
 SELECT coalesce(nullif(timezone,''),'America/Argentina/Buenos_Aires') INTO zone FROM public.sedes WHERE id=c.sede_id;
 IF coalesce(p_duration_minutes,0) NOT BETWEEN 1 AND 1440 THEN
  RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Explicit match duration required';
 END IF;
 -- Local-time schedules are ambiguous across a daylight-saving transition.
 -- Refuse the window until all sources can be compared as absolute instants.
 IF ((at_now+p_duration_minutes*interval '1 minute') AT TIME ZONE zone)
    IS DISTINCT FROM ((at_now AT TIME ZONE zone)+p_duration_minutes*interval '1 minute') THEN
  RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Resumption across timezone transition requires manual scheduling';
 END IF;
 local_range:=tsrange(at_now AT TIME ZONE zone,(at_now AT TIME ZONE zone)+p_duration_minutes*interval '1 minute','[)');
 IF EXISTS(SELECT 1 FROM public.reservas b WHERE (b.sede_id=c.sede_id OR b.sede=(SELECT nombre FROM public.sedes WHERE id=c.sede_id))
   AND (b.cancha_id=c.id OR b.cancha=court_number)
   AND lower(coalesce(b.estado,'')) NOT IN('cancelada','cancelado')
   AND ((public.scoreboard_local_interval_candidate(b.fecha,coalesce(nullif(trim(b.hora_inicio),''),nullif(trim(b.hora),'')),CASE WHEN b.duracion_minutos>=15 THEN b.duracion_minutos ELSE 90 END) IS NULL
       AND (coalesce(b.duracion_minutos,0)>1440 OR public.scoreboard_local_interval_candidate(b.fecha,'00:00',1) IS NULL OR lower(public.scoreboard_local_interval_candidate(b.fecha,'00:00',1))::date BETWEEN lower(local_range)::date-1 AND upper(local_range)::date))
     OR public.scoreboard_local_interval_candidate(b.fecha,coalesce(nullif(trim(b.hora_inicio),''),nullif(trim(b.hora),'')),CASE WHEN b.duracion_minutos>=15 THEN b.duracion_minutos ELSE 90 END) && local_range)) THEN
  RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court has a conflicting reservation';
 END IF;
 IF EXISTS(SELECT 1 FROM public.partidos_abiertos p WHERE p.sede_id=c.sede_id AND lower(coalesce(p.estado,'')) IN('abierto','completo')
   AND (p.cancha_id=c.id OR trim(p.cancha)=court_number::text OR (p.cancha_id IS NULL AND coalesce(trim(p.cancha),'') !~ '^[0-9]+$'))
   AND (public.scoreboard_local_interval_candidate(p.fecha::text,p.hora::text,coalesce(p.duracion_minutos,90)) IS NULL
     OR public.scoreboard_local_interval_candidate(p.fecha::text,p.hora::text,coalesce(p.duracion_minutos,90)) && local_range)) THEN
  RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court has a conflicting open match';
 END IF;
 IF EXISTS(SELECT 1 FROM public.clases a JOIN public.clases_horarios h ON h.clase_id=a.id
   CROSS JOIN LATERAL generate_series((lower(local_range)::date-1)::timestamp,upper(local_range)::date::timestamp,interval '1 day') AS d(day)
   WHERE a.sede_id=c.sede_id AND a.activo=true AND (a.cancha_id=c.id OR a.cancha_id IS NULL)
   AND h.dia_semana=extract(dow FROM d.day)::int
   AND public.scoreboard_class_overlap_candidate(local_range,d.day::date,h.hora_inicio,h.hora_fin)) THEN
  RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court has a conflicting class';
 END IF;
 IF EXISTS(SELECT 1 FROM public.torneo_partidos_programacion s JOIN public.partidos p ON p.id=s.partido_id WHERE s.court_id=c.id AND p.id IS DISTINCT FROM m.id AND coalesce(p.estado,'') NOT IN('cancelado','suspendido','finalizado') AND s.inicio<at_now+p_duration_minutes*interval '1 minute' AND at_now<s.inicio+s.duration_minutes*interval '1 minute')
 OR EXISTS(SELECT 1 FROM public.torneo_nations_programacion s JOIN public.partidos p ON p.id=s.partido_id WHERE s.court_id=c.id AND p.id IS DISTINCT FROM m.id AND coalesce(p.estado,'') NOT IN('cancelado','suspendido','finalizado') AND s.inicio<at_now+p_duration_minutes*interval '1 minute' AND at_now<s.inicio+s.duration_minutes*interval '1 minute') THEN
  RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court reserved by another match';
 END IF;
 IF has_general THEN
  IF t.fecha_inicio IS NULL OR t.fecha_fin IS NULL OR (at_now AT TIME ZONE zone)::date NOT BETWEEN t.fecha_inicio::date AND t.fecha_fin::date THEN
   RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Resumption outside tournament dates';
  END IF;
  IF EXISTS(SELECT 1 FROM public.torneo_partidos_programacion s JOIN public.partidos p ON p.id=s.partido_id
   WHERE s.torneo_id=t.id AND p.id<>m.id AND coalesce(p.estado,'') NOT IN('cancelado','suspendido')
   AND (m.equipo_a_id IN(p.equipo_a_id,p.equipo_b_id) OR m.equipo_b_id IN(p.equipo_a_id,p.equipo_b_id))
   AND s.inicio<at_now+p_duration_minutes*interval '1 minute' AND at_now<s.inicio+s.duration_minutes*interval '1 minute') THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Team conflict';
  END IF;
  IF EXISTS(SELECT 1 FROM public.partidos p JOIN public.torneo_partidos_programacion s ON s.partido_id=p.id
    WHERE p.id=m.partido_siguiente_id AND s.inicio<at_now+p_duration_minutes*interval '1 minute') OR
    EXISTS(SELECT 1 FROM public.partidos p JOIN public.torneo_partidos_programacion s ON s.partido_id=p.id
    WHERE p.partido_siguiente_id=m.id AND at_now<s.inicio+s.duration_minutes*interval '1 minute') THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Bracket schedule order conflict';
  END IF;
 END IF;
 IF has_general THEN
  INSERT INTO public.scoreboard_resumption_history_candidate(scoreboard_id,actor_id,previous_schedule,new_court_id)
  VALUES(p_id,p_actor,old_schedule,c.id);
  UPDATE public.torneo_partidos_programacion SET court_id=c.id,inicio=at_now,duration_minutes=p_duration_minutes,
   actor_id=p_actor,updated_at=clock_timestamp() WHERE partido_id=m.id;
 END IF;
 IF m.id IS NOT NULL THEN
  PERFORM set_config('padbol.nations_rpc','1',true);
  UPDATE public.partidos SET estado='en_curso',cancha_id=c.id,cancha=court_number::text,
   fecha_hora=CASE WHEN has_general THEN at_now AT TIME ZONE 'UTC' ELSE fecha_hora END WHERE id=m.id;
 END IF;
 INSERT INTO public.scoreboard_court_occupancy_candidate(scoreboard_id,sede_id,court_id,starts_at,ends_at)
 VALUES(p_id,c.sede_id,c.id,at_now,at_now+p_duration_minutes*interval '1 minute')
 ON CONFLICT(scoreboard_id) DO UPDATE SET sede_id=EXCLUDED.sede_id,court_id=EXCLUDED.court_id,
 starts_at=EXCLUDED.starts_at,ends_at=EXCLUDED.ends_at;
 PERFORM set_config('padbol.scoreboard_resume_candidate','1',true);
 UPDATE public.scoreboard_partidos SET estado='en_curso',cancha=court_number::text,cronometro_inicio=NULL,cronometro_pausado=true
 WHERE id=p_id RETURNING * INTO current_row;
 -- Triggers may wait on additional rows after the availability check. Never commit
 -- an interval whose start became stale while those locks were being acquired.
 IF clock_timestamp() - at_now > interval '5 seconds' THEN
  RAISE EXCEPTION USING ERRCODE='40001',MESSAGE='Court availability check expired; retry resumption';
 END IF;
 RETURN to_jsonb(current_row)-'control_token_hash'-'control_token_created_at'-'control_token_revoked_at';
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_resume_candidate(uuid,timestamptz,uuid,bigint,integer) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_resume_candidate(uuid,timestamptz,uuid,bigint,integer) TO service_role;
