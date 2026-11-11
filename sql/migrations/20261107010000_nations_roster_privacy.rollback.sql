-- Rollback de la frontera de lectura de planteles.
-- Restaura la version previa: con plan_nations NULL devolvia true (comportamiento original)
-- y revierte el catalogo de la RPC a shared_visible por fecha, sin aprobacion.
-- Advertencia: restaura la fuga conocida; solo para recuperacion controlada.
BEGIN;

CREATE OR REPLACE FUNCTION public.puede_leer_nations(p_torneo_id bigint, p_equipo_id bigint DEFAULT NULL::bigint, p_partido_id bigint DEFAULT NULL::bigint)
 RETURNS boolean LANGUAGE plpgsql STABLE SECURITY DEFINER SET search_path TO 'public','pg_temp'
AS $function$
DECLARE t public.torneos; actor uuid:=auth.uid();
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id;
 IF NOT FOUND THEN RETURN false; END IF;
 IF t.plan_nations IS NULL THEN RETURN true; END IF;
 IF actor IS NULL THEN RETURN false; END IF;
 IF EXISTS(SELECT 1 FROM public.user_roles u WHERE u.user_id=actor AND (u.role='super_admin' OR u.role='admin_club' AND u.sede_id=t.sede_id)) THEN RETURN true; END IF;
 IF p_equipo_id IS NOT NULL THEN RETURN EXISTS(SELECT 1 FROM public.equipos e WHERE e.id=p_equipo_id AND e.torneo_id=t.id AND e.creador_id=actor); END IF;
 IF p_partido_id IS NOT NULL THEN RETURN EXISTS(SELECT 1 FROM public.partidos m JOIN public.equipos e ON e.id IN(m.equipo_a_id,m.equipo_b_id) WHERE m.id=p_partido_id AND m.torneo_id=t.id AND (e.creador_id=actor OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(e.jugadores,'[]'::jsonb)) j WHERE coalesce(j->>'user_id',j->>'id')=actor::text))); END IF;
 RETURN false;
END $function$;
REVOKE ALL ON FUNCTION public.puede_leer_nations(bigint,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.puede_leer_nations(bigint,bigint,bigint) TO anon, authenticated, service_role;

DO $patch$
DECLARE def text; nuevo text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO def FROM pg_proc WHERE proname='gestionar_participantes_torneo';
  nuevo := replace(def,
    'shared_visible:=coalesce(reveal_at<=now(),false) AND EXISTS(SELECT 1 FROM public.nations_activation_events ev WHERE ev.torneo_id=t.id AND ev.roster_publication_approved);',
    'shared_visible:=coalesce(reveal_at<=now(),false);');
  nuevo := replace(nuevo,'shared_visible boolean:=false','shared_visible boolean:=true');
  IF nuevo IS DISTINCT FROM def THEN EXECUTE nuevo; END IF;
END $patch$;

COMMIT;
