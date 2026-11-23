-- CANDIDATE — NO AUTOAPLICABLE. Requires review and an explicit activation window.
-- TIENDA-SEDE-CIERRE-002 · additive schema for the four public store tables that
-- are absent from the effective catalog. It preserves store_catalog_products,
-- store_central_offers and store_sede_offers untouched and uses their real types:
--   sedes.id = integer or bigint (effective catalog is bigint), store_sede_offers.id/product_id = bigint.
-- RLS is enabled on every new table with no policies; anon/authenticated are
-- revoked and service_role is the only client role with table/RPC access.
-- The order/stock transaction lives in the two SECURITY DEFINER functions below
-- so the existing Supabase service-role client can call it without a new pgPool.
-- Apply only after the precheck/verify file: 20261123120000_store_orders_schema.verify.sql

BEGIN;

-- Fail before creating anything if this is not the expected Supabase-shaped
-- target. No role/schema is created by this migration.
DO $precheck$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated')
     OR NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    RAISE EXCEPTION 'TIENDA_SCHEMA_REQUIRES_SUPABASE_ROLES';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role' AND rolbypassrls) THEN
    RAISE EXCEPTION 'TIENDA_SCHEMA_REQUIRES_SERVICE_ROLE_BYPASSRLS';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'sedes'
       AND column_name = 'id' AND data_type IN ('integer', 'bigint')
  ) THEN
    RAISE EXCEPTION 'TIENDA_SCHEMA_REQUIRES_SEDES_ID_INTEGER_OR_BIGINT';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'store_sede_offers'
       AND column_name = 'sede_id' AND data_type = 'integer'
  ) OR NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'store_sede_offers'
       AND column_name = 'id' AND data_type = 'bigint'
  ) THEN
    RAISE EXCEPTION 'TIENDA_SCHEMA_REQUIRES_REAL_OFFER_TYPES';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = 'public' AND table_name = 'store_catalog_products'
       AND column_name = 'id' AND data_type = 'bigint'
  ) THEN
    RAISE EXCEPTION 'TIENDA_SCHEMA_REQUIRES_REAL_CATALOG_TYPES';
  END IF;
END
$precheck$;

CREATE TABLE IF NOT EXISTS public.store_sede_config (
  sede_id integer PRIMARY KEY REFERENCES public.sedes(id) ON DELETE CASCADE,
  estado text NOT NULL DEFAULT 'opening_soon'
    CHECK (estado IN ('active', 'opening_soon', 'paused')),
  retiro_en_sede boolean NOT NULL DEFAULT true,
  entrega_local boolean NOT NULL DEFAULT false,
  radio_entrega_km numeric(6,2)
    CHECK (radio_entrega_km IS NULL OR radio_entrega_km >= 0),
  instrucciones_retiro text,
  instrucciones_entrega text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.store_sede_payment_methods (
  id BIGSERIAL PRIMARY KEY,
  sede_id integer NOT NULL REFERENCES public.sedes(id) ON DELETE CASCADE,
  codigo text NOT NULL
    CHECK (codigo IN ('cash_on_pickup', 'bank_transfer', 'mercadopago', 'stripe', 'other')),
  nombre text NOT NULL,
  activo boolean NOT NULL DEFAULT false,
  instrucciones text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (sede_id, codigo)
);

CREATE TABLE IF NOT EXISTS public.store_orders (
  id BIGSERIAL PRIMARY KEY,
  codigo text NOT NULL UNIQUE,
  sede_id integer NOT NULL REFERENCES public.sedes(id) ON DELETE RESTRICT,
  user_id uuid,
  estado text NOT NULL DEFAULT 'nuevo'
    CHECK (estado IN ('nuevo','confirmado','preparando','listo_retiro','enviado','entregado','cancelado')),
  pago_estado text NOT NULL DEFAULT 'a_confirmar'
    CHECK (pago_estado IN ('pendiente','a_confirmar','confirmado','rechazado','reembolsado')),
  fulfillment_type text NOT NULL
    CHECK (fulfillment_type IN ('pickup','local_delivery')),
  moneda text NOT NULL,
  total numeric(12,2) NOT NULL DEFAULT 0 CHECK (total >= 0),
  nota_cliente text,
  idempotency_key text,
  idempotency_hash text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT store_orders_idempotency_pair_check
    CHECK ((idempotency_key IS NULL) = (idempotency_hash IS NULL)),
  CONSTRAINT store_orders_idempotency_key_check
    CHECK (idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 1 AND 200)),
  CONSTRAINT store_orders_idempotency_hash_check
    CHECK (idempotency_hash IS NULL OR idempotency_hash ~ '^[a-f0-9]{32}$')
);

CREATE TABLE IF NOT EXISTS public.store_order_items (
  id BIGSERIAL PRIMARY KEY,
  order_id bigint NOT NULL REFERENCES public.store_orders(id) ON DELETE CASCADE,
  product_id bigint REFERENCES public.store_catalog_products(id) ON DELETE SET NULL,
  nombre_producto text NOT NULL,
  precio_unitario numeric(12,2) NOT NULL CHECK (precio_unitario >= 0),
  cantidad integer NOT NULL CHECK (cantidad > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Additive safety if a previous candidate created store_orders without the
-- idempotency columns. Existing data is preserved; new columns stay nullable.
ALTER TABLE public.store_orders ADD COLUMN IF NOT EXISTS idempotency_key text;
ALTER TABLE public.store_orders ADD COLUMN IF NOT EXISTS idempotency_hash text;
DO $constraints$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.store_orders'::regclass
       AND conname = 'store_orders_idempotency_pair_check'
  ) THEN
    ALTER TABLE public.store_orders
      ADD CONSTRAINT store_orders_idempotency_pair_check
      CHECK ((idempotency_key IS NULL) = (idempotency_hash IS NULL));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.store_orders'::regclass
       AND conname = 'store_orders_idempotency_key_check'
  ) THEN
    ALTER TABLE public.store_orders
      ADD CONSTRAINT store_orders_idempotency_key_check
      CHECK (idempotency_key IS NULL OR (length(idempotency_key) BETWEEN 1 AND 200));
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.store_orders'::regclass
       AND conname = 'store_orders_idempotency_hash_check'
  ) THEN
    ALTER TABLE public.store_orders
      ADD CONSTRAINT store_orders_idempotency_hash_check
      CHECK (idempotency_hash IS NULL OR idempotency_hash ~ '^[a-f0-9]{32}$');
  END IF;
END
$constraints$;

CREATE INDEX IF NOT EXISTS idx_store_payment_methods_sede
  ON public.store_sede_payment_methods (sede_id, activo);
CREATE INDEX IF NOT EXISTS idx_store_orders_sede
  ON public.store_orders (sede_id, estado, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_orders_user
  ON public.store_orders (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_store_order_items_order
  ON public.store_order_items (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS store_orders_idempotency_uq
  ON public.store_orders (user_id, sede_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

ALTER TABLE public.store_sede_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_sede_payment_methods ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_orders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.store_order_items ENABLE ROW LEVEL SECURITY;

-- No policies: anon/authenticated have no row access. service_role keeps its
-- existing bypassrls attribute; explicit grants below are the only client access.
REVOKE ALL ON TABLE public.store_sede_config FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.store_sede_payment_methods FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.store_orders FROM PUBLIC, anon, authenticated;
REVOKE ALL ON TABLE public.store_order_items FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.store_sede_payment_methods_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.store_orders_id_seq FROM PUBLIC, anon, authenticated;
REVOKE ALL ON SEQUENCE public.store_order_items_id_seq FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_sede_config TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_sede_payment_methods TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_orders TO service_role;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.store_order_items TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.store_sede_payment_methods_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.store_orders_id_seq TO service_role;
GRANT USAGE, SELECT ON SEQUENCE public.store_order_items_id_seq TO service_role;

-- Transactional create. Idempotency scope is (verified buyer, sede, client key).
-- The cart hash covers fulfillment + sorted offer/quantity pairs; a replay with a
-- different cart raises STORE_IDEMPOTENCY_MISMATCH instead of creating a second
-- order or returning the previous one silently.
CREATE OR REPLACE FUNCTION public.store_create_order(
  p_user_id uuid,
  p_sede_id integer,
  p_fulfillment_type text,
  p_items jsonb,
  p_nota_cliente text DEFAULT NULL,
  p_idempotency_key text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_key text;
  v_count integer;
  v_distinct integer;
  v_cart_hash text;
  v_config public.store_sede_config%ROWTYPE;
  v_offer record;
  v_item record;
  v_total numeric := 0;
  v_currency text;
  v_order public.store_orders%ROWTYPE;
  v_payload jsonb;
BEGIN
  IF p_user_id IS NULL THEN
    RAISE EXCEPTION 'STORE_AUTH_REQUIRED';
  END IF;
  IF p_sede_id IS NULL OR p_sede_id <= 0 THEN
    RAISE EXCEPTION 'STORE_INVALID_SEDE';
  END IF;
  IF p_fulfillment_type IS NULL OR p_fulfillment_type NOT IN ('pickup', 'local_delivery') THEN
    RAISE EXCEPTION 'STORE_INVALID_FULFILLMENT';
  END IF;

  v_key := NULLIF(btrim(COALESCE(p_idempotency_key, '')), '');
  IF v_key IS NOT NULL AND length(v_key) > 200 THEN
    RAISE EXCEPTION 'STORE_IDEMPOTENCY_KEY_INVALID';
  END IF;

  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array'
     OR jsonb_array_length(p_items) = 0 OR jsonb_array_length(p_items) > 50 THEN
    RAISE EXCEPTION 'STORE_INVALID_ITEMS';
  END IF;
  IF EXISTS (
    SELECT 1
      FROM jsonb_array_elements(p_items) AS e
     WHERE (e->>'offer_id') IS NULL
        OR (e->>'quantity') IS NULL
        OR (e->>'offer_id') !~ '^[0-9]+$'
        OR (e->>'quantity') !~ '^[0-9]+$'
        OR (e->>'offer_id')::numeric <= 0
        OR (e->>'quantity')::numeric <= 0
        OR (e->>'offer_id')::numeric > 9223372036854775807
        OR (e->>'quantity')::numeric > 2147483647
  ) THEN
    RAISE EXCEPTION 'STORE_INVALID_ITEMS';
  END IF;

  SELECT count(*), count(DISTINCT (e->>'offer_id')::bigint)
    INTO v_count, v_distinct
    FROM jsonb_array_elements(p_items) AS e;
  IF v_count <> v_distinct THEN
    RAISE EXCEPTION 'STORE_INVALID_ITEMS';
  END IF;

  SELECT md5(
    p_fulfillment_type || '|' || string_agg(
      ((e->>'offer_id')::bigint)::text || ':' || ((e->>'quantity')::integer)::text,
      ',' ORDER BY (e->>'offer_id')::bigint
    )
  ) INTO v_cart_hash
    FROM jsonb_array_elements(p_items) AS e;

  -- The pair check requires both idempotency columns to be NULL together.
  IF v_key IS NULL THEN
    v_cart_hash := NULL;
  END IF;

  IF v_key IS NOT NULL THEN
    -- Serialise concurrent retries with the same (buyer, sede, key) before the
    -- existence check; the unique index remains the durable backstop.
    PERFORM pg_advisory_xact_lock(
      hashtextextended(p_user_id::text || '|' || p_sede_id::text || '|' || v_key, 0)
    );
    SELECT * INTO v_order
      FROM public.store_orders
     WHERE user_id = p_user_id
       AND sede_id = p_sede_id
       AND idempotency_key = v_key
     FOR UPDATE;
    IF FOUND THEN
      IF v_order.idempotency_hash IS DISTINCT FROM v_cart_hash THEN
        RAISE EXCEPTION 'STORE_IDEMPOTENCY_MISMATCH';
      END IF;
      SELECT jsonb_build_object(
        'order', (to_jsonb(v_order) - 'idempotency_key' - 'idempotency_hash'),
        'items', COALESCE((
          SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
            FROM public.store_order_items i
           WHERE i.order_id = v_order.id
        ), '[]'::jsonb),
        'replayed', true
      ) INTO v_payload;
      RETURN v_payload;
    END IF;
  END IF;

  SELECT * INTO v_config
    FROM public.store_sede_config
   WHERE sede_id = p_sede_id;
  IF NOT FOUND OR v_config.estado <> 'active' THEN
    RAISE EXCEPTION 'STORE_NOT_ACTIVE';
  END IF;
  IF p_fulfillment_type = 'pickup' AND NOT v_config.retiro_en_sede THEN
    RAISE EXCEPTION 'STORE_PICKUP_UNAVAILABLE';
  END IF;
  IF p_fulfillment_type = 'local_delivery' AND NOT v_config.entrega_local THEN
    RAISE EXCEPTION 'STORE_DELIVERY_UNAVAILABLE';
  END IF;

  -- Lock offers in ascending id order so concurrent carts cannot deadlock.
  FOR v_item IN
    SELECT value AS item
      FROM jsonb_array_elements(p_items)
     ORDER BY (value->>'offer_id')::bigint
  LOOP
    SELECT o.id, o.product_id, o.activo, o.autorizado, o.autorizado_por_super,
           o.precio, o.moneda, o.stock,
           p.nombre AS producto_nombre, p.activo AS producto_activo
      INTO v_offer
      FROM public.store_sede_offers o
      JOIN public.store_catalog_products p ON p.id = o.product_id
     WHERE o.sede_id = p_sede_id
       AND o.id = (v_item.item->>'offer_id')::bigint
     FOR UPDATE OF o;

    IF NOT FOUND
       OR v_offer.activo IS NOT TRUE
       OR v_offer.autorizado IS NOT TRUE
       OR v_offer.autorizado_por_super IS NOT TRUE
       OR v_offer.producto_activo IS NOT TRUE THEN
      RAISE EXCEPTION 'STORE_OFFER_UNAVAILABLE';
    END IF;
    IF v_offer.precio IS NULL OR v_offer.precio < 0 THEN
      RAISE EXCEPTION 'STORE_PRICE_UNAVAILABLE';
    END IF;
    IF v_offer.moneda IS NULL OR btrim(v_offer.moneda) = '' THEN
      RAISE EXCEPTION 'STORE_PRICE_UNAVAILABLE';
    END IF;
    IF v_currency IS NULL THEN
      v_currency := v_offer.moneda;
    ELSIF v_currency <> v_offer.moneda THEN
      RAISE EXCEPTION 'STORE_CURRENCY_MISMATCH';
    END IF;
    IF v_offer.stock < (v_item.item->>'quantity')::integer THEN
      RAISE EXCEPTION 'STORE_STOCK_UNAVAILABLE';
    END IF;
    v_total := v_total + (v_offer.precio * (v_item.item->>'quantity')::integer);
  END LOOP;

  IF v_total > 9999999999.99 THEN
    RAISE EXCEPTION 'STORE_INVALID_ITEMS';
  END IF;

  FOR v_item IN
    SELECT value AS item
      FROM jsonb_array_elements(p_items)
     ORDER BY (value->>'offer_id')::bigint
  LOOP
    UPDATE public.store_sede_offers
       SET stock = stock - (v_item.item->>'quantity')::integer,
           updated_at = now()
     WHERE sede_id = p_sede_id
       AND id = (v_item.item->>'offer_id')::bigint
       AND stock >= (v_item.item->>'quantity')::integer;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'STORE_STOCK_CHANGED';
    END IF;
  END LOOP;

  INSERT INTO public.store_orders (
    codigo, sede_id, user_id, fulfillment_type, moneda, total, nota_cliente,
    estado, pago_estado, idempotency_key, idempotency_hash
  ) VALUES (
    'PMS-' || upper(to_hex((extract(epoch FROM clock_timestamp()) * 1000)::bigint))
           || '-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
    p_sede_id, p_user_id, p_fulfillment_type, v_currency, round(v_total, 2),
    NULLIF(left(btrim(COALESCE(p_nota_cliente, '')), 1000), ''),
    'nuevo', 'a_confirmar', v_key, v_cart_hash
  ) RETURNING * INTO v_order;

  INSERT INTO public.store_order_items (
    order_id, product_id, nombre_producto, precio_unitario, cantidad
  )
  SELECT v_order.id, o.product_id, p.nombre, o.precio, (e.item->>'quantity')::integer
    FROM jsonb_array_elements(p_items) AS e(item)
    JOIN public.store_sede_offers o
      ON o.id = (e.item->>'offer_id')::bigint
     AND o.sede_id = p_sede_id
    JOIN public.store_catalog_products p ON p.id = o.product_id
   ORDER BY (e.item->>'offer_id')::bigint;

  SELECT jsonb_build_object(
    'order', (to_jsonb(v_order) - 'idempotency_key' - 'idempotency_hash'),
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
        FROM public.store_order_items i
       WHERE i.order_id = v_order.id
    ), '[]'::jsonb),
    'replayed', false
  ) INTO v_payload;
  RETURN v_payload;
END;
$fn$;

CREATE OR REPLACE FUNCTION public.store_update_order(
  p_order_id bigint,
  p_sede_id integer,
  p_estado text DEFAULT NULL,
  p_pago_estado text DEFAULT NULL
) RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $fn$
DECLARE
  v_order public.store_orders%ROWTYPE;
  v_prev_estado text;
  v_next_estado text;
  v_next_pago text;
  v_item record;
  v_payload jsonb;
BEGIN
  IF p_order_id IS NULL OR p_order_id <= 0 OR p_sede_id IS NULL OR p_sede_id <= 0 THEN
    RAISE EXCEPTION 'STORE_ORDER_NOT_FOUND';
  END IF;
  IF p_estado IS NOT NULL
     AND p_estado NOT IN ('nuevo','confirmado','preparando','listo_retiro','enviado','entregado','cancelado') THEN
    RAISE EXCEPTION 'STORE_INVALID_STATE';
  END IF;
  IF p_pago_estado IS NOT NULL
     AND p_pago_estado NOT IN ('pendiente','a_confirmar','confirmado','rechazado','reembolsado') THEN
    RAISE EXCEPTION 'STORE_INVALID_STATE';
  END IF;

  SELECT * INTO v_order
    FROM public.store_orders
   WHERE id = p_order_id AND sede_id = p_sede_id
   FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'STORE_ORDER_NOT_FOUND';
  END IF;

  v_prev_estado := v_order.estado;
  v_next_estado := COALESCE(p_estado, v_order.estado);
  v_next_pago := COALESCE(p_pago_estado, v_order.pago_estado);

  IF v_prev_estado = 'cancelado' AND v_next_estado <> 'cancelado' THEN
    FOR v_item IN
      SELECT product_id, sum(cantidad)::integer AS cantidad
        FROM public.store_order_items
       WHERE order_id = p_order_id AND product_id IS NOT NULL
       GROUP BY product_id
       ORDER BY product_id
    LOOP
      UPDATE public.store_sede_offers
         SET stock = stock - v_item.cantidad, updated_at = now()
       WHERE sede_id = p_sede_id
         AND product_id = v_item.product_id
         AND stock >= v_item.cantidad;
      IF NOT FOUND THEN
        RAISE EXCEPTION 'STORE_STOCK_UNAVAILABLE';
      END IF;
    END LOOP;
  END IF;

  UPDATE public.store_orders
     SET estado = v_next_estado,
         pago_estado = v_next_pago,
         updated_at = now()
   WHERE id = p_order_id
   RETURNING * INTO v_order;

  IF v_prev_estado <> 'cancelado' AND v_next_estado = 'cancelado' THEN
    UPDATE public.store_sede_offers o
       SET stock = o.stock + restored.cantidad,
           updated_at = now()
      FROM (
        SELECT product_id, sum(cantidad)::integer AS cantidad
          FROM public.store_order_items
         WHERE order_id = p_order_id AND product_id IS NOT NULL
         GROUP BY product_id
      ) restored
     WHERE o.sede_id = p_sede_id
       AND o.product_id = restored.product_id;
  END IF;

  SELECT jsonb_build_object(
    'order', (to_jsonb(v_order) - 'idempotency_key' - 'idempotency_hash'),
    'items', COALESCE((
      SELECT jsonb_agg(to_jsonb(i) ORDER BY i.id)
        FROM public.store_order_items i
       WHERE i.order_id = v_order.id
    ), '[]'::jsonb),
    'replayed', false
  ) INTO v_payload;
  RETURN v_payload;
END;
$fn$;

REVOKE ALL ON FUNCTION public.store_create_order(uuid, integer, text, jsonb, text, text)
  FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.store_update_order(bigint, integer, text, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.store_create_order(uuid, integer, text, jsonb, text, text)
  TO service_role;
GRANT EXECUTE ON FUNCTION public.store_update_order(bigint, integer, text, text)
  TO service_role;

-- Ask PostgREST to refresh its function/table cache after the DDL commit.
NOTIFY pgrst, 'reload schema';

COMMIT;
