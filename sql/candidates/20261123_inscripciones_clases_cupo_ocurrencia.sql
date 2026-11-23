-- Candidato local CLASES-OCURRENCIA-001: cupo por fecha/hora y clase.
-- No aplicar en producción desde este lote. Mantiene el contrato de /api/clases/inscribir.
CREATE OR REPLACE FUNCTION public.inscripciones_clases_cupo_ocurrencia_guard()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  v_cupo integer;
  v_activo boolean;
  v_ocupadas integer;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RETURN NEW;
  END IF;

  -- Serializa las inscripciones de la misma clase; luego cuenta sólo la
  -- ocurrencia exacta (fecha + hora), no la plantilla completa.
  SELECT cupo_maximo, activo
    INTO v_cupo, v_activo
    FROM public.clases
   WHERE id = NEW.clase_id
   FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'CLASE_NO_ENCONTRADA' USING ERRCODE = 'P0001';
  END IF;
  IF v_activo IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CLASE_INACTIVA' USING ERRCODE = 'P0001';
  END IF;

  SELECT count(*) INTO v_ocupadas
    FROM public.inscripciones_clases
   WHERE clase_id = NEW.clase_id
     AND fecha = NEW.fecha
     AND hora_inicio = NEW.hora_inicio
     AND lower(COALESCE(estado, '')) IN ('pendiente', 'confirmada', 'pagada');

  IF v_ocupadas >= COALESCE(v_cupo, 4) THEN
    RAISE EXCEPTION 'CLASE_OCURRENCIA_COMPLETA' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS inscripciones_clases_cupo_ocurrencia_guard ON public.inscripciones_clases;
CREATE TRIGGER inscripciones_clases_cupo_ocurrencia_guard
BEFORE INSERT ON public.inscripciones_clases
FOR EACH ROW EXECUTE FUNCTION public.inscripciones_clases_cupo_ocurrencia_guard();
