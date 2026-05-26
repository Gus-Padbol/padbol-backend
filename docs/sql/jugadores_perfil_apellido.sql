-- Run in Supabase SQL Editor (jugadores_perfil).

ALTER TABLE jugadores_perfil
  ADD COLUMN IF NOT EXISTS apellido TEXT;

ALTER TABLE jugadores_perfil
  ADD COLUMN IF NOT EXISTS lateralidad TEXT;

ALTER TABLE jugadores_perfil
  ADD COLUMN IF NOT EXISTS deportes TEXT[];

COMMENT ON COLUMN jugadores_perfil.apodo IS 'Apodo o nombre corto (casual). Distinto de username.';
