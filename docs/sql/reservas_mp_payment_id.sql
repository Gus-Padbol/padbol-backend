-- ID de pago Mercado Pago asociado a la reserva (confirmación vía webhook / pago-exitoso).
ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS mp_payment_id TEXT;

CREATE INDEX IF NOT EXISTS idx_reservas_mp_payment_id
  ON reservas (mp_payment_id)
  WHERE mp_payment_id IS NOT NULL;

COMMENT ON COLUMN reservas.mp_payment_id IS 'ID del pago en Mercado Pago (payment_id) tras checkout aprobado';
