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
INSERT INTO padcoins_global_config (key, value_integer, descripcion, activo)
VALUES
  ('partido_jugado', 50, 'PadCoins por partido jugado', TRUE),
  ('partido_ganado', 20, 'PadCoins extra por partido ganado', TRUE),
  ('logro_desbloqueado', 500, 'PadCoins por logro desbloqueado', TRUE),
  ('inscripcion_torneo', 100, 'PadCoins por inscripción a torneo', TRUE),
  ('reserva_confirmada', 30, 'PadCoins por reserva confirmada/jugada', TRUE),
  ('cancelacion_tarde', -100, 'Penalización por cancelación tardía', TRUE),
  ('no_show', -300, 'Penalización por no presentarse', TRUE),
  ('limite_diario_jugador', 1000, 'Tope diario de PadCoins ganados por jugador', TRUE),
  ('limite_mensual_jugador', 10000, 'Tope mensual de PadCoins ganados por jugador', TRUE)
ON CONFLICT (key) DO NOTHING;
