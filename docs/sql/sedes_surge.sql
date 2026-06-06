-- Padbol Surge — precios dinámicos opcionales por sede (off por defecto).
ALTER TABLE sedes ADD COLUMN IF NOT EXISTS surge_activo BOOLEAN DEFAULT false;
ALTER TABLE sedes ADD COLUMN IF NOT EXISTS surge_precio_minimo INTEGER;
ALTER TABLE sedes ADD COLUMN IF NOT EXISTS surge_precio_maximo INTEGER;
