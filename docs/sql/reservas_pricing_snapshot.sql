-- Precio calculado en servidor para checkout MP (Paso 2 seguridad pagos).
ALTER TABLE reservas
  ADD COLUMN IF NOT EXISTS precio_esperado INTEGER,
  ADD COLUMN IF NOT EXISTS pricing_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS moneda TEXT DEFAULT 'ARS';

COMMENT ON COLUMN reservas.precio_esperado IS 'Total esperado calculado en backend al crear checkout MP';
COMMENT ON COLUMN reservas.pricing_snapshot IS 'Desglose JSON del quote server-side (base, surge, extras, fee)';
COMMENT ON COLUMN reservas.moneda IS 'Moneda del precio esperado (ej. ARS)';
