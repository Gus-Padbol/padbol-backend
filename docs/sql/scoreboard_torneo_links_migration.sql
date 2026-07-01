-- Fase 1: vínculo scoreboard ↔ partidos de torneo (Padbol Match)
-- Ejecutar manualmente en Supabase SQL Editor.
-- No modifica datos existentes; columnas nullable; compatible con marcador manual actual.

-- scoreboard_partidos: enlace opcional a partidos de torneo + token de control (hash)
ALTER TABLE scoreboard_partidos
  ADD COLUMN IF NOT EXISTS partido_torneo_id BIGINT REFERENCES partidos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS control_token_hash TEXT,
  ADD COLUMN IF NOT EXISTS control_token_created_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS control_token_revoked_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS synced_to_torneo_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS sync_torneo_status TEXT;

-- partidos: cancha operativa y ganador persistido (post-sync futuro)
ALTER TABLE partidos
  ADD COLUMN IF NOT EXISTS cancha TEXT,
  ADD COLUMN IF NOT EXISTS ganador_equipo_id BIGINT REFERENCES equipos(id);

CREATE INDEX IF NOT EXISTS idx_scoreboard_partidos_partido_torneo_id
  ON scoreboard_partidos (partido_torneo_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_scoreboard_partidos_partido_torneo_activo
  ON scoreboard_partidos (partido_torneo_id)
  WHERE partido_torneo_id IS NOT NULL
    AND estado NOT IN ('terminado', 'finalizado');

CREATE INDEX IF NOT EXISTS idx_scoreboard_partidos_sede_cancha_estado
  ON scoreboard_partidos (sede_id, cancha, estado, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_partidos_torneo_cancha_fecha
  ON partidos (torneo_id, cancha, fecha_hora);

COMMENT ON COLUMN scoreboard_partidos.partido_torneo_id IS
  'Partido de torneo (partidos.id) vinculado al marcador; nullable para marcadores manuales/casuales.';

COMMENT ON COLUMN scoreboard_partidos.control_token_hash IS
  'Hash del token de control del árbitro (nunca almacenar el token en claro).';

COMMENT ON COLUMN scoreboard_partidos.sync_torneo_status IS
  'Estado de sync hacia partidos de torneo: pending | synced | failed | skipped (futuro).';

COMMENT ON COLUMN partidos.cancha IS
  'Cancha asignada al partido de torneo (para live fijo por cancha).';

COMMENT ON COLUMN partidos.ganador_equipo_id IS
  'Equipo ganador del partido de torneo (equipos.id); nullable hasta finalizar.';
