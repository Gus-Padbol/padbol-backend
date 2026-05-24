-- Reference schema for clases feature (actual production tables may already exist).
-- Run only missing pieces in Supabase SQL editor.

-- clases (existing)
-- id BIGINT, sede_id, profesor_id, cancha_id, deporte, titulo, descripcion,
-- tipo, cupo_maximo, duracion_minutos, precio, activo, created_at, horas_cancelacion

-- Optional schedule table (used by API when present):
-- CREATE TABLE IF NOT EXISTS clases_horarios (
--   id BIGSERIAL PRIMARY KEY,
--   clase_id BIGINT REFERENCES clases(id) ON DELETE CASCADE,
--   fecha DATE NOT NULL,
--   hora TIME NOT NULL,
--   activo BOOLEAN DEFAULT TRUE,
--   created_at TIMESTAMPTZ DEFAULT NOW()
-- );

CREATE TABLE IF NOT EXISTS clases_reservas (
  id BIGSERIAL PRIMARY KEY,
  clase_id BIGINT REFERENCES clases(id) ON DELETE CASCADE,
  user_id UUID,
  email TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (clase_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_clases_reservas_clase_id ON clases_reservas (clase_id);
