-- Scoreboard en tiempo real — Padbol Match
-- Ejecutar en Supabase SQL Editor

-- Partidos de scoreboard
CREATE TABLE IF NOT EXISTS scoreboard_partidos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id INTEGER REFERENCES sedes(id),
  torneo_id INTEGER REFERENCES torneos(id),
  torneo_nombre TEXT,
  cancha TEXT,
  equipo_a_nombre TEXT NOT NULL,
  equipo_b_nombre TEXT NOT NULL,
  equipo_a_jugadores JSONB DEFAULT '[]',
  equipo_b_jugadores JSONB DEFAULT '[]',
  estado TEXT DEFAULT 'pendiente',
  saque_actual TEXT DEFAULT 'A',
  score_a INTEGER DEFAULT 0,
  score_b INTEGER DEFAULT 0,
  games_a INTEGER DEFAULT 0,
  games_b INTEGER DEFAULT 0,
  sets_a INTEGER DEFAULT 0,
  sets_b INTEGER DEFAULT 0,
  historial_sets JSONB DEFAULT '[]',
  es_tiebreak BOOLEAN DEFAULT false,
  ultimo_punto TEXT DEFAULT NULL,
  historial_puntos JSONB DEFAULT '[]',
  cronometro_inicio TIMESTAMPTZ,
  cronometro_pausado BOOLEAN DEFAULT false,
  cronometro_segundos INTEGER DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scoreboard_partidos_sede ON scoreboard_partidos(sede_id);
CREATE INDEX IF NOT EXISTS idx_scoreboard_partidos_estado ON scoreboard_partidos(estado);

-- Sponsors por sede
CREATE TABLE IF NOT EXISTS scoreboard_sponsors (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id INTEGER REFERENCES sedes(id),
  nombre TEXT NOT NULL,
  categoria TEXT,
  logo_url TEXT,
  orden INTEGER DEFAULT 0,
  activo BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_scoreboard_sponsors_sede ON scoreboard_sponsors(sede_id);
