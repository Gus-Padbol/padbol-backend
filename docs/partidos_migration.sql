-- Open matches use partidos_abiertos (BIGINT id) and partidos_abiertos_jugadores.
-- Tournament matches continue to use the existing partidos table.

CREATE TABLE IF NOT EXISTS partidos_abiertos (
  id BIGSERIAL PRIMARY KEY,
  sede_id INTEGER REFERENCES sedes(id),
  host_user_id UUID,
  host_email TEXT,
  fecha DATE NOT NULL,
  hora TIME NOT NULL,
  nivel TEXT NOT NULL,
  estado TEXT DEFAULT 'abierto',
  max_jugadores INTEGER DEFAULT 4,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS partidos_abiertos_jugadores (
  id BIGSERIAL PRIMARY KEY,
  partido_id BIGINT REFERENCES partidos_abiertos(id) ON DELETE CASCADE,
  user_id UUID,
  email TEXT,
  joined_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (partido_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_partidos_abiertos_list
  ON partidos_abiertos (estado, fecha);

CREATE INDEX IF NOT EXISTS idx_partidos_abiertos_jugadores_partido
  ON partidos_abiertos_jugadores (partido_id);
