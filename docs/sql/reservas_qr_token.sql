-- Token QR de check-in por reserva (POST /api/reservas/:id/generar-qr).
ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS qr_token TEXT;

CREATE INDEX IF NOT EXISTS idx_reservas_qr_token
  ON reservas (qr_token)
  WHERE qr_token IS NOT NULL;

COMMENT ON COLUMN reservas.qr_token IS 'Token único para QR de check-in generado tras confirmar la reserva';
