BEGIN;
ALTER TABLE public.sedes ADD COLUMN IF NOT EXISTS es_prueba boolean NOT NULL DEFAULT false;
COMMENT ON COLUMN public.sedes.es_prueba IS 'Service-managed QA venue, excluded from player catalogs. No existing venue is reclassified automatically.';
DROP TRIGGER IF EXISTS protect_sede_qa_marker ON public.sedes;
CREATE TRIGGER protect_sede_qa_marker BEFORE INSERT OR UPDATE OF es_prueba ON public.sedes
 FOR EACH ROW EXECUTE FUNCTION public.protect_torneo_qa_marker();

CREATE OR REPLACE FUNCTION public.validate_tournament_calendar()
RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog,public AS $$
DECLARE event_zone text; event_today date; closing boolean; synced_final_date date;
BEGIN
 closing := NEW.estado='finalizado' AND (TG_OP='INSERT' OR OLD.estado IS DISTINCT FROM 'finalizado');
 IF closing THEN
   SELECT COALESCE(NULLIF(NEW.plan_nations->'config'->>'timezone',''),s.timezone,'America/Argentina/Buenos_Aires') INTO event_zone FROM public.sedes s WHERE s.id=NEW.sede_id;
   event_zone := COALESCE(event_zone,NULLIF(NEW.plan_nations->'config'->>'timezone',''),'America/Argentina/Buenos_Aires');
   event_today := (now() AT TIME ZONE event_zone)::date;
   IF NEW.fecha_inicio > event_today THEN
     IF NOT NEW.es_prueba THEN
       RAISE EXCEPTION 'No se puede finalizar un torneo real antes de su fecha de inicio' USING ERRCODE='22007';
     ELSE
       NEW.fecha_fin := GREATEST(CASE WHEN TG_OP='UPDATE' THEN OLD.fecha_fin ELSE NEW.fecha_fin END,NEW.fecha_inicio);
     END IF;
   ELSE
     -- A delayed first closure must retain the verified final scoreboard's
     -- server-owned sync date. Never trust a client-supplied historical date.
     SELECT (sb.synced_to_torneo_at AT TIME ZONE event_zone)::date
       INTO synced_final_date
       FROM public.scoreboard_partidos sb
       JOIN public.partidos p ON p.id=sb.partido_torneo_id
      WHERE NEW.plan_nations IS NULL
        AND NEW.tipo_torneo IN ('knockout','grupos_knockout')
        AND sb.torneo_id=NEW.id AND sb.sede_id=NEW.sede_id
        AND p.torneo_id=NEW.id AND p.estado='finalizado'
        AND p.ganador_equipo_id IS NOT NULL
        AND p.bracket_round IS NOT NULL AND p.partido_siguiente_id IS NULL
        AND p.bracket_round=(SELECT max(f.bracket_round) FROM public.partidos f WHERE f.torneo_id=NEW.id)
        AND sb.estado IN ('terminado','finalizado') AND sb.sync_torneo_status='synced'
        AND sb.synced_to_torneo_at IS NOT NULL AND sb.synced_to_torneo_at<=now()
        AND (sb.synced_to_torneo_at AT TIME ZONE event_zone)::date=NEW.fecha_fin
        AND (NEW.fecha_inicio IS NULL OR (sb.synced_to_torneo_at AT TIME ZONE event_zone)::date>=NEW.fecha_inicio)
      ORDER BY sb.synced_to_torneo_at DESC LIMIT 1;
     NEW.fecha_fin := COALESCE(synced_final_date,event_today);
   END IF;
 END IF;
 IF NEW.fecha_inicio IS NOT NULL AND NEW.fecha_fin IS NOT NULL AND NEW.fecha_fin < NEW.fecha_inicio THEN
   RAISE EXCEPTION 'La fecha de fin no puede ser anterior a la fecha de inicio' USING ERRCODE='22007';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.validate_tournament_calendar() FROM PUBLIC;
DROP TRIGGER IF EXISTS validate_tournament_calendar ON public.torneos;
CREATE TRIGGER validate_tournament_calendar BEFORE INSERT OR UPDATE OF fecha_inicio,fecha_fin,estado ON public.torneos
 FOR EACH ROW EXECUTE FUNCTION public.validate_tournament_calendar();
COMMIT;
