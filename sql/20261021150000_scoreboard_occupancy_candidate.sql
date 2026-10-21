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
        zone text; local_period tsrange; court_no integer;
BEGIN
 -- Use the same lock as resumption and candidate manual bookings. PostgreSQL
 -- aborts one transaction if another legacy route acquires locks in reverse.
 PERFORM pg_advisory_xact_lock(hashtextextended('manual-booking-cross-occupancy-v1',0));
 IF TG_TABLE_NAME='reservas' THEN
  IF lower(coalesce(NEW.estado,'')) IN ('cancelada','cancelado') THEN RETURN NEW; END IF;
  venue:=NEW.sede_id;
  IF venue IS NULL THEN
   SELECT id INTO venue FROM public.sedes WHERE nombre=NEW.sede;
  END IF;
  IF venue IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation venue ambiguous'; END IF;
  SELECT coalesce(nullif(timezone,''),'America/Argentina/Buenos_Aires') INTO zone FROM public.sedes WHERE id=venue;
  court:=NEW.cancha_id;
  IF court IS NULL THEN
   SELECT x.id INTO court FROM public.canchas x WHERE x.sede_id=venue AND coalesce(x.orden,(SELECT count(*)::int FROM public.canchas y WHERE y.sede_id=x.sede_id AND y.id<=x.id))=NEW.cancha;
  END IF;
  IF court IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation court ambiguous'; END IF;
  local_period:=public.scoreboard_local_interval_candidate(NEW.fecha,coalesce(nullif(trim(NEW.hora_inicio),''),nullif(trim(NEW.hora),'')),coalesce(NEW.duracion_minutos,90));
  IF local_period IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation interval invalid'; END IF;
  IF EXISTS(SELECT 1 FROM public.scoreboard_court_occupancy_candidate o JOIN public.scoreboard_partidos s ON s.id=o.scoreboard_id
    WHERE o.sede_id=venue AND o.court_id=court AND s.estado='en_curso'
      AND tsrange(o.starts_at AT TIME ZONE zone,o.ends_at AT TIME ZONE zone,'[)') && local_period) THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court occupied by resumed scoreboard';
  END IF;
 ELSE
  court:=NEW.court_id; own_match:=NEW.partido_id;
  IF NEW.inicio IS NULL OR coalesce(NEW.duration_minutes,0) NOT BETWEEN 1 AND 1440 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Schedule interval invalid'; END IF;
  period:=tstzrange(NEW.inicio,NEW.inicio+NEW.duration_minutes*interval '1 minute','[)');
  IF EXISTS(SELECT 1 FROM public.scoreboard_court_occupancy_candidate o JOIN public.scoreboard_partidos s ON s.id=o.scoreboard_id
     WHERE o.court_id=court AND s.estado='en_curso' AND s.partido_torneo_id IS DISTINCT FROM own_match
       AND tstzrange(o.starts_at,o.ends_at,'[)') && period) THEN
   RAISE EXCEPTION USING ERRCODE='23505',MESSAGE='Court occupied by resumed scoreboard';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.scoreboard_occupancy_guard_candidate() FROM PUBLIC,anon,authenticated,service_role;
CREATE TRIGGER scoreboard_guard_reservation_candidate BEFORE INSERT OR UPDATE ON public.reservas FOR EACH ROW EXECUTE FUNCTION public.scoreboard_occupancy_guard_candidate();
CREATE TRIGGER scoreboard_guard_schedule_candidate BEFORE INSERT OR UPDATE ON public.torneo_partidos_programacion FOR EACH ROW EXECUTE FUNCTION public.scoreboard_occupancy_guard_candidate();
CREATE TRIGGER scoreboard_guard_nations_candidate BEFORE INSERT OR UPDATE ON public.torneo_nations_programacion FOR EACH ROW EXECUTE FUNCTION public.scoreboard_occupancy_guard_candidate();
