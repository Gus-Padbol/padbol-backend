-- PadCoins — niveles de fidelización (Starter → Legend)
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
--
-- Opcional: el backend usa defaults en código si estas filas no existen.
-- Los umbrales se editan solo por Super Admin vía API.

INSERT INTO padcoins_global_config (key, value_integer, value_text, descripcion, activo)
VALUES
  ('nivel_fidelizacion_starter_umbral', 0, NULL, 'Umbral mínimo de PadCoins históricos para nivel Starter', TRUE),
  ('nivel_fidelizacion_bronze_umbral', 500, NULL, 'Umbral mínimo de PadCoins históricos para nivel Bronze', TRUE),
  ('nivel_fidelizacion_silver_umbral', 2000, NULL, 'Umbral mínimo de PadCoins históricos para nivel Silver', TRUE),
  ('nivel_fidelizacion_gold_umbral', 5000, NULL, 'Umbral mínimo de PadCoins históricos para nivel Gold', TRUE),
  ('nivel_fidelizacion_platinum_umbral', 12000, NULL, 'Umbral mínimo de PadCoins históricos para nivel Platinum', TRUE),
  ('nivel_fidelizacion_diamond_umbral', 25000, NULL, 'Umbral mínimo de PadCoins históricos para nivel Diamond', TRUE),
  ('nivel_fidelizacion_elite_umbral', 50000, NULL, 'Umbral mínimo de PadCoins históricos para nivel Elite', TRUE),
  ('nivel_fidelizacion_legend_umbral', 100000, NULL, 'Umbral mínimo de PadCoins históricos para nivel Legend', TRUE)
ON CONFLICT (key) DO NOTHING;
