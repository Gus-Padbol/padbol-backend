-- PadCoins — overrides opcionales de reglas por sede (herencia sobre padcoins_global_config)
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
--
-- Formato rule_overrides (JSONB):
--   { "limite_diario_jugador": 500, "logro_desbloqueado": 600 }
--   { "modo_calculo_reserva": "porcentaje_valor_pagado" }
-- Solo keys permitidas en padcoins_global_config; el backend valida al leer/escribir.

ALTER TABLE padcoins_sede_config
  ADD COLUMN IF NOT EXISTS rule_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

COMMENT ON COLUMN padcoins_sede_config.rule_overrides IS
  'Overrides opcionales por sede. Keys = padcoins_global_config.key. Vacío = hereda todo global.';

CREATE INDEX IF NOT EXISTS idx_padcoins_sede_config_rule_overrides
  ON padcoins_sede_config USING gin (rule_overrides);
