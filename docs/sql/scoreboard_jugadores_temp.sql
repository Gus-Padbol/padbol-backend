-- Jugadores temporales registrados por QR en scoreboard
CREATE TABLE IF NOT EXISTS public.scoreboard_jugadores_temp (
  id BIGSERIAL PRIMARY KEY,
  partido_id UUID NOT NULL REFERENCES public.scoreboard_partidos(id) ON DELETE CASCADE,
  equipo TEXT NOT NULL CHECK (equipo IN ('a', 'b')),
  slot INTEGER NOT NULL CHECK (slot >= 1 AND slot <= 4),
  nombre TEXT NOT NULL,
  numero INTEGER,
  foto_url TEXT,
  user_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (partido_id, equipo, slot)
);

CREATE INDEX IF NOT EXISTS idx_scoreboard_jugadores_temp_partido
  ON public.scoreboard_jugadores_temp (partido_id);

COMMENT ON TABLE public.scoreboard_jugadores_temp IS 'Registro QR temporal de jugadores por partido, equipo y slot';
