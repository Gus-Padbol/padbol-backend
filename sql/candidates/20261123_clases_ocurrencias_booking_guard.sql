-- LOCAL candidate after acceso + lifecycle. No ordinary reservation policy changed.
CREATE OR REPLACE FUNCTION public.clases_ocurrencia_reserva_guard()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
 -- Integrity check must see the link even when caller cannot read its RLS table.
 -- Trigger-only function: fixed relation lookup, no caller-controlled SQL or bypass flag.
 IF NOT EXISTS(SELECT 1 FROM public.clases_ocurrencias WHERE reserva_cancha_id=OLD.id) THEN
  IF TG_OP='DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
 END IF;
 IF TG_OP='DELETE' THEN RAISE EXCEPTION 'CLASE_OCUPACION_GESTION_CLASES' USING ERRCODE='P0001'; END IF;
 IF ROW(NEW.sede_id,NEW.sede,NEW.fecha,NEW.hora,NEW.hora_inicio,NEW.hora_fin,NEW.cancha_id,NEW.cancha,NEW.duracion_minutos,NEW.user_id,NEW.email,NEW.nombre,NEW.telefono,NEW.whatsapp,NEW.tipo,NEW.precio,NEW.moneda)
   IS DISTINCT FROM ROW(OLD.sede_id,OLD.sede,OLD.fecha,OLD.hora,OLD.hora_inicio,OLD.hora_fin,OLD.cancha_id,OLD.cancha,OLD.duracion_minutos,OLD.user_id,OLD.email,OLD.nombre,OLD.telefono,OLD.whatsapp,OLD.tipo,OLD.precio,OLD.moneda) THEN
  RAISE EXCEPTION 'CLASE_OCUPACION_GESTION_CLASES' USING ERRCODE='P0001';
 END IF;
 IF NEW.estado IS DISTINCT FROM OLD.estado THEN
  IF OLD.estado='cancelada' OR NEW.estado IS DISTINCT FROM 'cancelada'
    OR EXISTS(SELECT 1 FROM public.clases_ocurrencias WHERE reserva_cancha_id=OLD.id AND estado<>'cancelada') THEN
   RAISE EXCEPTION 'CLASE_OCUPACION_GESTION_CLASES' USING ERRCODE='P0001';
  END IF;
 END IF;
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.clases_ocurrencia_reserva_guard() FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.clases_ocurrencia_reserva_guard() TO service_role;
CREATE TRIGGER clases_ocurrencia_reserva_guard BEFORE UPDATE OR DELETE ON public.reservas FOR EACH ROW EXECUTE FUNCTION public.clases_ocurrencia_reserva_guard();
