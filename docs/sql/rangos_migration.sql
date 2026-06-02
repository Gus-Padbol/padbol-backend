-- Sistema de rangos ARENA

ALTER TABLE jugadores_perfil
  ADD COLUMN IF NOT EXISTS rango TEXT NOT NULL DEFAULT 'rookie';

CREATE TABLE IF NOT EXISTS rangos_historial (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  rango_anterior TEXT NOT NULL,
  rango_nuevo TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rangos_historial_user
  ON rangos_historial (user_id, created_at DESC);

COMMENT ON COLUMN jugadores_perfil.rango IS 'Rango ARENA actual: rookie, pro, gold, star, elite, goat';
