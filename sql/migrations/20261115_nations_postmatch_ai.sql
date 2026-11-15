-- Private, reviewable queue for Nations post-match summaries.
-- No partido_resumenes FK, no partidos_abiertos namespace, no global roles.
CREATE SCHEMA IF NOT EXISTS nations_postmatch_ai;
REVOKE ALL ON SCHEMA nations_postmatch_ai FROM PUBLIC;

CREATE TABLE IF NOT EXISTS nations_postmatch_ai.jobs (
  scoreboard_id text PRIMARY KEY,
  partido_torneo_id bigint NOT NULL,
  torneo_id bigint NOT NULL,
  status text NOT NULL DEFAULT 'queued'
    CHECK (status IN ('queued','generating','provider_started','ready','insufficient','uncertain','failed')),
  attempts integer NOT NULL DEFAULT 0,
  lease_token uuid,
  lease_until timestamptz,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  provider_started_at timestamptz,
  payload_hash text,
  observed jsonb,
  summary jsonb,
  provider text,
  model text,
  error_code text,
  error_message text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS nations_postmatch_ai_jobs_ready_idx
  ON nations_postmatch_ai.jobs (status, next_attempt_at);
CREATE INDEX IF NOT EXISTS nations_postmatch_ai_jobs_partido_idx
  ON nations_postmatch_ai.jobs (partido_torneo_id);

REVOKE ALL ON nations_postmatch_ai.jobs FROM PUBLIC;
COMMENT ON TABLE nations_postmatch_ai.jobs IS
  'Durable Nations post-match AI jobs. scoreboard_id is the board scope; no casual partido FK.';

ALTER TABLE nations_postmatch_ai.jobs ENABLE ROW LEVEL SECURITY;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA nations_postmatch_ai FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON TABLE nations_postmatch_ai.jobs FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
