-- Run in Supabase SQL editor before enabling QR check-in in production.

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS checkin_realizado BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS checkin_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_reservas_checkin
  ON reservas (checkin_realizado, fecha)
  WHERE checkin_realizado = false;
