-- Resultado de partidos abiertos (score + ganador)
-- Ejecutar en Supabase SQL Editor antes del deploy del backend.

ALTER TABLE partidos_abiertos
  ADD COLUMN IF NOT EXISTS resultado JSONB,
  ADD COLUMN IF NOT EXISTS ganador TEXT;

COMMENT ON COLUMN partidos_abiertos.resultado IS 'JSON: { equipo1_sets, equipo2_sets, sets_detalle: [{eq1, eq2}] }';
COMMENT ON COLUMN partidos_abiertos.ganador IS 'equipo1 | equipo2';
