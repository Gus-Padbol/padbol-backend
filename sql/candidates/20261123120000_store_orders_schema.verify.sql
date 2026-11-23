-- CANDIDATE — read-only verification for 20261123120000_store_orders_schema.sql.
-- Run after the migration and after the rollback. It returns one JSON document and
-- does not read store rows, credentials, settings or personal data.

SELECT jsonb_build_object(
  'checked_at', now(),
  'required_tables', (
    SELECT jsonb_agg(table_name ORDER BY table_name)
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'store_orders', 'store_order_items', 'store_sede_config',
         'store_sede_payment_methods'
       )
  ),
  'preserved_tables', (
    SELECT jsonb_agg(table_name ORDER BY table_name)
      FROM information_schema.tables
     WHERE table_schema = 'public'
       AND table_name IN (
         'store_catalog_products', 'store_central_offers', 'store_sede_offers'
       )
  ),
  'key_columns', (
    SELECT jsonb_agg(jsonb_build_object(
             'table', table_name, 'column', column_name,
             'type', data_type, 'nullable', is_nullable, 'default', column_default
           ) ORDER BY table_name, ordinal_position)
      FROM information_schema.columns
     WHERE table_schema = 'public'
       AND (
         (table_name = 'sedes' AND column_name = 'id')
         OR (table_name = 'store_sede_offers' AND column_name IN ('id', 'product_id', 'sede_id', 'precio', 'stock'))
         OR (table_name = 'store_orders' AND column_name IN ('id', 'sede_id', 'user_id', 'total', 'idempotency_key', 'idempotency_hash'))
         OR (table_name = 'store_order_items' AND column_name IN ('id', 'order_id', 'product_id', 'precio_unitario', 'cantidad'))
       )
  ),
  'rls', (
    SELECT jsonb_agg(jsonb_build_object('table', c.relname, 'enabled', c.relrowsecurity, 'forced', c.relforcerowsecurity) ORDER BY c.relname)
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relname IN ('store_orders', 'store_order_items', 'store_sede_config', 'store_sede_payment_methods')
  ),
  'policies', COALESCE((
    SELECT jsonb_agg(jsonb_build_object('table', tablename, 'name', policyname))
      FROM pg_policies
     WHERE schemaname = 'public'
       AND tablename IN ('store_orders', 'store_order_items', 'store_sede_config', 'store_sede_payment_methods')
  ), '[]'::jsonb),
  'table_grants', (
    SELECT jsonb_agg(jsonb_build_object('table', table_name, 'grantee', grantee, 'privilege', privilege_type) ORDER BY table_name, grantee, privilege_type)
      FROM information_schema.table_privileges
     WHERE table_schema = 'public'
       AND table_name IN ('store_orders', 'store_order_items', 'store_sede_config', 'store_sede_payment_methods')
       AND grantee IN ('anon', 'authenticated', 'service_role')
  ),
  'routines', (
    SELECT jsonb_agg(jsonb_build_object(
             'name', p.proname,
             'arguments', pg_get_function_identity_arguments(p.oid),
             'security_definer', p.prosecdef,
             'search_path', p.proconfig,
             'acl', p.proacl
           ) ORDER BY p.proname)
      FROM pg_proc p
      JOIN pg_namespace n ON n.oid = p.pronamespace
     WHERE n.nspname = 'public'
       AND p.proname IN ('store_create_order', 'store_update_order')
  ),
  'function_privileges', (
    SELECT jsonb_build_array(
      jsonb_build_object(
        'function', 'store_create_order',
        'anon', has_function_privilege('anon', 'public.store_create_order(uuid,integer,text,jsonb,text,text)', 'EXECUTE'),
        'authenticated', has_function_privilege('authenticated', 'public.store_create_order(uuid,integer,text,jsonb,text,text)', 'EXECUTE'),
        'service_role', has_function_privilege('service_role', 'public.store_create_order(uuid,integer,text,jsonb,text,text)', 'EXECUTE')
      ),
      jsonb_build_object(
        'function', 'store_update_order',
        'anon', has_function_privilege('anon', 'public.store_update_order(bigint,integer,text,text)', 'EXECUTE'),
        'authenticated', has_function_privilege('authenticated', 'public.store_update_order(bigint,integer,text,text)', 'EXECUTE'),
        'service_role', has_function_privilege('service_role', 'public.store_update_order(bigint,integer,text,text)', 'EXECUTE')
      )
    )
  ),
  'roles', (
    SELECT jsonb_agg(jsonb_build_object('role', rolname, 'superuser', rolsuper, 'bypassrls', rolbypassrls) ORDER BY rolname)
      FROM pg_roles
     WHERE rolname IN ('anon', 'authenticated', 'service_role')
  )
) AS store_schema_verification;
