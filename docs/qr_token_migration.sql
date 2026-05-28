-- QR check-in token for player reservations (scan URL: /checkin/validar/:qr_token)

ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS qr_token TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservas_qr_token
  ON reservas (qr_token)
  WHERE qr_token IS NOT NULL;
