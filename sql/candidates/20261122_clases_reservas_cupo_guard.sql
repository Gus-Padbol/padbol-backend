-- Candidato local CLASES-CUPO-001: serializa reservas por clase y valida cupo
-- dentro de la misma transacción. No crear en producción desde este lote.
CREATE OR REPLACE FUNCTION public.clases_reservas_cupo_guard()
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

  -- Bloquea la fila de la clase: dos reservas simultáneas de la última plaza
  -- se serializan antes de contar, no hay count/insert separado sin lock.
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
    FROM public.clases_reservas
   WHERE clase_id = NEW.clase_id;

  IF v_ocupadas >= COALESCE(v_cupo, 4) THEN
    RAISE EXCEPTION 'CLASE_COMPLETA' USING ERRCODE = 'P0001';
  END IF;

  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS clases_reservas_cupo_guard ON public.clases_reservas;
CREATE TRIGGER clases_reservas_cupo_guard
BEFORE INSERT ON public.clases_reservas
FOR EACH ROW EXECUTE FUNCTION public.clases_reservas_cupo_guard();

COMMENT ON FUNCTION public.clases_reservas_cupo_guard() IS
  'CLASES-CUPO-001 local: bloquea clase y evita sobrecupo en INSERT concurrente.';
