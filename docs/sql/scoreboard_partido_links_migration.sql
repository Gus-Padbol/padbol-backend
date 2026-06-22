-- Etapa 1: vínculo scoreboard ↔ partidos_abiertos / reservas (Padbol Match)
-- Ejecutar en Supabase SQL Editor

ALTER TABLE scoreboard_partidos
  ADD COLUMN IF NOT EXISTS partido_abierto_id BIGINT REFERENCES partidos_abiertos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS reserva_id BIGINT REFERENCES reservas(id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_scoreboard_partidos_partido_abierto_id
  ON scoreboard_partidos (partido_abierto_id);

CREATE INDEX IF NOT EXISTS idx_scoreboard_partidos_reserva_id
  ON scoreboard_partidos (reserva_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scoreboard_partidos_partido_abierto_activo
  ON scoreboard_partidos (partido_abierto_id)
  WHERE partido_abierto_id IS NOT NULL
    AND estado NOT IN ('terminado', 'finalizado');

COMMENT ON COLUMN scoreboard_partidos.partido_abierto_id IS
  'Partido casual Padbol Match vinculado al marcador (partidos_abiertos.id)';

COMMENT ON COLUMN scoreboard_partidos.reserva_id IS
  'Reserva Padbol Match vinculada al marcador (reservas.id)';
