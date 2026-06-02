-- Columnas slug/desbloqueado_en para logros_jugador (GET /api/arena/logros)

ALTER TABLE logros_jugador
  ADD COLUMN IF NOT EXISTS slug TEXT,
  ADD COLUMN IF NOT EXISTS desbloqueado_en TIMESTAMPTZ;

CREATE UNIQUE INDEX IF NOT EXISTS idx_logros_jugador_user_slug
  ON logros_jugador (user_id, slug)
  WHERE slug IS NOT NULL;
