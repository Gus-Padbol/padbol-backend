-- Run in Supabase SQL editor before enabling open matches (partidos abiertos).

CREATE TABLE IF NOT EXISTS partidos (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id INTEGER REFERENCES sedes(id),
  host_user_id UUID,
  host_email TEXT,
  fecha DATE NOT NULL,
  hora TIME NOT NULL,
  nivel TEXT NOT NULL,
  tipo TEXT DEFAULT 'abierto',
  estado TEXT DEFAULT 'abierto',
  max_jugadores INTEGER DEFAULT 4,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partidos_jugadores (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  partido_id UUID REFERENCES partidos(id) ON DELETE CASCADE,
  user_id UUID,
  email TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (partido_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_partidos_abiertos
  ON partidos (tipo, estado, fecha)
  WHERE tipo = 'abierto';

CREATE INDEX IF NOT EXISTS idx_partidos_jugadores_partido
  ON partidos_jugadores (partido_id);
