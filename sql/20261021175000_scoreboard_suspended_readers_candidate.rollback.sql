-- Roll back migration 1750 only, preserving wrappers and privileges.
BEGIN;
DO $patch$
DECLARE source text; normalized text; patched text;
BEGIN
 source := pg_get_functiondef(to_regprocedure('public.programar_partido_torneo_before_occupancy_candidate(bigint,bigint,uuid,bigint,timestamp with time zone,integer)'));
 normalized := replace(source, 'public.programar_partido_torneo_before_occupancy_candidate(', 'public.programar_partido_torneo(');
 IF source IS NULL OR md5(normalized) <> 'a25c1393e30823f54f5580c0c0815587' THEN RAISE EXCEPTION 'Unexpected definition: programar_partido_torneo'; END IF;
 patched := replace(source, $old$lower(coalesce(booking.estado,'')) NOT IN('cancelada','cancelado') AND NOT (lower(coalesce(booking.estado,''))='suspendida' AND EXISTS (SELECT 1 FROM public.scoreboard_linked_suspend_candidate ss JOIN public.scoreboard_partidos sb ON sb.id=ss.scoreboard_id WHERE ss.booking_id=booking.id AND sb.estado='suspendido' AND (sb.reserva_id=booking.id OR (sb.partido_abierto_id=ss.open_id AND EXISTS (SELECT 1 FROM public.partidos_abiertos linked_open WHERE linked_open.id=ss.open_id AND linked_open.reserva_id=booking.id)))))$old$, $new$lower(coalesce(booking.estado,'')) NOT IN('cancelada','cancelado')$new$);
 patched := replace(patched, $old$p.estado NOT IN('cancelado','finalizado','suspendido')$old$, $new$p.estado NOT IN('cancelado','finalizado')$new$);
 EXECUTE patched;
 source := pg_get_functiondef(to_regprocedure('public.guardar_plan_nations_before_occupancy_candidate(bigint,uuid,text,bigint,uuid,text,jsonb)'));
 normalized := replace(source, 'public.guardar_plan_nations_before_occupancy_candidate(', 'public.guardar_plan_nations(');
 IF source IS NULL OR md5(normalized) <> 'cc6d5fa08ddbb3f154484e71b6b300ba' THEN RAISE EXCEPTION 'Unexpected definition: guardar_plan_nations'; END IF;
 patched := replace(source, $old$lower(coalesce(r.estado,'')) NOT IN('cancelada','cancelado') AND NOT (lower(coalesce(r.estado,''))='suspendida' AND EXISTS (SELECT 1 FROM public.scoreboard_linked_suspend_candidate ss JOIN public.scoreboard_partidos sb ON sb.id=ss.scoreboard_id WHERE ss.booking_id=r.id AND sb.estado='suspendido' AND (sb.reserva_id=r.id OR (sb.partido_abierto_id=ss.open_id AND EXISTS (SELECT 1 FROM public.partidos_abiertos linked_open WHERE linked_open.id=ss.open_id AND linked_open.reserva_id=r.id)))))$old$, $new$lower(coalesce(r.estado,'')) NOT IN('cancelada','cancelado')$new$);
 EXECUTE patched;
 source := pg_get_functiondef(to_regprocedure('public.preparar_marcador_antes_ocupacion_candidate(bigint,bigint,uuid,bigint)'));
 normalized := replace(source, 'public.preparar_marcador_antes_ocupacion_candidate(', 'public.preparar_marcador_torneo_ahora(');
 IF source IS NULL OR md5(normalized) <> 'cbf36e47da94c57f563c12f07d2c51e3' THEN RAISE EXCEPTION 'Unexpected definition: preparar_marcador_torneo_ahora'; END IF;
 patched := replace(source, $old$lower(coalesce(b.estado,'')) NOT IN('cancelada','cancelado') AND NOT (lower(coalesce(b.estado,''))='suspendida' AND EXISTS (SELECT 1 FROM public.scoreboard_linked_suspend_candidate ss JOIN public.scoreboard_partidos sb ON sb.id=ss.scoreboard_id WHERE ss.booking_id=b.id AND sb.estado='suspendido' AND (sb.reserva_id=b.id OR (sb.partido_abierto_id=ss.open_id AND EXISTS (SELECT 1 FROM public.partidos_abiertos linked_open WHERE linked_open.id=ss.open_id AND linked_open.reserva_id=b.id)))))$old$, $new$lower(coalesce(b.estado,'')) NOT IN('cancelada','cancelado')$new$);
 patched := replace(patched, $old$p.estado NOT IN('cancelado','finalizado','suspendido')$old$, $new$p.estado NOT IN('cancelado','finalizado')$new$);
 EXECUTE patched;
END $patch$;
COMMIT;
