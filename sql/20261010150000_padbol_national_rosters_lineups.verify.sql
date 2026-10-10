-- Read-only metadata gate. No user records, tokens or credentials are selected.
SELECT
 (SELECT count(*)=1 FROM information_schema.columns WHERE table_schema='public' AND table_name='torneos' AND column_name='modalidad_plantel' AND is_nullable='NO') AS tournament_mode_present,
 (SELECT count(*)=3 FROM information_schema.columns WHERE table_schema='public' AND table_name='equipos' AND column_name IN('modalidad_plantel','plantel_revision','participantes_ranking')) AS team_columns_present,
 to_regclass('public.torneo_partido_alineaciones') IS NOT NULL AS lineups_present,
 to_regclass('public.torneo_partido_participacion') IS NOT NULL AS history_present,
 (SELECT count(*)=4 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' AND p.proname IN('guardar_alineacion_seleccion','guardar_plantel_seleccion','finalizar_partido_seleccion','finalizar_torneo_seleccion') AND p.prosecdef AND has_function_privilege('service_role',p.oid,'EXECUTE') AND NOT has_function_privilege('authenticated',p.oid,'EXECUTE') AND NOT has_function_privilege('anon',p.oid,'EXECUTE')) AS private_rpcs_present,
 (SELECT count(*)=2 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname IN('torneo_partido_alineaciones','torneo_partido_participacion') AND c.relrowsecurity) AS history_rls_enabled,
 (SELECT count(*)=4 FROM pg_trigger WHERE tgname IN('proteger_selecciones_torneos','proteger_selecciones_equipos','proteger_selecciones_alineaciones','proteger_selecciones_resultado') AND NOT tgisinternal AND tgenabled='O') AS guards_enabled,
 (SELECT count(*)=1 FROM pg_trigger WHERE tgname='proteger_selecciones_marcador' AND NOT tgisinternal AND tgenabled='O') AS scoreboard_guard_enabled;
