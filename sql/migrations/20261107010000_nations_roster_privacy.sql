-- Frontera de lectura de planteles de selecciones (fail-closed).
-- Regla: admin del torneo o capitán/creador del equipo; público solo con
-- roster_publication_approved Y el instante de revelación ya cumplido.
-- Instante de revelación = nationsRevealInstant (JS):
--   * plan_nations.config.reveal_at válido, o
--   * (fecha_inicio a las 12:00 en config.timezone) - horas_revelar_equipos (default 48).
-- Sin zona válida o con fecha inválida => hidden (no se inventa UTC).
-- Torneos comunes conservan su lectura.
BEGIN;

CREATE OR REPLACE FUNCTION public.puede_leer_nations(p_torneo_id bigint, p_equipo_id bigint DEFAULT NULL::bigint, p_partido_id bigint DEFAULT NULL::bigint)
 RETURNS boolean
 LANGUAGE plpgsql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  t public.torneos; actor uuid:=auth.uid(); cfg jsonb; rev timestamptz;
  es_sel boolean; aprobado boolean; tz text;
BEGIN
 SELECT * INTO t FROM public.torneos WHERE id=p_torneo_id;
 IF NOT FOUND THEN RETURN false; END IF;

 es_sel := (t.modalidad_plantel='selecciones' OR t.plan_nations IS NOT NULL);
 IF NOT es_sel THEN RETURN true; END IF;

 IF actor IS NOT NULL AND EXISTS(
   SELECT 1 FROM public.user_roles u WHERE u.user_id=actor
     AND (u.role='super_admin' OR (u.role='admin_club' AND u.sede_id=t.sede_id))
 ) THEN RETURN true; END IF;

 IF p_equipo_id IS NOT NULL AND actor IS NOT NULL THEN
   RETURN EXISTS(SELECT 1 FROM public.equipos e WHERE e.id=p_equipo_id AND e.torneo_id=t.id AND e.creador_id=actor);
 END IF;

 IF p_partido_id IS NOT NULL AND actor IS NOT NULL THEN
   RETURN EXISTS(
     SELECT 1 FROM public.partidos m JOIN public.equipos e ON e.id IN(m.equipo_a_id,m.equipo_b_id)
      WHERE m.id=p_partido_id AND m.torneo_id=t.id
        AND (e.creador_id=actor OR EXISTS(
              SELECT 1 FROM jsonb_array_elements(coalesce(e.jugadores,'[]'::jsonb)) j
               WHERE coalesce(j->>'user_id',j->>'id')=actor::text)));
 END IF;

 SELECT coalesce(bool_or(ev.roster_publication_approved),false) INTO aprobado
   FROM public.nations_activation_events ev WHERE ev.torneo_id=t.id;
 IF coalesce(aprobado,false) IS NOT TRUE THEN RETURN false; END IF;

 cfg := t.plan_nations->'config';
 IF cfg IS NULL THEN RETURN false; END IF;
 tz := nullif(cfg->>'timezone','');
 IF tz IS NULL THEN RETURN false; END IF;

 IF nullif(cfg->>'reveal_at','') IS NOT NULL THEN
   BEGIN
     rev := (cfg->>'reveal_at')::timestamptz;
   EXCEPTION WHEN OTHERS THEN RETURN false; END;
   IF rev IS NULL THEN RETURN false; END IF;
 ELSE
   IF t.fecha_inicio IS NULL THEN RETURN false; END IF;
   BEGIN
     rev := (((t.fecha_inicio)::date + time '12:00') AT TIME ZONE tz)
            - make_interval(hours => coalesce(t.horas_revelar_equipos,48));
   EXCEPTION WHEN OTHERS THEN RETURN false; END;
   IF rev IS NULL THEN RETURN false; END IF;
 END IF;

 RETURN now() >= rev;
END $function$;

REVOKE ALL ON FUNCTION public.puede_leer_nations(bigint,bigint,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.puede_leer_nations(bigint,bigint,bigint) TO anon, authenticated, service_role;

-- Catálogo de participantes: shared_visible FALSE por defecto y solo con aprobación + fecha.
-- Idempotente: si la RPC no existe todavía, aborta; si ya está parcheada, no hace nada.
DO $patch$
DECLARE def text; nuevo text;
BEGIN
  SELECT pg_get_functiondef(oid) INTO def FROM pg_proc WHERE proname='gestionar_participantes_torneo';
  IF def IS NULL THEN RAISE EXCEPTION 'RPC gestionar_participantes_torneo ausente'; END IF;

  -- 1) Fail-closed al entrar: selecciones o con plan => cerrado hasta aprobacion+reveal.
  IF position('MESSAGE=''Tournament missing''' IN def)=0 THEN
    RAISE EXCEPTION 'Patron Tournament missing no encontrado: forward NO aplicable';
  END IF;
  IF position('nations_privacy_fail_closed' IN def)=0 THEN
    nuevo := replace(def,
      'IF t.id IS NULL THEN RAISE EXCEPTION USING ERRCODE=''P0002'',MESSAGE=''Tournament missing'';END IF;',
      'IF t.id IS NULL THEN RAISE EXCEPTION USING ERRCODE=''P0002'',MESSAGE=''Tournament missing'';END IF; /* nations_privacy_fail_closed */ ' ||
      'shared_visible := NOT (coalesce(t.modalidad_plantel,'''')=''selecciones'' OR t.plan_nations IS NOT NULL);');
  ELSE
    nuevo := def;  -- ya inyectado: idempotente
  END IF;

  -- 2) Declaracion por defecto cerrada.
  nuevo := replace(nuevo,'shared_visible boolean:=true','shared_visible boolean:=false');

  -- 3) Al revelar: solo si aprobado Y fecha cumplida.
  IF position('shared_visible:=coalesce(reveal_at<=now(),false);' IN nuevo)>0 THEN
    nuevo := replace(nuevo,'shared_visible:=coalesce(reveal_at<=now(),false);',
      'shared_visible:=CASE WHEN NOT (coalesce(t.modalidad_plantel,'''')=''selecciones'' OR t.plan_nations IS NOT NULL) THEN true ELSE coalesce(reveal_at<=now(),false) AND EXISTS(SELECT 1 FROM public.nations_activation_events ev WHERE ev.torneo_id=t.id AND ev.roster_publication_approved) END;');
  END IF;

  IF nuevo = def THEN
    RAISE EXCEPTION 'Forward sin efecto: strings no coinciden con la RPC real';
  END IF;
  EXECUTE nuevo;
END $patch$;

COMMIT;
