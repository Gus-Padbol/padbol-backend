-- Isolated practice fixture. No FK to public tournaments/matches/scoreboards/users.
CREATE SCHEMA IF NOT EXISTS nations_practice;
REVOKE ALL ON SCHEMA nations_practice FROM PUBLIC;

CREATE TABLE IF NOT EXISTS nations_practice.events (
  id bigint PRIMARY KEY,
  virtual_torneo_id bigint NOT NULL UNIQUE CHECK (virtual_torneo_id >= 1000000000000 AND virtual_torneo_id < 9007199254740991),
  nombre text NOT NULL,
  deporte text NOT NULL DEFAULT 'padbol',
  formato text NOT NULL DEFAULT 'groups_knockout',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nations_practice.teams (
  id bigint PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES nations_practice.events(id) ON DELETE CASCADE,
  nombre text NOT NULL,
  pais text,
  players jsonb NOT NULL DEFAULT '[]'::jsonb
);
CREATE TABLE IF NOT EXISTS nations_practice.matches (
  id bigint PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES nations_practice.events(id) ON DELETE CASCADE,
  equipo_a_id bigint NOT NULL,
  equipo_b_id bigint NOT NULL,
  cancha text NOT NULL,
  cancha_id bigint,
  scoreboard_id uuid NOT NULL UNIQUE,
  phase text NOT NULL DEFAULT 'group',
  estado text NOT NULL DEFAULT 'pendiente',
  revision integer NOT NULL DEFAULT 0,
  state jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS nations_practice.commands (
  match_id bigint NOT NULL REFERENCES nations_practice.matches(id) ON DELETE CASCADE,
  request_id uuid NOT NULL,
  expected_revision integer NOT NULL,
  action text NOT NULL,
  result jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (match_id, request_id)
);
CREATE TABLE IF NOT EXISTS nations_practice.control_tokens (
  id uuid PRIMARY KEY,
  event_id bigint NOT NULL REFERENCES nations_practice.events(id) ON DELETE CASCADE,
  token_hash text NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  scopes text[] NOT NULL DEFAULT ARRAY['control'],
  created_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE nations_practice.events ENABLE ROW LEVEL SECURITY;
ALTER TABLE nations_practice.teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE nations_practice.matches ENABLE ROW LEVEL SECURITY;
ALTER TABLE nations_practice.commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE nations_practice.control_tokens ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA nations_practice FROM PUBLIC;
DO $$
DECLARE role_name text;
BEGIN
  FOREACH role_name IN ARRAY ARRAY['anon','authenticated']
  LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = role_name) THEN
      EXECUTE format('REVOKE ALL ON SCHEMA nations_practice FROM %I', role_name);
      EXECUTE format('REVOKE ALL ON ALL TABLES IN SCHEMA nations_practice FROM %I', role_name);
    END IF;
  END LOOP;
END $$;
