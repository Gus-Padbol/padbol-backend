-- Experimental. Requires wrappers 1700, 1710 and 1730; exact source verification is mandatory.
BEGIN;
DO $patch$
DECLARE source text; normalized text; patched text;
BEGIN
 source := pg_get_functiondef(to_regprocedure('public.programar_partido_torneo_before_occupancy_candidate(bigint,bigint,uuid,bigint,timestamp with time zone,integer)'));
 normalized := replace(source, 'public.programar_partido_torneo_before_occupancy_candidate(', 'public.programar_partido_torneo(');
 IF source IS NULL OR md5(normalized) <> '037678dd8866bb9366f7f72ad9241dd3' THEN RAISE EXCEPTION 'Unexpected deployed definition: programar_partido_torneo'; END IF;
 patched := replace(source, $old$lower(coalesce(booking.estado,'')) NOT IN('cancelada','cancelado')$old$, $new$lower(coalesce(booking.estado,'')) NOT IN('cancelada','cancelado','suspendida')$new$);
 patched := replace(patched, $old$p.estado NOT IN('cancelado','finalizado')$old$, $new$p.estado NOT IN('cancelado','finalizado','suspendido')$new$);
 IF patched=source THEN RAISE EXCEPTION 'Expected occupancy predicate absent'; END IF;
 EXECUTE patched;
 source := pg_get_functiondef(to_regprocedure('public.guardar_plan_nations_before_occupancy_candidate(bigint,uuid,text,bigint,uuid,text,jsonb)'));
 normalized := replace(source, 'public.guardar_plan_nations_before_occupancy_candidate(', 'public.guardar_plan_nations(');
 IF source IS NULL OR md5(normalized) <> '70b7540b23f03e365a260cb8f1ad5d2d' THEN RAISE EXCEPTION 'Unexpected deployed definition: guardar_plan_nations'; END IF;
 patched := replace(source, $old$lower(coalesce(r.estado,'')) NOT IN('cancelada','cancelado')$old$, $new$lower(coalesce(r.estado,'')) NOT IN('cancelada','cancelado','suspendida')$new$);
 IF patched=source THEN RAISE EXCEPTION 'Expected occupancy predicate absent'; END IF;
 EXECUTE patched;
 source := pg_get_functiondef(to_regprocedure('public.preparar_marcador_antes_ocupacion_candidate(bigint,bigint,uuid,bigint)'));
 normalized := replace(source, 'public.preparar_marcador_antes_ocupacion_candidate(', 'public.preparar_marcador_torneo_ahora(');
 IF source IS NULL OR md5(normalized) <> 'c0c75dab49b46cae03f0da686d013eaf' THEN RAISE EXCEPTION 'Unexpected deployed definition: preparar_marcador_torneo_ahora'; END IF;
 patched := replace(source, $old$lower(coalesce(b.estado,'')) NOT IN('cancelada','cancelado')$old$, $new$lower(coalesce(b.estado,'')) NOT IN('cancelada','cancelado','suspendida')$new$);
 patched := replace(patched, $old$p.estado NOT IN('cancelado','finalizado')$old$, $new$p.estado NOT IN('cancelado','finalizado','suspendido')$new$);
 IF patched=source THEN RAISE EXCEPTION 'Expected occupancy predicate absent'; END IF;
 EXECUTE patched;
END $patch$;
COMMIT;
