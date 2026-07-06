-- PadCoins — configuración global (Super Admin)
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
--
-- Reglas globales de cómo se ganan o pierden PadCoins.
-- Los premios/canables por sede siguen en premios_canjeables (separado).

CREATE TABLE IF NOT EXISTS padcoins_global_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  key TEXT NOT NULL,
  value_integer INTEGER,
  value_text TEXT,
  descripcion TEXT,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID,
  CONSTRAINT padcoins_global_config_key_unique UNIQUE (key),
  CONSTRAINT padcoins_global_config_key_nonempty CHECK (char_length(trim(key)) > 0)
);

COMMENT ON TABLE padcoins_global_config IS
  'Reglas globales PadCoins definidas por Super Admin. No expuesto al jugador.';
COMMENT ON COLUMN padcoins_global_config.key IS
  'Identificador de regla (ej. partido_jugado, logro_desbloqueado).';
COMMENT ON COLUMN padcoins_global_config.value_integer IS
  'Valor numérico de la regla (PadCoins o límite).';
COMMENT ON COLUMN padcoins_global_config.value_text IS
  'Valor textual opcional para reglas futuras.';
COMMENT ON COLUMN padcoins_global_config.activo IS
  'Si false, el backend usa fallback en código.';

CREATE INDEX IF NOT EXISTS idx_padcoins_global_config_key
  ON padcoins_global_config (key);

-- Valores iniciales (idempotente)
INSERT INTO padcoins_global_config (key, value_integer, value_text, descripcion, activo)
VALUES
  ('partido_jugado', 50, NULL, 'Bonus/fallback fijo por partido jugado (futuro; no reemplaza cálculo proporcional en reservas pagas)', TRUE),
  ('partido_ganado', 20, NULL, 'PadCoins extra por partido ganado', TRUE),
  ('logro_desbloqueado', 500, NULL, 'PadCoins por logro desbloqueado', TRUE),
  ('inscripcion_torneo', 100, NULL, 'PadCoins por inscripción a torneo', TRUE),
  ('reserva_confirmada', 30, NULL, 'Fallback fijo si no hay valor pagado o moneda sin conversión a USD equivalente', TRUE),
  ('cancelacion_tarde', -100, NULL, 'Penalización por cancelación tardía', TRUE),
  ('no_show', -300, NULL, 'Penalización por no presentarse', TRUE),
  ('limite_diario_jugador', 1000, NULL, 'Tope diario de PadCoins ganados por jugador', TRUE),
  ('limite_mensual_jugador', 10000, NULL, 'Tope mensual de PadCoins ganados por jugador', TRUE),
  ('porcentaje_devolucion_reserva', 5, NULL, 'Porcentaje global de devolución PadCoins sobre valor pagado (ej. 5 = 5%)', TRUE),
  ('padcoins_por_usd_equivalente', 100, NULL, 'Equivalencia promocional interna: PadCoins por 1 USD equivalente (no mostrar al jugador)', TRUE),
  ('modo_calculo_reserva', NULL, 'porcentaje_valor_pagado', 'Modo de acreditación por reserva: porcentaje_valor_pagado | futuros modos', TRUE)
ON CONFLICT (key) DO NOTHING;
