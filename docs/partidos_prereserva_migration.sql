-- Conditional reservation flow for open matches (prereserva → confirm on full roster).

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS pago_estado TEXT DEFAULT 'pendiente';

ALTER TABLE partidos_abiertos
  ADD COLUMN IF NOT EXISTS reserva_id BIGINT REFERENCES reservas(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS sede_nombre TEXT,
  ADD COLUMN IF NOT EXISTS capitan_nombre TEXT,
  ADD COLUMN IF NOT EXISTS capitan_foto_url TEXT,
  ADD COLUMN IF NOT EXISTS jugadores_confirmados INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS jugadores_requeridos INTEGER DEFAULT 4,
  ADD COLUMN IF NOT EXISTS deadline_cancel TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pago_url TEXT;

-- Legacy aliases (optional — omit if production already uses confirmados/requeridos only)
ALTER TABLE partidos_abiertos
  ADD COLUMN IF NOT EXISTS jugadores_actuales INTEGER DEFAULT 1,
  ADD COLUMN IF NOT EXISTS jugadores_necesarios INTEGER DEFAULT 4;

CREATE INDEX IF NOT EXISTS idx_partidos_abiertos_deadline
  ON partidos_abiertos (estado, deadline_cancel);

CREATE INDEX IF NOT EXISTS idx_reservas_court_slot
  ON reservas (sede, fecha, hora, cancha, estado);

COMMENT ON COLUMN reservas.pago_estado IS 'pendiente | pendiente_cobro | pagado | cancelado | no_aplica';
COMMENT ON COLUMN partidos_abiertos.deadline_cancel IS 'Auto-cancel if roster incomplete (match time minus 8h)';
