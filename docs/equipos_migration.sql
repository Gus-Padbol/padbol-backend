-- Equipos de usuario (independientes de equipos de torneo en tabla `equipos`)
-- Ejecutar en Supabase SQL Editor antes del deploy del backend.

CREATE TABLE IF NOT EXISTS equipos_usuario (
  id BIGSERIAL PRIMARY KEY,
  nombre TEXT NOT NULL,
  deporte TEXT NOT NULL,
  capitan_user_id UUID NOT NULL,
  capitan_email TEXT,
  min_jugadores INTEGER NOT NULL DEFAULT 2,
  max_jugadores INTEGER NOT NULL DEFAULT 4,
  estado TEXT NOT NULL DEFAULT 'formando',
  torneo_id INTEGER REFERENCES torneos(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS equipos_jugadores (
  id BIGSERIAL PRIMARY KEY,
  equipo_id BIGINT NOT NULL REFERENCES equipos_usuario(id) ON DELETE CASCADE,
  user_id UUID,
  email TEXT NOT NULL,
  nombre TEXT,
  rol TEXT NOT NULL DEFAULT 'jugador',
  estado TEXT NOT NULL DEFAULT 'pendiente',
  invited_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  responded_at TIMESTAMPTZ,
  UNIQUE (equipo_id, email)
);

CREATE INDEX IF NOT EXISTS idx_equipos_usuario_capitan ON equipos_usuario (capitan_user_id);
CREATE INDEX IF NOT EXISTS idx_equipos_jugadores_equipo ON equipos_jugadores (equipo_id);
CREATE INDEX IF NOT EXISTS idx_equipos_jugadores_email ON equipos_jugadores (email);
CREATE INDEX IF NOT EXISTS idx_equipos_jugadores_user ON equipos_jugadores (user_id);

COMMENT ON TABLE equipos_usuario IS 'Equipos creados por usuarios para inscripción a torneos';
COMMENT ON TABLE equipos_jugadores IS 'Miembros e invitaciones de equipos_usuario';
COMMENT ON COLUMN equipos_jugadores.estado IS 'pendiente | aceptado | rechazado';
