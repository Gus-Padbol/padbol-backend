-- Premios configurables por sede para ligas ARENA (INIT, BRONZE, SILVER, etc.)

CREATE TABLE IF NOT EXISTS ligas_premios (
  id BIGSERIAL PRIMARY KEY,
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  liga TEXT NOT NULL,
  descripcion_premio TEXT NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  fecha_vencimiento TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sede_id, liga)
);

CREATE INDEX IF NOT EXISTS idx_ligas_premios_sede_activo
  ON ligas_premios (sede_id, activo);

COMMENT ON TABLE ligas_premios IS 'Premio ofrecido por la sede al alcanzar una liga ARENA';
