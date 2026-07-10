-- Ranking casual Fase 2 — estadísticas persistentes en leaderboard (NO ejecutado).
-- Idempotente: ADD COLUMN IF NOT EXISTS. No modifica columnas existentes.

ALTER TABLE rankings_leaderboard
  ADD COLUMN IF NOT EXISTS partidos_jugados INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS ganados INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS perdidos INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS empatados INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS racha_actual INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS mejor_racha INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN rankings_leaderboard.partidos_jugados IS 'Partidos casuales validados contabilizados (Fase 2+)';
COMMENT ON COLUMN rankings_leaderboard.ganados IS 'Victorias en partidos casuales (Fase 2+)';
COMMENT ON COLUMN rankings_leaderboard.perdidos IS 'Derrotas en partidos casuales (Fase 2+)';
COMMENT ON COLUMN rankings_leaderboard.empatados IS 'Empates en partidos casuales (Fase 2+)';
COMMENT ON COLUMN rankings_leaderboard.racha_actual IS 'Racha de victorias casual actual (Fase 2+)';
COMMENT ON COLUMN rankings_leaderboard.mejor_racha IS 'Mejor racha de victorias casual histórica (Fase 2+)';

-- porcentaje_victorias: calculado en API (ganados / partidos_jugados * 100), no se persiste.
