-- Run in Supabase SQL editor if telefono/lateralidad columns are missing on jugadores_perfil.

ALTER TABLE jugadores_perfil
  ADD COLUMN IF NOT EXISTS telefono TEXT,
  ADD COLUMN IF NOT EXISTS lateralidad TEXT,
  ADD COLUMN IF NOT EXISTS ciudad TEXT,
  ADD COLUMN IF NOT EXISTS username TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_jugadores_perfil_username_lower
  ON jugadores_perfil (LOWER(username))
  WHERE username IS NOT NULL AND username <> '';
