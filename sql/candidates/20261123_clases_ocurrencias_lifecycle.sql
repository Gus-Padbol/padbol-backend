-- Local candidate, applies after 20261123_clases_ocurrencias_acceso.sql.
-- Preserve cancelled occurrence history; only one prepared occurrence owns the slot.
ALTER TABLE public.clases_ocurrencias DROP CONSTRAINT clases_ocurrencias_clase_id_fecha_hora_inicio_key;
CREATE UNIQUE INDEX clases_ocurrencias_preparada_slot_key ON public.clases_ocurrencias(clase_id,fecha,hora_inicio) WHERE estado='preparada';

CREATE OR REPLACE FUNCTION public.clases_ocurrencia_footprint_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=public,pg_temp AS $$
BEGIN
 IF ROW(NEW.sede_id,NEW.cancha_id,NEW.duracion_minutos) IS NOT DISTINCT FROM ROW(OLD.sede_id,OLD.cancha_id,OLD.duracion_minutos) THEN RETURN NEW; END IF;
 -- End comes from the persisted booking footprint, not the mutable class template.
 -- Missing/invalid interval or venue timezone cannot establish that occupancy ended.
 IF EXISTS (
  SELECT 1 FROM public.clases_ocurrencias o
  JOIN public.reservas r ON r.id=o.reserva_cancha_id
  LEFT JOIN public.sedes s ON s.id=OLD.sede_id
  CROSS JOIN LATERAL (SELECT CASE WHEN EXISTS(SELECT 1 FROM pg_catalog.pg_timezone_names z WHERE z.name=s.timezone)
    THEN upper(public.reserva_intervalo_guard(r.fecha,r.hora,r.hora_inicio,r.duracion_minutos)) AT TIME ZONE s.timezone
    ELSE NULL END AS fecha_fin) ends
  WHERE o.clase_id=OLD.id AND o.estado='preparada' AND r.estado='confirmada'
    AND (ends.fecha_fin IS NULL OR ends.fecha_fin>=now())
 ) THEN RAISE EXCEPTION 'CLASE_OCURRENCIA_FOOTPRINT_BLOQUEADO' USING ERRCODE='P0001'; END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.clases_ocurrencia_footprint_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.clases_ocurrencia_footprint_guard() TO service_role;
CREATE TRIGGER clases_ocurrencia_footprint_guard BEFORE UPDATE OF sede_id,cancha_id,duracion_minutos ON public.clases FOR EACH ROW EXECUTE FUNCTION public.clases_ocurrencia_footprint_guard();
