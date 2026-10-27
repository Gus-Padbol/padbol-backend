-- Additive guard for every reservation writer, including PostgREST and checkout.
-- Existing rows and policies are unchanged. Cancellation and unrelated updates remain allowed.
BEGIN;
CREATE OR REPLACE FUNCTION public.reserva_intervalo_guard(p_fecha text,p_hora text,p_hora_inicio text,p_duracion integer)
RETURNS tsrange LANGUAGE plpgsql IMMUTABLE SET search_path=public,pg_temp AS $$
DECLARE inicio timestamp; h text; dur integer;
BEGIN
  h:=left(coalesce(nullif(trim(p_hora_inicio),''),nullif(trim(split_part(p_hora,' - ',1)),'')),5);
  IF p_fecha IS NULL OR h IS NULL OR p_fecha !~ '^\d{4}-\d{2}-\d{2}$' OR h !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' THEN RETURN NULL; END IF;
  inicio:=(p_fecha||' '||h)::timestamp;
  dur:=CASE WHEN p_duracion>=15 THEN p_duracion ELSE 90 END;
  RETURN tsrange(inicio,inicio+dur*interval '1 minute','[)');
EXCEPTION WHEN datetime_field_overflow OR invalid_datetime_format THEN RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION public.reservas_guardar_sin_solape()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE nombre_sede text; slot tsrange; court text; venue_id bigint; venue_count integer;
BEGIN
  IF lower(coalesce(NEW.estado,'')) NOT IN('pendiente','confirmada','prereserva') THEN RETURN NEW; END IF;
  IF TG_OP='UPDATE' AND lower(coalesce(OLD.estado,'')) IN('pendiente','confirmada','prereserva')
     AND ROW(NEW.sede_id,NEW.sede,NEW.fecha,NEW.cancha,NEW.hora,NEW.hora_inicio,NEW.duracion_minutos)
         IS NOT DISTINCT FROM ROW(OLD.sede_id,OLD.sede,OLD.fecha,OLD.cancha,OLD.hora,OLD.hora_inicio,OLD.duracion_minutos) THEN RETURN NEW; END IF;
  venue_id:=NEW.sede_id;
  IF venue_id IS NULL THEN
    SELECT count(*),min(s.id) INTO venue_count,venue_id FROM public.sedes s WHERE lower(trim(s.nombre))=lower(trim(NEW.sede));
    IF venue_count<>1 THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Reservation venue is missing or ambiguous'; END IF;
  END IF;
  SELECT lower(trim(s.nombre)) INTO nombre_sede FROM public.sedes s WHERE s.id=venue_id;
  court:=trim(NEW.cancha::text);
  IF court ~ '^[0-9]+$' THEN court:=(court::bigint)::text; END IF;
  slot:=public.reserva_intervalo_guard(NEW.fecha::text,NEW.hora::text,NEW.hora_inicio::text,NEW.duracion_minutos);
  IF nombre_sede IS NULL OR court IS NULL OR court='' OR slot IS NULL THEN
    RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Invalid reservation slot';
  END IF;
  -- Court-wide lock also covers midnight overlap and reservations with legacy venue names.
  PERFORM pg_advisory_xact_lock(hashtextextended('reservas-slot:'||nombre_sede||':'||court,0));
  IF EXISTS(SELECT 1 FROM public.reservas r
    WHERE r.id IS DISTINCT FROM NEW.id AND lower(coalesce(r.estado,'')) IN('pendiente','confirmada','prereserva')
      AND (r.sede_id=venue_id OR r.sede_id IS NULL AND lower(trim(coalesce(r.sede,'')))=nombre_sede)
      AND CASE WHEN trim(r.cancha::text) ~ '^[0-9]+$' THEN (trim(r.cancha::text)::bigint)::text ELSE trim(r.cancha::text) END=court
      AND public.reserva_intervalo_guard(r.fecha::text,r.hora::text,r.hora_inicio::text,r.duracion_minutos) && slot)
  THEN RAISE EXCEPTION USING ERRCODE='23P01',MESSAGE='Reservation slot overlaps an active booking'; END IF;
  RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.reservas_guardar_sin_solape() FROM PUBLIC,anon,authenticated;
REVOKE ALL ON FUNCTION public.reserva_intervalo_guard(text,text,text,integer) FROM PUBLIC,anon,authenticated;
DROP TRIGGER IF EXISTS reservas_sin_solape ON public.reservas;
CREATE TRIGGER reservas_sin_solape BEFORE INSERT OR UPDATE ON public.reservas
FOR EACH ROW EXECUTE FUNCTION public.reservas_guardar_sin_solape();
NOTIFY pgrst,'reload schema';
COMMIT;
