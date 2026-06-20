-- Match Summary IA v1 — persistencia de resúmenes por partido
-- Ejecutar en Supabase SQL Editor

CREATE TABLE IF NOT EXISTS partido_resumenes (
  id BIGSERIAL PRIMARY KEY,
  partido_id BIGINT NOT NULL REFERENCES partidos_abiertos(id) ON DELETE CASCADE,
  source_type TEXT NOT NULL DEFAULT 'partidos_abiertos',
  version TEXT NOT NULL,
  prompt_version TEXT,
  payload_hash TEXT NOT NULL,
  payload JSONB NOT NULL,
  response JSONB,
  status TEXT NOT NULL DEFAULT 'pending',
  error_code TEXT,
  error_message TEXT,
  generated_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT partido_resumenes_status_check
    CHECK (status IN ('pending', 'generated', 'failed', 'skipped')),
  CONSTRAINT partido_resumenes_unique_hash
    UNIQUE (partido_id, source_type, payload_hash)
);

CREATE INDEX IF NOT EXISTS idx_partido_resumenes_partido_source
  ON partido_resumenes (partido_id, source_type);

CREATE INDEX IF NOT EXISTS idx_partido_resumenes_status
  ON partido_resumenes (status);

COMMENT ON TABLE partido_resumenes IS
  'Cache y auditoría de Match Summary IA por partido (payload determinístico + respuesta IA).';

COMMENT ON COLUMN partido_resumenes.payload_hash IS
  'Hash estable del MatchSummaryPayload (ej. sha256 del JSON canónico).';

COMMENT ON COLUMN partido_resumenes.status IS
  'pending | generated | failed | skipped';
