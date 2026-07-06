-- PadCoins — participación por sede (Beneficios Padbol)
--
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
--
-- Cada sede opta por participar. Default: activo = false (no obligatorio).
-- Premios/canables siguen en premios_canjeables; esta tabla solo habilita el programa.

CREATE TABLE IF NOT EXISTS padcoins_sede_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  sede_id INTEGER NOT NULL REFERENCES sedes (id) ON DELETE CASCADE,
  activo BOOLEAN NOT NULL DEFAULT FALSE,
  descripcion TEXT,
  fecha_inicio TIMESTAMPTZ,
  fecha_fin TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID,
  CONSTRAINT padcoins_sede_config_sede_id_unique UNIQUE (sede_id)
);

COMMENT ON TABLE padcoins_sede_config IS
  'Participación opt-in de cada sede en Beneficios Padbol / PadCoins.';
COMMENT ON COLUMN padcoins_sede_config.activo IS
  'Flag principal; false = la sede no otorga ni canjea PadCoins (salvo canjes pendientes ya creados).';
COMMENT ON COLUMN padcoins_sede_config.fecha_inicio IS
  'Opcional: activación programada; antes de esta fecha no participa.';
COMMENT ON COLUMN padcoins_sede_config.fecha_fin IS
  'Opcional: fin de participación; después de esta fecha no participa (canjes pendientes se respetan).';

CREATE INDEX IF NOT EXISTS idx_padcoins_sede_config_sede_id
  ON padcoins_sede_config (sede_id);

CREATE INDEX IF NOT EXISTS idx_padcoins_sede_config_activo
  ON padcoins_sede_config (activo)
  WHERE activo = TRUE;

-- La Meca (sede_id = 1): entorno de pruebas PadCoins existente.
-- Idempotente: no sobrescribe si ya hay fila.
INSERT INTO padcoins_sede_config (sede_id, activo, descripcion)
VALUES (
  1,
  TRUE,
  'La Meca — sede piloto Beneficios Padbol'
)
ON CONFLICT (sede_id) DO NOTHING;

-- Otras sedes: activar con PUT /api/admin/padcoins-sedes-config/:sedeId (Super Admin)
-- o INSERT manual, por ejemplo:
-- INSERT INTO padcoins_sede_config (sede_id, activo, descripcion)
-- VALUES (2, TRUE, 'Nombre sede')
-- ON CONFLICT (sede_id) DO UPDATE SET activo = EXCLUDED.activo, updated_at = NOW();
