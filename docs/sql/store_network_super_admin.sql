-- Padbol Match Shop · control global Super Admin
-- Ejecutar después de store_network_pilot.sql. Seguro de reejecutar.

CREATE TABLE IF NOT EXISTS public.store_central_offers (
  id BIGSERIAL PRIMARY KEY,
  product_id BIGINT NOT NULL REFERENCES public.store_catalog_products(id) ON DELETE RESTRICT,
  activo BOOLEAN NOT NULL DEFAULT false,
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  precio NUMERIC(12,2) NULL CHECK (precio IS NULL OR precio >= 0),
  moneda TEXT NOT NULL DEFAULT 'ARS',
  pais_codigo TEXT NULL,
  ciudad TEXT NULL,
  radio_entrega_km NUMERIC(6,2) NULL CHECK (radio_entrega_km IS NULL OR radio_entrega_km >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_store_central_offers_active
ON public.store_central_offers (activo, product_id, pais_codigo);

-- Catálogo y fichas son globales; cada fila de oferta de sede necesita aprobación explícita.
ALTER TABLE public.store_sede_offers
  ADD COLUMN IF NOT EXISTS autorizado_por_super BOOLEAN NOT NULL DEFAULT false;

UPDATE public.store_sede_offers SET autorizado_por_super = true WHERE sede_id = 1;
