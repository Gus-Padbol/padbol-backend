BEGIN;
ALTER TABLE public.jugadores_perfil
  ADD COLUMN IF NOT EXISTS es_prueba boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.jugadores_perfil.es_prueba IS
 'Service-managed QA fixture marker. Excludes synthetic accounts from administrative adoption metrics; does not change profile ownership or test access.';
CREATE OR REPLACE FUNCTION public.protect_profile_qa_marker()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER
SET search_path = pg_catalog, public AS $$
BEGIN
 IF (TG_OP = 'INSERT' AND NEW.es_prueba)
    OR (TG_OP = 'UPDATE' AND NEW.es_prueba IS DISTINCT FROM OLD.es_prueba) THEN
   IF current_user NOT IN ('postgres','service_role','supabase_admin') THEN
     RAISE EXCEPTION 'The QA profile marker is managed by the service only' USING ERRCODE = '42501';
   END IF;
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.protect_profile_qa_marker() FROM PUBLIC;
DROP TRIGGER IF EXISTS protect_profile_qa_marker ON public.jugadores_perfil;
CREATE TRIGGER protect_profile_qa_marker
 BEFORE INSERT OR UPDATE OF es_prueba ON public.jugadores_perfil
 FOR EACH ROW EXECUTE FUNCTION public.protect_profile_qa_marker();
-- No automatic classification/backfill. Existing accounts stay untouched.
COMMIT;
