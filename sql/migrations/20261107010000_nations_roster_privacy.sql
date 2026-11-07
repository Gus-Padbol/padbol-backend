-- Frontera de lectura de planteles de selecciones.
-- Antes: con plan_nations NULL la funcion devolvia true y la policy permisiva
-- "Lectura pública equipos" (USING true) dejaba leer public.equipos por REST.
-- Ahora: selecciones => admin o capitan/creador del equipo; publico solo con
-- roster_publication_approved Y fecha de revelacion cumplida. Torneos normales igual.
BEGIN;

CREATE OR REPLACE FUNCTION public.puede_leer_nations(p_torneo_id bigint, p_equipo_id bigint DEFAULT NULL::bigint, p_partido_id bigint DEFAULT NULL::bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t public.torneos; actor uuid:=auth.uid(); es_sel boolean; aprobado boolean; revelado boolean;
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id;
 IF NOT FOUND THEN RETURN false; END IF;
 es_sel := (t.modalidad_plantel='selecciones' OR t.plan_nations IS NOT NULL);
 IF NOT es_sel THEN RETURN true; END IF;  -- torneos comunes conservan su lectura

 IF actor IS NOT NULL AND EXISTS(SELECT 1 FROM public.user_roles u WHERE u.user_id=actor AND (u.role='super_admin' OR (u.role='admin_club' AND u.sede_id=t.sede_id))) THEN RETURN true; END IF;

 IF p_equipo_id IS NOT NULL AND actor IS NOT NULL THEN
   RETURN EXISTS(SELECT 1 FROM public.equipos e WHERE e.id=p_equipo_id AND e.torneo_id=t.id AND e.creador_id=actor);
 END IF;
 IF p_partido_id IS NOT NULL AND actor IS NOT NULL THEN
   RETURN EXISTS(SELECT 1 FROM public.partidos m JOIN public.equipos e ON e.id IN(m.equipo_a_id,m.equipo_b_id)
                  WHERE m.id=p_partido_id AND m.torneo_id=t.id
                    AND (e.creador_id=actor OR EXISTS(SELECT 1 FROM jsonb_array_elements(coalesce(e.jugadores,'[]'::jsonb)) j
                          WHERE coalesce(j->>'user_id',j->>'id')=actor::text)));
 END IF;

 -- Publico: solo con aprobacion explicita y fecha de revelacion cumplida.
 SELECT coalesce(bool_or(ev.roster_publication_approved), false) INTO aprobado
   FROM public.nations_activation_events ev WHERE ev.torneo_id=t.id;
 revelado := t.fecha_inicio IS NOT NULL AND t.horas_revelar_equipos IS NOT NULL
   AND now() >= (t.fecha_inicio::timestamptz - make_interval(hours => t.horas_revelar_equipos));
 RETURN coalesce(aprobado,false) AND revelado;
END $function$;

REVOKE ALL ON FUNCTION public.puede_leer_nations(bigint,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.puede_leer_nations(bigint,bigint,bigint) TO anon, authenticated, service_role;

COMMIT;
