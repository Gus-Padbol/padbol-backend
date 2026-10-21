-- Experimental, incomplete: test only. Never deploy until every occupancy writer
-- is integrated and the complete lock order has been tested against real triggers.
CREATE TABLE IF NOT EXISTS public.scoreboard_court_occupancy_candidate (
 scoreboard_id uuid PRIMARY KEY,
 sede_id bigint NOT NULL,
 court_id bigint NOT NULL,
 starts_at timestamptz NOT NULL,
 ends_at timestamptz NOT NULL,
 CHECK (starts_at < ends_at)
);
ALTER TABLE public.scoreboard_court_occupancy_candidate ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.scoreboard_court_occupancy_candidate FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION public.scoreboard_occupancy_guard_candidate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE court bigint; venue bigint; period tstzrange; own_match bigint;
        zone text; local_period tsrange; court_no integer; cls public.clases; n integer;
BEGIN
 -- Changes to payment or other unrelated attributes must not revalidate old data.
 IF TG_OP='UPDATE' THEN
  CASE TG_TABLE_NAME
  WHEN 'reservas' THEN
   IF (NEW.sede_id,NEW.sede,NEW.cancha_id,NEW.cancha,NEW.estado,NEW.fecha,NEW.hora,NEW.hora_inicio,NEW.duracion_minutos) IS NOT DISTINCT FROM (OLD.sede_id,OLD.sede,OLD.cancha_id,OLD.cancha,OLD.estado,OLD.fecha,OLD.hora,OLD.hora_inicio,OLD.duracion_minutos) THEN RETURN NEW; END IF;
  WHEN 'partidos_abiertos' THEN
   IF (NEW.sede_id,NEW.cancha_id,NEW.cancha,NEW.estado,NEW.fecha,NEW.hora,NEW.duracion_minutos) IS NOT DISTINCT FROM (OLD.sede_id,OLD.cancha_id,OLD.cancha,OLD.estado,OLD.fecha,OLD.hora,OLD.duracion_minutos) THEN RETURN NEW; END IF;
  WHEN 'clases' THEN
   IF (NEW.sede_id,NEW.cancha_id,NEW.activo) IS NOT DISTINCT FROM (OLD.sede_id,OLD.cancha_id,OLD.activo) THEN RETURN NEW; END IF;
  WHEN 'clases_horarios' THEN
   IF (NEW.clase_id,NEW.dia_semana,NEW.hora_inicio,NEW.hora_fin) IS NOT DISTINCT FROM (OLD.clase_id,OLD.dia_semana,OLD.hora_inicio,OLD.hora_fin) THEN RETURN NEW; END IF;
  ELSE
   IF (NEW.partido_id,NEW.court_id,NEW.inicio,NEW.duration_minutes) IS NOT DISTINCT FROM (OLD.partido_id,OLD.court_id,OLD.inicio,OLD.duration_minutes) THEN RETURN NEW; END IF;
  END CASE;
 END IF;
 -- Use the same lock as resumption and candidate manual bookings. PostgreSQL
 -- aborts one transaction if another legacy route acquires locks in reverse.
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 IF TG_TABLE_NAME='reservas' THEN
  IF lower(coalesce(NEW.estado,'')) IN ('cancelada','cancelado') THEN RETURN NEW; END IF;
  venue:=NEW.sede_id;
  IF venue IS NULL THEN
   SELECT min(id),count(*) INTO venue,n FROM public.sedes WHERE nombre=NEW.sede;
   IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation venue ambiguous'; END IF;
  END IF;
  IF venue IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation venue ambiguous'; END IF;
  SELECT coalesce(nullif(timezone,''),'America/Argentina/Buenos_Aires') INTO zone FROM public.sedes WHERE id=venue;
  court:=NEW.cancha_id;
  IF court IS NULL THEN
   SELECT min(x.id),count(*) INTO court,n FROM public.canchas x WHERE x.sede_id=venue AND coalesce(x.orden,(SELECT count(*)::int FROM public.canchas y WHERE y.sede_id=x.sede_id AND y.id<=x.id))=NEW.cancha;
   IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation court ambiguous'; END IF;
  END IF;
  IF court IS NULL OR NOT EXISTS(SELECT 1 FROM public.canchas WHERE id=court AND sede_id=venue) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation court ambiguous'; END IF;
  SELECT coalesce(x.orden,(SELECT count(*)::int FROM public.canchas y WHERE y.sede_id=x.sede_id AND y.id<=x.id)) INTO court_no FROM public.canchas x WHERE x.id=court;
  IF NEW.cancha IS NOT NULL AND NEW.cancha IS DISTINCT FROM court_no THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation court identifiers disagree'; END IF;
  local_period:=public.scoreboard_local_interval_candidate(NEW.fecha,coalesce(nullif(trim(NEW.hora_inicio),''),nullif(trim(NEW.hora),'')),CASE WHEN NEW.duracion_minutos>=15 THEN NEW.duracion_minutos ELSE 90 END);
  IF local_period IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation interval invalid'; END IF;
  -- Also protect fixtures created by paths that store only a court ID.
  IF EXISTS(SELECT 1 FROM (SELECT partido_id,court_id,inicio,duration_minutes FROM public.torneo_partidos_programacion UNION ALL SELECT partido_id,court_id,inicio,duration_minutes FROM public.torneo_nations_programacion) f
    LEFT JOIN public.partidos p ON p.id=f.partido_id WHERE f.court_id=court AND coalesce(p.estado,'') NOT IN ('cancelado','suspendido','finalizado')
    AND (f.inicio IS NULL OR coalesce(f.duration_minutes,0) NOT BETWEEN 1 AND 1440
      OR tsrange(f.inicio AT TIME ZONE zone,(f.inicio+f.duration_minutes*interval '1 minute') AT TIME ZONE zone,'[)') && local_period)) THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court occupied by tournament fixture';
  END IF;
  IF EXISTS(SELECT 1 FROM public.scoreboard_court_occupancy_candidate o JOIN public.scoreboard_partidos s ON s.id=o.scoreboard_id
    WHERE o.sede_id=venue AND o.court_id=court AND s.estado='en_curso'
      AND tsrange(o.starts_at AT TIME ZONE zone,(CASE WHEN o.ends_at<=clock_timestamp() THEN 'infinity'::timestamptz ELSE o.ends_at END) AT TIME ZONE zone,'[)') && local_period) THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court occupied by resumed scoreboard';
  END IF;
 ELSIF TG_TABLE_NAME='partidos_abiertos' THEN
  IF lower(coalesce(NEW.estado,'')) NOT IN ('abierto','completo') THEN RETURN NEW; END IF;
  venue:=NEW.sede_id;
  SELECT coalesce(nullif(timezone,''),'America/Argentina/Buenos_Aires') INTO zone FROM public.sedes WHERE id=venue;
  court:=NEW.cancha_id;
  IF court IS NULL AND trim(coalesce(NEW.cancha,'')) ~ '^[0-9]+$' THEN
   court_no:=trim(NEW.cancha)::integer;
   SELECT min(x.id),count(*) INTO court,n FROM public.canchas x WHERE x.sede_id=venue AND coalesce(x.orden,(SELECT count(*)::int FROM public.canchas y WHERE y.sede_id=x.sede_id AND y.id<=x.id))=court_no;
   IF n<>1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Open match court ambiguous'; END IF;
  END IF;
  IF court IS NULL OR zone IS NULL OR NOT EXISTS(SELECT 1 FROM public.canchas WHERE id=court AND sede_id=venue) THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Open match court ambiguous'; END IF;
  SELECT coalesce(x.orden,(SELECT count(*)::int FROM public.canchas y WHERE y.sede_id=x.sede_id AND y.id<=x.id)) INTO court_no FROM public.canchas x WHERE x.id=court;
  IF nullif(trim(NEW.cancha),'') IS NOT NULL AND trim(NEW.cancha) IS DISTINCT FROM court_no::text THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Open match court identifiers disagree'; END IF;
  local_period:=public.scoreboard_local_interval_candidate(NEW.fecha::text,NEW.hora::text,coalesce(NEW.duracion_minutos,90));
  IF local_period IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Open match interval invalid'; END IF;
  IF EXISTS(SELECT 1 FROM public.scoreboard_court_occupancy_candidate o JOIN public.scoreboard_partidos s ON s.id=o.scoreboard_id
   WHERE o.sede_id=venue AND o.court_id=court AND s.estado='en_curso'
    AND tsrange(o.starts_at AT TIME ZONE zone,(CASE WHEN o.ends_at<=clock_timestamp() THEN 'infinity'::timestamptz ELSE o.ends_at END) AT TIME ZONE zone,'[)') && local_period) THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court occupied by resumed scoreboard';
  END IF;
 ELSIF TG_TABLE_NAME IN ('clases','clases_horarios') THEN
  IF TG_TABLE_NAME='clases' THEN cls:=NEW;
  ELSE SELECT * INTO cls FROM public.clases WHERE id=NEW.clase_id; END IF;
  IF cls.id IS NULL OR cls.activo IS DISTINCT FROM true THEN RETURN NEW; END IF;
  SELECT coalesce(nullif(timezone,''),'America/Argentina/Buenos_Aires') INTO zone FROM public.sedes WHERE id=cls.sede_id;
  IF zone IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Class venue ambiguous'; END IF;
  IF TG_TABLE_NAME='clases_horarios' THEN
   IF EXISTS(SELECT 1 FROM public.scoreboard_court_occupancy_candidate o JOIN public.scoreboard_partidos s ON s.id=o.scoreboard_id
    CROSS JOIN LATERAL generate_series(((o.starts_at AT TIME ZONE zone)::date-1)::timestamp,((o.ends_at AT TIME ZONE zone)::date)::timestamp,interval '1 day') d(day)
    WHERE o.sede_id=cls.sede_id AND (cls.cancha_id IS NULL OR o.court_id=cls.cancha_id) AND s.estado='en_curso'
    AND (o.ends_at<=clock_timestamp() OR (NEW.dia_semana=extract(dow FROM d.day)::int
    AND public.scoreboard_class_overlap_candidate(tsrange(o.starts_at AT TIME ZONE zone,o.ends_at AT TIME ZONE zone,'[)'),d.day::date,NEW.hora_inicio,NEW.hora_fin)))) THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court occupied by resumed scoreboard'; END IF;
  ELSE
   IF EXISTS(SELECT 1 FROM public.scoreboard_court_occupancy_candidate o JOIN public.scoreboard_partidos s ON s.id=o.scoreboard_id
    JOIN public.clases_horarios h ON h.clase_id=cls.id
    CROSS JOIN LATERAL generate_series(((o.starts_at AT TIME ZONE zone)::date-1)::timestamp,((o.ends_at AT TIME ZONE zone)::date)::timestamp,interval '1 day') d(day)
    WHERE o.sede_id=cls.sede_id AND (cls.cancha_id IS NULL OR o.court_id=cls.cancha_id) AND s.estado='en_curso'
    AND (o.ends_at<=clock_timestamp() OR (h.dia_semana=extract(dow FROM d.day)::int
    AND public.scoreboard_class_overlap_candidate(tsrange(o.starts_at AT TIME ZONE zone,o.ends_at AT TIME ZONE zone,'[)'),d.day::date,h.hora_inicio,h.hora_fin)))) THEN
    RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court occupied by resumed scoreboard'; END IF;
  END IF;
 ELSE
  court:=NEW.court_id; own_match:=NEW.partido_id;
  IF NEW.inicio IS NULL OR coalesce(NEW.duration_minutes,0) NOT BETWEEN 1 AND 1440 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Schedule interval invalid'; END IF;
  period:=tstzrange(NEW.inicio,NEW.inicio+NEW.duration_minutes*interval '1 minute','[)');
  SELECT c.sede_id,coalesce(c.orden,(SELECT count(*)::int FROM public.canchas x WHERE x.sede_id=c.sede_id AND x.id<=c.id)),coalesce(nullif(v.timezone,''),'America/Argentina/Buenos_Aires')
    INTO venue,court_no,zone FROM public.canchas c JOIN public.sedes v ON v.id=c.sede_id WHERE c.id=court;
  IF venue IS NULL OR zone IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Fixture court ambiguous'; END IF;
  IF ((NEW.inicio+NEW.duration_minutes*interval '1 minute') AT TIME ZONE zone) IS DISTINCT FROM (NEW.inicio AT TIME ZONE zone)+NEW.duration_minutes*interval '1 minute' THEN
   RAISE EXCEPTION USING ERRCODE='0A000',MESSAGE='Fixture crosses timezone transition';
  END IF;
  local_period:=tsrange(NEW.inicio AT TIME ZONE zone,(NEW.inicio+NEW.duration_minutes*interval '1 minute') AT TIME ZONE zone,'[)');
  IF EXISTS(SELECT 1 FROM public.reservas b WHERE (b.sede_id=venue OR b.sede=(SELECT nombre FROM public.sedes WHERE id=venue))
    AND (b.cancha_id=court OR b.cancha=court_no) AND lower(coalesce(b.estado,'')) NOT IN ('cancelada','cancelado')
    AND (public.scoreboard_local_interval_candidate(b.fecha,coalesce(nullif(trim(b.hora_inicio),''),nullif(trim(b.hora),'')),CASE WHEN b.duracion_minutos>=15 THEN b.duracion_minutos ELSE 90 END) IS NULL
      OR public.scoreboard_local_interval_candidate(b.fecha,coalesce(nullif(trim(b.hora_inicio),''),nullif(trim(b.hora),'')),CASE WHEN b.duracion_minutos>=15 THEN b.duracion_minutos ELSE 90 END) && local_period)) THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court occupied by reservation';
  END IF;
  IF EXISTS(SELECT 1 FROM public.scoreboard_court_occupancy_candidate o JOIN public.scoreboard_partidos s ON s.id=o.scoreboard_id
     WHERE o.court_id=court AND s.estado='en_curso' AND s.partido_torneo_id IS DISTINCT FROM own_match
       AND tstzrange(o.starts_at,CASE WHEN o.ends_at<=clock_timestamp() THEN 'infinity'::timestamptz ELSE o.ends_at END,'[)') && period) THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court occupied by resumed scoreboard';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_occupancy_guard_candidate() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER scoreboard_guard_reservation_candidate BEFORE INSERT OR UPDATE ON public.reservas FOR EACH ROW EXECUTE FUNCTION public.scoreboard_occupancy_guard_candidate();
CREATE TRIGGER scoreboard_guard_schedule_candidate BEFORE INSERT OR UPDATE ON public.torneo_partidos_programacion FOR EACH ROW EXECUTE FUNCTION public.scoreboard_occupancy_guard_candidate();
CREATE TRIGGER scoreboard_guard_nations_candidate BEFORE INSERT OR UPDATE ON public.torneo_nations_programacion FOR EACH ROW EXECUTE FUNCTION public.scoreboard_occupancy_guard_candidate();
CREATE TRIGGER scoreboard_guard_open_candidate BEFORE INSERT OR UPDATE ON public.partidos_abiertos FOR EACH ROW EXECUTE FUNCTION public.scoreboard_occupancy_guard_candidate();
CREATE TRIGGER scoreboard_guard_classes_candidate BEFORE INSERT OR UPDATE ON public.clases FOR EACH ROW EXECUTE FUNCTION public.scoreboard_occupancy_guard_candidate();
CREATE TRIGGER scoreboard_guard_class_hours_candidate BEFORE INSERT OR UPDATE ON public.clases_horarios FOR EACH ROW EXECUTE FUNCTION public.scoreboard_occupancy_guard_candidate();

-- A resumed marker's recorded occupancy must not be bypassed by a generic
-- scoreboard edit; reassignment goes through suspension and resumption.
CREATE OR REPLACE FUNCTION public.scoreboard_guard_resumed_edit_candidate()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
BEGIN
 IF (NEW.estado,NEW.sede_id,NEW.cancha,NEW.partido_torneo_id) IS NOT DISTINCT FROM
    (OLD.estado,OLD.sede_id,OLD.cancha,OLD.partido_torneo_id) THEN RETURN NEW; END IF;
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 IF OLD.estado='suspendido' AND NEW.estado='en_curso'
    AND coalesce(current_setting('padbol.scoreboard_resume_candidate',true),'')<>'1' THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Use safe scoreboard resumption';
 END IF;
 IF OLD.estado='en_curso' AND NEW.estado='en_curso'
    AND (NEW.sede_id,NEW.cancha,NEW.partido_torneo_id) IS DISTINCT FROM (OLD.sede_id,OLD.cancha,OLD.partido_torneo_id)
    AND EXISTS(SELECT 1 FROM public.scoreboard_court_occupancy_candidate WHERE scoreboard_id=OLD.id) THEN
  RAISE EXCEPTION USING ERRCODE='55000',MESSAGE='Suspend and resume to change a resumed court';
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_guard_resumed_edit_candidate() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER scoreboard_guard_resumed_edit_candidate BEFORE UPDATE ON public.scoreboard_partidos FOR EACH ROW EXECUTE FUNCTION public.scoreboard_guard_resumed_edit_candidate();
