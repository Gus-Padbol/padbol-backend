-- One-way projection from an authoritative final sporting result to its existing marker.
-- No marker, game, point-history or participant creation. No data backfill.
BEGIN;
CREATE OR REPLACE FUNCTION public.sync_linked_scoreboard_final_result()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog,public AS $$
DECLARE t public.torneos;sa integer;sb integer;winner bigint;
BEGIN
 IF NEW.estado IS DISTINCT FROM 'finalizado' THEN RETURN NEW;END IF;
 -- The scoreboard path may already contain exactly this terminal result. No second write.
 IF NOT EXISTS(SELECT 1 FROM public.scoreboard_partidos s WHERE s.partido_torneo_id=NEW.id AND s.torneo_id=NEW.torneo_id) THEN RETURN NEW;END IF;
 SELECT * INTO t FROM public.torneos WHERE id=NEW.torneo_id;
 IF t.deporte IS DISTINCT FROM 'padbol' THEN RETURN NEW;END IF;
 IF jsonb_typeof(NEW.resultado->'goles_a') IS DISTINCT FROM 'number' OR jsonb_typeof(NEW.resultado->'goles_b') IS DISTINCT FROM 'number' THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Linked Padbol scoreboard requires authoritative final sets';END IF;
 sa:=(NEW.resultado->>'goles_a')::integer;sb:=(NEW.resultado->>'goles_b')::integer;
 IF (NEW.resultado->>'goles_a')::numeric IS DISTINCT FROM sa::numeric OR (NEW.resultado->>'goles_b')::numeric IS DISTINCT FROM sb::numeric THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Final sets must be whole numbers';END IF;
 IF NOT((sa=2 AND sb IN(0,1))OR(sb=2 AND sa IN(0,1))) OR NEW.equipo_a_id IS NULL OR NEW.equipo_b_id IS NULL THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Linked Padbol scoreboard requires a completed best-of-three result';END IF;
 winner:=CASE WHEN sa>sb THEN NEW.equipo_a_id ELSE NEW.equipo_b_id END;
 IF NEW.ganador_equipo_id IS DISTINCT FROM winner THEN RAISE EXCEPTION USING ERRCODE='22023',MESSAGE='Linked scoreboard winner differs from authoritative result';END IF;
 -- Updating scoreboard does not write partidos; ordinary score sync sees an identical result
 -- and is idempotent. Actual set games are copied only when supplied by the result.
 UPDATE public.scoreboard_partidos s SET estado='terminado',sets_a=sa,sets_b=sb,
  historial_sets=NEW.resultado->'historial_sets',sync_torneo_status='synced',synced_to_torneo_at=clock_timestamp()
 WHERE s.partido_torneo_id=NEW.id AND s.torneo_id=NEW.torneo_id
  AND(s.estado NOT IN('terminado','finalizado') OR s.sets_a IS DISTINCT FROM sa OR s.sets_b IS DISTINCT FROM sb OR s.historial_sets IS DISTINCT FROM NEW.resultado->'historial_sets' OR s.sync_torneo_status IS DISTINCT FROM 'synced');
 RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.sync_linked_scoreboard_final_result() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS sync_linked_scoreboard_final_result ON public.partidos;
CREATE TRIGGER sync_linked_scoreboard_final_result AFTER UPDATE OF estado,resultado,ganador_equipo_id ON public.partidos FOR EACH ROW EXECUTE FUNCTION public.sync_linked_scoreboard_final_result();
COMMIT;
