-- Premios configurables por sede para logros ARENA

CREATE TABLE IF NOT EXISTS logros_premios (
  id BIGSERIAL PRIMARY KEY,
  sede_id INTEGER NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  logro_slug TEXT NOT NULL,
  descripcion_premio TEXT NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  fecha_vencimiento TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sede_id, logro_slug)
);

CREATE INDEX IF NOT EXISTS idx_logros_premios_sede_activo
  ON logros_premios (sede_id, activo);

COMMENT ON TABLE logros_premios IS 'Premio físico/digital ofrecido por la sede al desbloquear un logro ARENA';
