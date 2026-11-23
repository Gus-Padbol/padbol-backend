-- CANDIDATE — ROLLBACK for 20261123120000_store_orders_schema.sql.
-- Only for an environment where the four new tables were absent before this
-- package was applied. It never touches store_catalog_products,
-- store_central_offers or store_sede_offers.
-- WARNING: dropping store_orders/store_order_items discards new orders. Run only
-- in a reviewed window after exporting/reconciling any rows that must be kept.

BEGIN;

DROP FUNCTION IF EXISTS public.store_update_order(bigint, integer, text, text);
DROP FUNCTION IF EXISTS public.store_create_order(uuid, integer, text, jsonb, text, text);

-- No CASCADE: an unexpected dependency makes the rollback fail closed instead of
-- deleting unrelated objects.
DROP TABLE IF EXISTS public.store_order_items;
DROP TABLE IF EXISTS public.store_orders;
DROP TABLE IF EXISTS public.store_sede_payment_methods;
DROP TABLE IF EXISTS public.store_sede_config;

NOTIFY pgrst, 'reload schema';

COMMIT;
