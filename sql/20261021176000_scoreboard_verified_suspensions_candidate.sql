-- Backend-only projection: expose booking IDs only after verifying the private link.
CREATE OR REPLACE FUNCTION public.scoreboard_verified_suspended_bookings_candidate(p_ids bigint[])
RETURNS TABLE(booking_id bigint) LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog,public AS $$
 SELECT DISTINCT r.id FROM public.reservas r
 JOIN public.scoreboard_linked_suspend_candidate ss ON ss.booking_id=r.id
 JOIN public.scoreboard_partidos sb ON sb.id=ss.scoreboard_id
 WHERE r.id=ANY(coalesce(p_ids,ARRAY[]::bigint[])) AND lower(coalesce(r.estado,''))='suspendida' AND sb.estado='suspendido'
 AND (sb.reserva_id=r.id OR (sb.partido_abierto_id=ss.open_id AND EXISTS(SELECT 1 FROM public.partidos_abiertos a WHERE a.id=ss.open_id AND a.reserva_id=r.id)));
$$;
REVOKE ALL ON FUNCTION public.scoreboard_verified_suspended_bookings_candidate(bigint[]) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.scoreboard_verified_suspended_bookings_candidate(bigint[]) TO service_role;
