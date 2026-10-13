SELECT EXISTS(SELECT 1 FROM pg_trigger WHERE tgrelid='public.reservas'::regclass AND tgname='reservas_sin_solape' AND tgenabled='O') AS guard_enabled,
       NOT has_function_privilege('anon','public.reservas_guardar_sin_solape()','EXECUTE') AS anon_cannot_call,
       NOT has_function_privilege('authenticated','public.reservas_guardar_sin_solape()','EXECUTE') AS authenticated_cannot_call,
       public.reserva_intervalo_guard('2026-11-20','23:30',NULL,90) && public.reserva_intervalo_guard('2026-11-21','00:00',NULL,60) AS midnight_overlap,
       NOT (public.reserva_intervalo_guard('2026-11-20','10:00',NULL,60) && public.reserva_intervalo_guard('2026-11-20','11:00',NULL,60)) AS adjacent_allowed;
