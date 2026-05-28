-- Leaderboard points by sport and scope (club / nacional / fipa).
CREATE TABLE IF NOT EXISTS rankings_leaderboard (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL,
  deporte TEXT NOT NULL,
  nivel TEXT NOT NULL CHECK (nivel IN ('club', 'nacional', 'fipa')),
  puntos INTEGER NOT NULL DEFAULT 0 CHECK (puntos >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, deporte, nivel)
);

CREATE INDEX IF NOT EXISTS idx_rankings_leaderboard_lookup
  ON rankings_leaderboard (deporte, nivel, puntos DESC);

COMMENT ON TABLE rankings_leaderboard IS 'Points leaderboard per player, sport and nivel for GET /api/rankings/:deporte';
