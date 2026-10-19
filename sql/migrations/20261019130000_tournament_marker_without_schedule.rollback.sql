BEGIN;
DROP TRIGGER IF EXISTS proteger_cancha_marcador_activo ON public.scoreboard_partidos;
DROP FUNCTION IF EXISTS public.proteger_cancha_marcador_activo();
DROP FUNCTION IF EXISTS public.preparar_marcador_torneo_ahora(bigint,bigint,uuid,bigint);
-- Restore the exact pre-migration Nations guard, including its former schedule requirement.
CREATE OR REPLACE FUNCTION public.proteger_marcador_nations()
 RETURNS trigger
 LANGUAGE plpgsql
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE t public.torneos; m public.partidos; s public.torneo_nations_programacion; c public.canchas; court_number integer;
BEGIN
 IF NEW.torneo_id IS NULL OR NEW.partido_torneo_id IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO t FROM public.torneos WHERE id=NEW.torneo_id FOR UPDATE;
 IF t.plan_nations IS NULL THEN RETURN NEW; END IF;
 SELECT * INTO m FROM public.partidos WHERE id=NEW.partido_torneo_id FOR UPDATE;
 SELECT * INTO s FROM public.torneo_nations_programacion WHERE partido_id=m.id AND torneo_id=t.id;
 SELECT * INTO c FROM public.canchas WHERE id=s.court_id;
 court_number:=coalesce(c.orden,(SELECT count(*)::int FROM public.canchas WHERE sede_id=t.sede_id AND id<=c.id));
 IF s.partido_id IS NULL OR m.torneo_id IS DISTINCT FROM t.id OR m.sede_id IS DISTINCT FROM t.sede_id OR c.sede_id IS DISTINCT FROM t.sede_id OR m.cancha_id IS DISTINCT FROM s.court_id OR m.cancha IS DISTINCT FROM court_number::text OR NEW.cancha IS DISTINCT FROM court_number::text THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Nations scoreboard requires confirmed real court schedule'; END IF;
 RETURN NEW;
END $function$
;
COMMIT;
