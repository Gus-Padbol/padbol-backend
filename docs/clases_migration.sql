-- Run in Supabase SQL editor before enabling clases feature.

CREATE TABLE IF NOT EXISTS profesores (
  id SERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  bio TEXT,
  foto_url TEXT,
  certificaciones TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clases (
  id SERIAL PRIMARY KEY,
  profesor_id INTEGER REFERENCES profesores(id) ON DELETE SET NULL,
  sede_id INTEGER REFERENCES sedes(id) ON DELETE SET NULL,
  deporte TEXT NOT NULL,
  nivel TEXT NOT NULL,
  fecha DATE NOT NULL,
  hora TIME NOT NULL,
  duracion_minutos INTEGER DEFAULT 60,
  precio INTEGER NOT NULL,
  moneda TEXT DEFAULT 'ARS',
  cupo_max INTEGER DEFAULT 4,
  estado TEXT DEFAULT 'disponible',
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS clases_reservas (
  id SERIAL PRIMARY KEY,
  clase_id INTEGER REFERENCES clases(id) ON DELETE CASCADE,
  user_id UUID,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (clase_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_clases_fecha_estado ON clases (fecha, estado);
CREATE INDEX IF NOT EXISTS idx_clases_reservas_clase_id ON clases_reservas (clase_id);
