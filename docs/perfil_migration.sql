-- Run in Supabase SQL editor if telefono/lateralidad columns are missing on jugadores_perfil.

ALTER TABLE jugadores_perfil
  ADD COLUMN IF NOT EXISTS telefono TEXT,
  ADD COLUMN IF NOT EXISTS lateralidad TEXT;
