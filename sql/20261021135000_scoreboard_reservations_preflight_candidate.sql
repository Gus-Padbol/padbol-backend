-- Preconditions hold in the same transaction as all dependent migrations.
SET LOCAL lock_timeout = '5s';
SET LOCAL search_path = public, pg_catalog;
LOCK TABLE public.reservas IN SHARE ROW EXCLUSIVE MODE;
DO $preflight$
DECLARE actual jsonb;
BEGIN
 IF md5(pg_get_functiondef(to_regprocedure('public.reservas_guardar_sin_solape()'))) IS DISTINCT FROM '60cfc11f05d500a56de9d86243c39947' THEN
  RAISE EXCEPTION 'Unexpected reservation overlap function';
 END IF;
 SELECT coalesce(jsonb_agg(jsonb_build_object('name',tgname,'definition',pg_get_triggerdef(t.oid),'enabled',tgenabled) ORDER BY tgname),'[]'::jsonb) INTO actual
 FROM pg_trigger t WHERE t.tgrelid='public.reservas'::regclass AND NOT t.tgisinternal;
 IF actual IS DISTINCT FROM $expected$[{"name":"proteger_reserva_fixture_general","definition":"CREATE TRIGGER proteger_reserva_fixture_general BEFORE INSERT OR UPDATE ON public.reservas FOR EACH ROW EXECUTE FUNCTION proteger_reserva_fixture_general()","enabled":"O"},{"name":"proteger_reserva_nations","definition":"CREATE TRIGGER proteger_reserva_nations BEFORE INSERT OR UPDATE ON public.reservas FOR EACH ROW EXECUTE FUNCTION proteger_reserva_nations()","enabled":"O"},{"name":"proteger_reserva_origen_creacion","definition":"CREATE TRIGGER proteger_reserva_origen_creacion BEFORE INSERT OR UPDATE ON public.reservas FOR EACH ROW EXECUTE FUNCTION proteger_reserva_origen_creacion()","enabled":"O"},{"name":"reservas_sin_solape","definition":"CREATE TRIGGER reservas_sin_solape BEFORE INSERT OR UPDATE ON public.reservas FOR EACH ROW EXECUTE FUNCTION reservas_guardar_sin_solape()","enabled":"O"}]$expected$::jsonb THEN
  RAISE EXCEPTION 'Unexpected reservation triggers';
 END IF;
END $preflight$;
