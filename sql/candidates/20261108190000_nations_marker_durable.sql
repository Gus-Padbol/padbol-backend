-- LOCAL/reviewable migration. Do not apply remotely.
CREATE SCHEMA IF NOT EXISTS nations_marker_private;
REVOKE ALL ON SCHEMA nations_marker_private FROM PUBLIC;
CREATE TABLE IF NOT EXISTS nations_marker_private.nations_marker_match (
  match_id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  states jsonb NOT NULL CHECK (jsonb_typeof(states) = 'object'),
  receipts jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(receipts) = 'object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nations_marker_private.nations_marker_audit (
  id bigserial PRIMARY KEY,
  match_id text NOT NULL REFERENCES nations_marker_private.nations_marker_match(match_id),
  revision bigint NOT NULL,
  kind text NOT NULL,
  actor text NOT NULL,
  payload jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (match_id, revision)
);
CREATE OR REPLACE FUNCTION nations_marker_private.nations_marker_audit_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AUDIT_APPEND_ONLY'; END; $$;
DROP TRIGGER IF EXISTS nations_marker_audit_no_update ON nations_marker_private.nations_marker_audit;
CREATE TRIGGER nations_marker_audit_no_update BEFORE UPDATE OR DELETE ON nations_marker_private.nations_marker_audit
FOR EACH ROW EXECUTE FUNCTION nations_marker_private.nations_marker_audit_immutable();
CREATE OR REPLACE FUNCTION nations_marker_private.nations_marker_audit_no_truncate() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'AUDIT_APPEND_ONLY'; END; $$;
DROP TRIGGER IF EXISTS nations_marker_audit_no_truncate ON nations_marker_private.nations_marker_audit;
CREATE TRIGGER nations_marker_audit_no_truncate BEFORE TRUNCATE ON nations_marker_private.nations_marker_audit
FOR EACH STATEMENT EXECUTE FUNCTION nations_marker_private.nations_marker_audit_no_truncate();

DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN
    REVOKE ALL ON SCHEMA nations_marker_private FROM anon;
    REVOKE ALL ON ALL TABLES IN SCHEMA nations_marker_private FROM anon;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA nations_marker_private FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN
    REVOKE ALL ON SCHEMA nations_marker_private FROM authenticated;
    REVOKE ALL ON ALL TABLES IN SCHEMA nations_marker_private FROM authenticated;
    REVOKE ALL ON ALL SEQUENCES IN SCHEMA nations_marker_private FROM authenticated;
  END IF;
END $$;
CREATE TABLE IF NOT EXISTS nations_marker_private.nations_marker_clock_revision (
  scoreboard_id text PRIMARY KEY,
  revision bigint NOT NULL DEFAULT 0 CHECK (revision >= 0),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION nations_marker_private.nations_marker_clock_bump() RETURNS trigger LANGUAGE plpgsql AS $$
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
CREATE TABLE IF NOT EXISTS nations_marker_private.nations_marker_terminal (
  match_id text PRIMARY KEY,
  terminal_at timestamptz NOT NULL
);
CREATE OR REPLACE FUNCTION nations_marker_private.nations_marker_terminal_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
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
DO $$ BEGIN
  IF to_regclass('public.scoreboard_partidos') IS NOT NULL THEN
    DROP TRIGGER IF EXISTS nations_marker_terminal_stamp ON scoreboard_partidos;
    CREATE TRIGGER nations_marker_terminal_stamp AFTER UPDATE OF estado ON scoreboard_partidos
    FOR EACH ROW EXECUTE FUNCTION nations_marker_private.nations_marker_terminal_stamp();
    DROP TRIGGER IF EXISTS nations_marker_clock_bump ON scoreboard_partidos;
    CREATE TRIGGER nations_marker_clock_bump AFTER UPDATE ON scoreboard_partidos
    FOR EACH ROW EXECUTE FUNCTION nations_marker_private.nations_marker_clock_bump();
  END IF;
END $$;
