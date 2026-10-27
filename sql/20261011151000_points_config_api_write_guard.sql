-- Preserve every stored value and policy; only the validated SuperAdmin API writes.
BEGIN;
REVOKE INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER ON public.config_puntos FROM anon,authenticated;
GRANT SELECT ON public.config_puntos TO anon,authenticated;
GRANT SELECT,INSERT,UPDATE,DELETE ON public.config_puntos TO service_role;
COMMIT;
