-- Run in Supabase SQL Editor (jugadores_perfil).
-- Optional dedicated columns; perfil-publico also maps legacy lateralidad → mano_preferida.

ALTER TABLE jugadores_perfil
  ADD COLUMN IF NOT EXISTS mano_preferida TEXT;

ALTER TABLE jugadores_perfil
  ADD COLUMN IF NOT EXISTS posicion_cancha TEXT;

COMMENT ON COLUMN jugadores_perfil.mano_preferida IS 'Diestro, Zurdo o Ambas';
COMMENT ON COLUMN jugadores_perfil.posicion_cancha IS 'Derecha, Izquierda o Ambas (lado preferido en cancha)';
