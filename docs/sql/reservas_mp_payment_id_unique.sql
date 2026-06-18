-- Paso 3: evitar reutilizar el mismo pago MP en más de una reserva.
-- Ejecutar después de docs/sql/reservas_mp_payment_id.sql (columna mp_payment_id).
-- Fallará si ya hay mp_payment_id duplicados en la tabla; limpiar duplicados antes.

CREATE UNIQUE INDEX IF NOT EXISTS idx_reservas_mp_payment_id_unique
  ON reservas (mp_payment_id)
  WHERE mp_payment_id IS NOT NULL;
