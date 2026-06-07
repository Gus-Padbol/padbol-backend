-- Surge v2: bandas de precio por porcentaje sobre precio base de la sede
ALTER TABLE public.surge_config
  ADD COLUMN IF NOT EXISTS descuento_max_pct NUMERIC(5, 2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS aumento_max_pct NUMERIC(5, 2) NOT NULL DEFAULT 0;

COMMENT ON COLUMN public.surge_config.descuento_max_pct IS 'Descuento máximo sobre precio base (%) cuando ocupación es baja';
COMMENT ON COLUMN public.surge_config.aumento_max_pct IS 'Aumento máximo sobre precio base (%) cuando ocupación es alta';
