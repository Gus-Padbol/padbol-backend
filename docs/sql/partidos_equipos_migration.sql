-- Asignación persistida de equipos en partidos abiertos (Padbol Match)
-- Ejecutar en Supabase SQL Editor

ALTER TABLE partidos_abiertos
  ADD COLUMN IF NOT EXISTS equipos_asignacion JSONB DEFAULT NULL;

COMMENT ON COLUMN partidos_abiertos.equipos_asignacion IS
  'Equipos definidos por capitán o sorteo: { modo, equipo1, equipo2, definido_por, definido_at, bloqueado }';
