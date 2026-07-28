-- Tienda Padbol por Sedes · piloto La Meca
-- Ejecutar en Supabase SQL Editor. Es seguro volver a ejecutar.

CREATE TABLE IF NOT EXISTS public.store_sede_config (
  sede_id INTEGER PRIMARY KEY REFERENCES public.sedes(id) ON DELETE CASCADE,
  estado TEXT NOT NULL DEFAULT 'opening_soon' CHECK (estado IN ('active', 'opening_soon', 'paused')),
  retiro_en_sede BOOLEAN NOT NULL DEFAULT true,
  entrega_local BOOLEAN NOT NULL DEFAULT false,
  radio_entrega_km NUMERIC(6,2) NULL CHECK (radio_entrega_km IS NULL OR radio_entrega_km >= 0),
  instrucciones_retiro TEXT NULL,
  instrucciones_entrega TEXT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.store_sede_payment_methods (
  id BIGSERIAL PRIMARY KEY,
  sede_id INTEGER NOT NULL REFERENCES public.sedes(id) ON DELETE CASCADE,
  codigo TEXT NOT NULL CHECK (codigo IN ('cash_on_pickup', 'bank_transfer', 'mercadopago', 'stripe', 'other')),
  nombre TEXT NOT NULL,
  activo BOOLEAN NOT NULL DEFAULT false,
  instrucciones TEXT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sede_id, codigo)
);

CREATE INDEX IF NOT EXISTS idx_store_payment_methods_sede ON public.store_sede_payment_methods (sede_id, activo);

CREATE TABLE IF NOT EXISTS public.store_catalog_products (
  id BIGSERIAL PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  nombre TEXT NOT NULL,
  categoria TEXT NOT NULL DEFAULT 'official_merchandise',
  descripcion TEXT NULL,
  imagen_url TEXT NULL,
  activo BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS public.store_sede_offers (
  id BIGSERIAL PRIMARY KEY,
  sede_id INTEGER NOT NULL REFERENCES public.sedes(id) ON DELETE CASCADE,
  product_id BIGINT NOT NULL REFERENCES public.store_catalog_products(id) ON DELETE RESTRICT,
  autorizado BOOLEAN NOT NULL DEFAULT false,
  activo BOOLEAN NOT NULL DEFAULT false,
  precio NUMERIC(12,2) NULL CHECK (precio IS NULL OR precio >= 0),
  moneda TEXT NOT NULL DEFAULT 'ARS',
  stock INTEGER NOT NULL DEFAULT 0 CHECK (stock >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (sede_id, product_id)
);

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

CREATE INDEX IF NOT EXISTS idx_store_offers_sede ON public.store_sede_offers (sede_id, autorizado, activo);
CREATE INDEX IF NOT EXISTS idx_store_orders_sede ON public.store_orders (sede_id, estado, created_at DESC);

-- La Meca (id 1): piloto operativo, sin cobro automático.
INSERT INTO public.store_sede_config (
  sede_id, estado, retiro_en_sede, entrega_local, radio_entrega_km,
  instrucciones_retiro, instrucciones_entrega
) VALUES (
  1, 'active', true, true, 12,
  'Retirá tu pedido en La Meca Padbol Club cuando la sede confirme que está listo.',
  'La entrega local se coordina con La Meca dentro de la zona habilitada.'
)
ON CONFLICT (sede_id) DO UPDATE SET
  estado = EXCLUDED.estado,
  retiro_en_sede = EXCLUDED.retiro_en_sede,
  entrega_local = EXCLUDED.entrega_local,
  radio_entrega_km = EXCLUDED.radio_entrega_km,
  instrucciones_retiro = EXCLUDED.instrucciones_retiro,
  instrucciones_entrega = EXCLUDED.instrucciones_entrega,
  updated_at = NOW();

INSERT INTO public.store_catalog_products (slug, nombre, categoria, descripcion, activo)
VALUES ('chivi-figure', 'Chivi · figura oficial', 'official_merchandise', 'Figura oficial de Padbol Match.', true)
ON CONFLICT (slug) DO UPDATE SET nombre = EXCLUDED.nombre, descripcion = EXCLUDED.descripcion, activo = true, updated_at = NOW();

INSERT INTO public.store_sede_offers (sede_id, product_id, autorizado, activo, precio, moneda, stock)
SELECT 1, id, true, true, 35000, 'ARS', 5 FROM public.store_catalog_products WHERE slug = 'chivi-figure'
ON CONFLICT (sede_id, product_id) DO UPDATE SET autorizado = true, activo = true, precio = EXCLUDED.precio, moneda = EXCLUDED.moneda, stock = EXCLUDED.stock, updated_at = NOW();

INSERT INTO public.store_sede_payment_methods (sede_id, codigo, nombre, activo, instrucciones)
VALUES
  (1, 'cash_on_pickup', 'Pago al retirar', true, 'La sede confirma el pedido antes del retiro.'),
  (1, 'bank_transfer', 'Transferencia bancaria', true, 'La sede comparte los datos de pago al confirmar el pedido.')
ON CONFLICT (sede_id, codigo) DO UPDATE SET
  nombre = EXCLUDED.nombre,
  activo = EXCLUDED.activo,
  instrucciones = EXCLUDED.instrucciones,
  updated_at = NOW();
