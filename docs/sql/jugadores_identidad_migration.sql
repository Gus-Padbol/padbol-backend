-- Jugador identidad — Fase 1 (Padbol Match)
-- Ejecutar manualmente en Supabase SQL Editor (staging primero).
-- NO ejecutar en producción sin revisión del equipo.
--
-- Separa PII deportiva/KYC de jugadores_perfil (ficha social).
-- El backend usa service role; RLS opcional en fase posterior.

-- ─── 1) jugadores_identidad ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jugadores_identidad (
  user_id UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  fecha_nacimiento DATE,
  tipo_documento TEXT CHECK (
    tipo_documento IS NULL
    OR tipo_documento IN ('dni', 'pasaporte', 'cedula', 'otro')
  ),
  pais_documento TEXT,
  numero_documento_cifrado TEXT,
  numero_documento_hash TEXT,
  nacionalidad TEXT,
  genero TEXT CHECK (
    genero IS NULL
    OR genero IN ('masculino', 'femenino', 'otro', 'prefiero_no_decir')
  ),
  categoria_deportiva TEXT,
  telefono TEXT,
  telefono_verificado_at TIMESTAMPTZ,
  contacto_emergencia_nombre TEXT,
  contacto_emergencia_telefono TEXT,
  contacto_emergencia_relacion TEXT,
  identidad_estado TEXT NOT NULL DEFAULT 'incompleta' CHECK (
    identidad_estado IN ('incompleta', 'pendiente_revision', 'verificada', 'rechazada')
  ),
  identidad_verificada_at TIMESTAMPTZ,
  identidad_verificada_por UUID REFERENCES auth.users(id),
  identidad_notas_admin TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE jugadores_identidad IS
  'Identidad deportiva/KYC del jugador. Separada de jugadores_perfil. Documento nunca público.';
COMMENT ON COLUMN jugadores_identidad.numero_documento_cifrado IS
  'Almacenamiento interno. Con IDENTIDAD_ENCRYPTION_KEY en backend → AES-256-GCM; sin clave → pending_encryption (ver docs).';
COMMENT ON COLUMN jugadores_identidad.numero_documento_hash IS
  'SHA-256 de tipo|pais|numero normalizado. Para deduplicación; no reversible.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_jugadores_identidad_doc_hash_unique
  ON jugadores_identidad (numero_documento_hash)
  WHERE numero_documento_hash IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_jugadores_identidad_estado
  ON jugadores_identidad (identidad_estado);

CREATE INDEX IF NOT EXISTS idx_jugadores_identidad_fecha_nacimiento
  ON jugadores_identidad (fecha_nacimiento)
  WHERE fecha_nacimiento IS NOT NULL;

-- ─── 2) jugadores_aceptaciones ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS jugadores_aceptaciones (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  tipo TEXT NOT NULL,
  version TEXT NOT NULL,
  torneo_id INTEGER REFERENCES torneos(id) ON DELETE SET NULL,
  aceptado_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ip TEXT,
  user_agent TEXT
);

COMMENT ON TABLE jugadores_aceptaciones IS
  'Audit trail de aceptación de términos, privacidad y reglamentos.';

CREATE UNIQUE INDEX IF NOT EXISTS idx_jugadores_aceptaciones_unique
  ON jugadores_aceptaciones (
    user_id,
    tipo,
    version,
    COALESCE(torneo_id, 0)
  );

CREATE INDEX IF NOT EXISTS idx_jugadores_aceptaciones_user_id
  ON jugadores_aceptaciones (user_id, aceptado_at DESC);

-- ─── 3) updated_at trigger (patrón repo) ─────────────────────────────────────

CREATE OR REPLACE FUNCTION set_jugadores_identidad_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_jugadores_identidad_updated_at ON jugadores_identidad;

CREATE TRIGGER trg_jugadores_identidad_updated_at
  BEFORE UPDATE ON jugadores_identidad
  FOR EACH ROW
  EXECUTE FUNCTION set_jugadores_identidad_updated_at();
