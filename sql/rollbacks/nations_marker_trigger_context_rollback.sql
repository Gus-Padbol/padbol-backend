-- Reinstates original invoker behavior, including its service-role limitation.
BEGIN;
CREATE OR REPLACE FUNCTION nations_marker_private.nations_marker_clock_bump() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nations_marker_private.nations_marker_match WHERE match_id=NEW.id::text) THEN RETURN NEW; END IF;
  IF (OLD.cronometro_inicio IS DISTINCT FROM NEW.cronometro_inicio)
     OR (OLD.cronometro_pausado IS DISTINCT FROM NEW.cronometro_pausado)
     OR (OLD.cronometro_segundos IS DISTINCT FROM NEW.cronometro_segundos)
     OR (OLD.estado IS DISTINCT FROM NEW.estado) THEN
    INSERT INTO nations_marker_private.nations_marker_clock_revision(scoreboard_id,revision,updated_at)
    VALUES (NEW.id::text,1,now())
    ON CONFLICT (scoreboard_id) DO UPDATE SET revision=nations_marker_private.nations_marker_clock_revision.revision+1, updated_at=now();
  END IF;
  RETURN NEW;
END; $$;
CREATE OR REPLACE FUNCTION nations_marker_private.nations_marker_terminal_stamp() RETURNS trigger LANGUAGE plpgsql SECURITY INVOKER AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM nations_marker_private.nations_marker_match WHERE match_id=NEW.id::text) THEN RETURN NEW; END IF;
  IF lower(coalesce(OLD.estado,'')) NOT IN ('terminado','finalizado') AND lower(coalesce(NEW.estado,'')) IN ('terminado','finalizado') THEN
    INSERT INTO nations_marker_private.nations_marker_terminal(match_id,terminal_at)
    VALUES (NEW.id::text, now()) ON CONFLICT (match_id) DO NOTHING;
  ELSIF lower(coalesce(OLD.estado,'')) IN ('terminado','finalizado') AND lower(coalesce(NEW.estado,'')) NOT IN ('terminado','finalizado') THEN
    DELETE FROM nations_marker_private.nations_marker_terminal WHERE match_id=NEW.id::text;
  END IF;
  RETURN NEW;
END; $$;
ALTER FUNCTION nations_marker_private.nations_marker_clock_bump() RESET ALL;
ALTER FUNCTION nations_marker_private.nations_marker_terminal_stamp() RESET ALL;
COMMIT;
