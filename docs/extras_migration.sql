-- Extras / add-ons por sede (bebidas, comidas, merchandising, indumentaria)
-- Ejecutar en Supabase SQL Editor antes del deploy del backend.

CREATE TABLE IF NOT EXISTS extras (
  id BIGSERIAL PRIMARY KEY,
  sede_id BIGINT NOT NULL REFERENCES sedes(id) ON DELETE CASCADE,
  nombre TEXT NOT NULL,
  precio NUMERIC(10, 2) NOT NULL DEFAULT 0,
  moneda TEXT NOT NULL DEFAULT 'ARS',
  categoria TEXT NOT NULL DEFAULT 'otros',
  imagen_url TEXT,
  stock INTEGER,
  activo BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_extras_sede_activo ON extras (sede_id, activo);

COMMENT ON TABLE extras IS 'Productos opcionales por sede (eshop / add-ons en reserva)';
COMMENT ON COLUMN extras.categoria IS 'bebidas | comidas | merchandising | indumentaria | otros';
COMMENT ON COLUMN extras.stock IS 'NULL = stock ilimitado';

-- Ejemplos (opcional — ajustar sede_id)
-- INSERT INTO extras (sede_id, nombre, precio, moneda, categoria, stock) VALUES
-- (1, 'Agua 500ml', 1500, 'ARS', 'bebidas', 100),
-- (1, 'Hamburguesa', 8500, 'ARS', 'comidas', 30),
-- (1, 'Remera Padbol', 25000, 'ARS', 'merchandising', 20);
