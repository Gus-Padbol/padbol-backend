-- Padbol Match Shop · pedidos y cumplimiento
-- Ejecutar una vez en Supabase SQL Editor si el piloto inicial fue instalado sin estas tablas.
-- Es idempotente: se puede volver a ejecutar sin borrar información.

CREATE TABLE IF NOT EXISTS public.store_orders (
  id BIGSERIAL PRIMARY KEY,
  codigo TEXT NOT NULL UNIQUE,
  sede_id INTEGER NOT NULL REFERENCES public.sedes(id) ON DELETE RESTRICT,
  user_id UUID NULL,
  estado TEXT NOT NULL DEFAULT 'nuevo' CHECK (estado IN ('nuevo','confirmado','preparando','listo_retiro','enviado','entregado','cancelado')),
  pago_estado TEXT NOT NULL DEFAULT 'a_confirmar' CHECK (pago_estado IN ('pendiente','a_confirmar','confirmado','rechazado','reembolsado')),
  fulfillment_type TEXT NOT NULL CHECK (fulfillment_type IN ('pickup','local_delivery')),
  moneda TEXT NOT NULL,
  total NUMERIC(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  nota_cliente TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.store_order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id BIGINT NOT NULL REFERENCES public.store_orders(id) ON DELETE CASCADE,
  product_id BIGINT NULL REFERENCES public.store_catalog_products(id) ON DELETE SET NULL,
  nombre_producto TEXT NOT NULL,
  precio_unitario NUMERIC(12,2) NOT NULL CHECK (precio_unitario >= 0),
  cantidad INTEGER NOT NULL CHECK (cantidad > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_store_orders_sede ON public.store_orders (sede_id, estado, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_orders_user ON public.store_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_order_items_order ON public.store_order_items (order_id);
