-- Compañero habitual (registered partner) on jugadores_perfil.
ALTER TABLE jugadores_perfil
  ADD COLUMN IF NOT EXISTS companero_habitual_id UUID;

COMMENT ON COLUMN jugadores_perfil.companero_habitual_id IS 'user_id of habitual doubles/tournament partner';
