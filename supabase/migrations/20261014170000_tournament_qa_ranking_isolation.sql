BEGIN;

ALTER TABLE public.torneos
  ADD COLUMN IF NOT EXISTS es_prueba boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN public.torneos.es_prueba IS
  'Explicit service-managed QA event marker. Internal simulations retain their ledger but are excluded from public ranking and history.';

CREATE OR REPLACE FUNCTION public.protect_torneo_qa_marker()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF (TG_OP = 'INSERT' AND NEW.es_prueba)
     OR (TG_OP = 'UPDATE' AND NEW.es_prueba IS DISTINCT FROM OLD.es_prueba) THEN
    IF current_user NOT IN ('postgres', 'service_role', 'supabase_admin') THEN
      RAISE EXCEPTION 'The QA tournament marker is managed by the service only'
        USING ERRCODE = '42501';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.protect_torneo_qa_marker() FROM PUBLIC;
DROP TRIGGER IF EXISTS protect_torneo_qa_marker ON public.torneos;
CREATE TRIGGER protect_torneo_qa_marker
  BEFORE INSERT OR UPDATE OF es_prueba ON public.torneos
  FOR EACH ROW EXECUTE FUNCTION public.protect_torneo_qa_marker();

COMMIT;
