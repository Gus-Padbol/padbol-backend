-- Roll back only migration 1750, preserving wrappers and existing privileges.
BEGIN;
DO $patch$
DECLARE source text; normalized text; patched text;
BEGIN
 source := pg_get_functiondef(to_regprocedure('public.programar_partido_torneo_before_occupancy_candidate(bigint,bigint,uuid,bigint,timestamp with time zone,integer)'));
 normalized := replace(source, 'public.programar_partido_torneo_before_occupancy_candidate(', 'public.programar_partido_torneo(');
 IF source IS NULL OR md5(normalized) <> '1ab5cf562e2269bddb9387b5f9eff8a4' THEN RAISE EXCEPTION 'Unexpected patched definition: programar_partido_torneo'; END IF;
 patched := replace(source, $old$lower(coalesce(booking.estado,'')) NOT IN('cancelada','cancelado','suspendida')$old$, $new$lower(coalesce(booking.estado,'')) NOT IN('cancelada','cancelado')$new$);
 patched := replace(patched, $old$p.estado NOT IN('cancelado','finalizado','suspendido')$old$, $new$p.estado NOT IN('cancelado','finalizado')$new$);
 EXECUTE patched;
 source := pg_get_functiondef(to_regprocedure('public.guardar_plan_nations_before_occupancy_candidate(bigint,uuid,text,bigint,uuid,text,jsonb)'));
 normalized := replace(source, 'public.guardar_plan_nations_before_occupancy_candidate(', 'public.guardar_plan_nations(');
 IF source IS NULL OR md5(normalized) <> '1e3668248a070b39f38127298527fe2d' THEN RAISE EXCEPTION 'Unexpected patched definition: guardar_plan_nations'; END IF;
 patched := replace(source, $old$lower(coalesce(r.estado,'')) NOT IN('cancelada','cancelado','suspendida')$old$, $new$lower(coalesce(r.estado,'')) NOT IN('cancelada','cancelado')$new$);
 EXECUTE patched;
 source := pg_get_functiondef(to_regprocedure('public.preparar_marcador_antes_ocupacion_candidate(bigint,bigint,uuid,bigint)'));
 normalized := replace(source, 'public.preparar_marcador_antes_ocupacion_candidate(', 'public.preparar_marcador_torneo_ahora(');
 IF source IS NULL OR md5(normalized) <> '917260d6f78b2cfca06d8512cebe3af0' THEN RAISE EXCEPTION 'Unexpected patched definition: preparar_marcador_torneo_ahora'; END IF;
 patched := replace(source, $old$lower(coalesce(b.estado,'')) NOT IN('cancelada','cancelado','suspendida')$old$, $new$lower(coalesce(b.estado,'')) NOT IN('cancelada','cancelado')$new$);
 patched := replace(patched, $old$p.estado NOT IN('cancelado','finalizado','suspendido')$old$, $new$p.estado NOT IN('cancelado','finalizado')$new$);
 EXECUTE patched;
END $patch$;
COMMIT;
