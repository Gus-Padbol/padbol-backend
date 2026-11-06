-- Invariante de DB: no se puede crear ni mover una reserva a una sede de torneo.
-- La función de trigger es SECURITY DEFINER porque el rol que inserta reservas no tiene
-- (ni debe tener) SELECT sobre public.sedes. Se acota al mínimo: sin SQL dinámico,
-- search_path fijo, nombres calificados, sin retorno de datos y sin EXECUTE público.
BEGIN;

CREATE OR REPLACE FUNCTION public.reserva_sede_reservable()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  v_tipo text;
  v_match int;
BEGIN
  -- Solo se rechaza cuando la sede se resuelve SIN ambigüedad a tipo torneo.
  -- Nombre legacy, desconocido o ambiguo no bloquea una reserva histórica legítima.
  IF NEW.sede_id IS NOT NULL THEN
    SELECT s.tipo_sede INTO v_tipo FROM public.sedes s WHERE s.id = NEW.sede_id;
  ELSIF NEW.sede IS NOT NULL THEN
    SELECT count(*), min(s.tipo_sede) INTO v_match, v_tipo
      FROM public.sedes s WHERE s.nombre = NEW.sede;
    IF v_match <> 1 THEN
      RETURN NEW;
    END IF;
  ELSE
    RETURN NEW;
  END IF;

  IF lower(coalesce(v_tipo, '')) = 'torneo' THEN
    RAISE EXCEPTION 'SEDE_NO_RESERVABLE' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

REVOKE ALL ON FUNCTION public.reserva_sede_reservable() FROM PUBLIC;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.reserva_sede_reservable() FROM anon';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    EXECUTE 'REVOKE ALL ON FUNCTION public.reserva_sede_reservable() FROM authenticated';
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_user') THEN
    EXECUTE 'GRANT EXECUTE ON FUNCTION public.reserva_sede_reservable() TO app_user';
  END IF;
END $$;

DROP TRIGGER IF EXISTS reservas_sede_reservable_trg ON public.reservas;
CREATE TRIGGER reservas_sede_reservable_trg
  BEFORE INSERT OR UPDATE OF sede_id, sede ON public.reservas
  FOR EACH ROW EXECUTE FUNCTION public.reserva_sede_reservable();

COMMIT;
