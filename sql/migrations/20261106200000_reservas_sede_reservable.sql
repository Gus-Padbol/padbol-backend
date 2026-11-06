-- Invariante de DB: no se puede crear ni mover una reserva a una sede de torneo.
-- Resolución de sede: si hay sede_id se usa ese; si no, se resuelve por nombre.
-- Nombre ambiguo (más de una sede con ese nombre) => se rechaza.
BEGIN;

CREATE OR REPLACE FUNCTION public.reserva_sede_reservable()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog, public AS $$
DECLARE
  v_tipo text;
  v_match int;
BEGIN
  IF NEW.sede_id IS NOT NULL THEN
    SELECT tipo_sede INTO v_tipo FROM public.sedes WHERE id = NEW.sede_id;
    IF v_tipo IS NULL THEN
      RAISE EXCEPTION 'SEDE_DESCONOCIDA' USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.sede IS NOT NULL THEN
    SELECT count(*), min(tipo_sede) INTO v_match, v_tipo FROM public.sedes WHERE nombre = NEW.sede;
    IF v_match <> 1 THEN
      RAISE EXCEPTION 'SEDE_AMBIGUA_O_DESCONOCIDA' USING ERRCODE = '23514';
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF lower(coalesce(v_tipo, '')) = 'torneo' THEN
    RAISE EXCEPTION 'SEDE_NO_RESERVABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS reservas_sede_reservable_trg ON public.reservas;
CREATE TRIGGER reservas_sede_reservable_trg
  BEFORE INSERT OR UPDATE OF sede_id, sede ON public.reservas
  FOR EACH ROW EXECUTE FUNCTION public.reserva_sede_reservable();

COMMIT;
