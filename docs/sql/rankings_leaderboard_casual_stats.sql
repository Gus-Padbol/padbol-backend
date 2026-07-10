-- Ranking casual Fase 2 — stats extendidas en leaderboard (NO ejecutado).
-- Fase 1 solo incrementa `puntos` en rankings_leaderboard existente.

ALTER TABLE rankings_leaderboard
  ADD COLUMN IF NOT EXISTS partidos_jugados INTEGER NOT NULL DEFAULT 0 CHECK (partidos_jugados >= 0),
  ADD COLUMN IF NOT EXISTS ganados INTEGER NOT NULL DEFAULT 0 CHECK (ganados >= 0),
  ADD COLUMN IF NOT EXISTS perdidos INTEGER NOT NULL DEFAULT 0 CHECK (perdidos >= 0),
  ADD COLUMN IF NOT EXISTS empatados INTEGER NOT NULL DEFAULT 0 CHECK (empatados >= 0);

COMMENT ON COLUMN rankings_leaderboard.partidos_jugados IS 'Partidos casuales validados contabilizados (Fase 2+)';
COMMENT ON COLUMN rankings_leaderboard.ganados IS 'Victorias en partidos casuales (Fase 2+)';
COMMENT ON COLUMN rankings_leaderboard.perdidos IS 'Derrotas en partidos casuales (Fase 2+)';
COMMENT ON COLUMN rankings_leaderboard.empatados IS 'Empates en partidos casuales (Fase 2+)';
