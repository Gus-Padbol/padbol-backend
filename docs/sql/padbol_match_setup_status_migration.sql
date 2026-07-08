-- Padbol Match Setup — estado de configuración inicial por sede
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
--
-- Trackea progreso del checklist de alta guiada (PadCoins, beneficios, campañas).
-- Los flags se sincronizan desde validate; markSetupStep permite ajustes manuales Super Admin.

CREATE TABLE IF NOT EXISTS padbol_match_setup_status (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id INTEGER NOT NULL REFERENCES sedes (id) ON DELETE CASCADE,
  admin_sede_configurado BOOLEAN NOT NULL DEFAULT FALSE,
  padcoins_activado BOOLEAN NOT NULL DEFAULT FALSE,
  padcoins_default_5_configurado BOOLEAN NOT NULL DEFAULT FALSE,
  beneficios_iniciales_configurados BOOLEAN NOT NULL DEFAULT FALSE,
  campanas_habilitadas BOOLEAN NOT NULL DEFAULT FALSE,
  reserva_visible_para_jugador BOOLEAN NOT NULL DEFAULT FALSE,
  checklist_completo BOOLEAN NOT NULL DEFAULT FALSE,
  last_checked_at TIMESTAMPTZ,
  notes TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT padbol_match_setup_status_sede_id_unique UNIQUE (sede_id)
);

COMMENT ON TABLE padbol_match_setup_status IS
  'Checklist Padbol Match Setup por sede (alta guiada PadCoins, beneficios, campañas).';
COMMENT ON COLUMN padbol_match_setup_status.campanas_habilitadas IS
  'Sede habilitada para operar campañas PadCoins (requiere PadCoins activo).';
COMMENT ON COLUMN padbol_match_setup_status.padcoins_default_5_configurado IS
  'Fidelización recomendada 5% aplicada o heredada sin override distinto.';
COMMENT ON COLUMN padbol_match_setup_status.last_checked_at IS
  'Última ejecución de validateSetupForSede.';

CREATE INDEX IF NOT EXISTS idx_padbol_match_setup_status_sede_id
  ON padbol_match_setup_status (sede_id);

CREATE INDEX IF NOT EXISTS idx_padbol_match_setup_status_checklist_completo
  ON padbol_match_setup_status (checklist_completo)
  WHERE checklist_completo = TRUE;
