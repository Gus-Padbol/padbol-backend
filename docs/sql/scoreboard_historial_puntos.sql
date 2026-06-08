-- Historial de puntos del scoreboard (undo múltiple)
CREATE TABLE IF NOT EXISTS public.scoreboard_historial_puntos (
  id BIGSERIAL PRIMARY KEY,
  partido_id UUID NOT NULL REFERENCES public.scoreboard_partidos(id) ON DELETE CASCADE,
  equipo TEXT NOT NULL,
  score_a_antes INTEGER NOT NULL DEFAULT 0,
  score_b_antes INTEGER NOT NULL DEFAULT 0,
  set_numero INTEGER NOT NULL DEFAULT 1,
  games_a_antes INTEGER NOT NULL DEFAULT 0,
  games_b_antes INTEGER NOT NULL DEFAULT 0,
  sets_a_antes INTEGER NOT NULL DEFAULT 0,
  sets_b_antes INTEGER NOT NULL DEFAULT 0,
  es_tiebreak_antes BOOLEAN NOT NULL DEFAULT false,
  estado_antes TEXT,
  historial_sets_antes JSONB NOT NULL DEFAULT '[]',
  saque_actual_antes TEXT,
  timestamp TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scoreboard_historial_puntos_partido_ts
  ON public.scoreboard_historial_puntos (partido_id, timestamp DESC);

COMMENT ON TABLE public.scoreboard_historial_puntos IS 'Snapshot antes de cada punto para deshacer múltiple en scoreboard';
