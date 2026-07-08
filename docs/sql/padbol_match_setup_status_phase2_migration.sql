-- Padbol Match Setup — Fase 2 (operativo completo)
--
-- Ejecutar manualmente en Supabase SQL Editor después de padbol_match_setup_status_migration.sql.
-- Idempotente: ADD COLUMN IF NOT EXISTS.

ALTER TABLE padbol_match_setup_status
  ADD COLUMN IF NOT EXISTS sede_datos_basicos_configurados BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE padbol_match_setup_status
  ADD COLUMN IF NOT EXISTS canchas_configuradas BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE padbol_match_setup_status
  ADD COLUMN IF NOT EXISTS horarios_configurados BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE padbol_match_setup_status
  ADD COLUMN IF NOT EXISTS precios_configurados BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE padbol_match_setup_status
  ADD COLUMN IF NOT EXISTS reservas_habilitadas BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE padbol_match_setup_status
  ADD COLUMN IF NOT EXISTS pagos_configurados BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE padbol_match_setup_status
  ADD COLUMN IF NOT EXISTS reglas_operativas_configuradas BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE padbol_match_setup_status
  ADD COLUMN IF NOT EXISTS readiness_level TEXT NOT NULL DEFAULT 'incomplete';

COMMENT ON COLUMN padbol_match_setup_status.readiness_level IS
  'Nivel de preparación: incomplete | basic | operational | ready';

COMMENT ON COLUMN padbol_match_setup_status.reglas_operativas_configuradas IS
  'Reglas operativas mínimas (global PadCoins/reputación); config por sede pendiente futuro.';

CREATE INDEX IF NOT EXISTS idx_padbol_match_setup_status_readiness_level
  ON padbol_match_setup_status (readiness_level);
