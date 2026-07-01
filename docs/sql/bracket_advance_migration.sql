-- RFC: avance automático de llave (Padbol Match) — Etapa 1
-- Ejecutar manualmente en Supabase SQL Editor.
-- Solo ADD nullable; no backfill; no modifica filas existentes.

ALTER TABLE partidos
  ADD COLUMN IF NOT EXISTS partido_siguiente_id BIGINT
    REFERENCES partidos(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS partido_siguiente_slot TEXT,
  ADD COLUMN IF NOT EXISTS bracket_position INT,
  ADD COLUMN IF NOT EXISTS bracket_round INT;

-- Slot obligatorio cuando hay destino
ALTER TABLE partidos
  ADD CONSTRAINT partidos_siguiente_slot_check
  CHECK (
    partido_siguiente_id IS NULL
    OR partido_siguiente_slot IN ('A', 'B')
  );

-- No auto-referencia
ALTER TABLE partidos
  ADD CONSTRAINT partidos_siguiente_no_self_check
  CHECK (
    partido_siguiente_id IS NULL
    OR partido_siguiente_id <> id
  );

CREATE INDEX IF NOT EXISTS idx_partidos_siguiente_id
  ON partidos (partido_siguiente_id)
  WHERE partido_siguiente_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_partidos_torneo_bracket
  ON partidos (torneo_id, bracket_round, bracket_position);

COMMENT ON COLUMN partidos.partido_siguiente_id IS
  'Partido destino al que avanza el ganador; NULL = legacy o última ronda.';

COMMENT ON COLUMN partidos.partido_siguiente_slot IS
  'Slot destino: A → equipo_a_id, B → equipo_b_id.';

COMMENT ON COLUMN partidos.bracket_position IS
  'Orden dentro de la ronda (1..N) para UI de llave.';

COMMENT ON COLUMN partidos.bracket_round IS
  'Profundidad numérica de la llave: 1 = primera ronda eliminatoria, mayor = más cerca de la final.';
