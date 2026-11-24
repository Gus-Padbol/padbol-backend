-- LOCAL CANDIDATE ONLY — NOT APPLIED.
-- Target reviewed metadata: project vxikhdulhuvghfqeutnp, public.contratos_sedes
-- actually has 7 columns (id, sede_id, fecha_inicio, fecha_vencimiento,
-- referencia, archivo_url, created_at), no storage_path and no contract bucket.
-- This candidate is the smallest private-file capability for route 053:
--   1) optional storage_path pointer (legacy rows/archivo_url/ACL/RLS untouched),
--   2) one fixed PRIVATE bucket (never public),
--   3) restrictive browser deny for that bucket (service_role bypasses RLS).
-- No public bucket, no grants, no permissions widening, no row mutation, no
-- business ledger. The stable contract UUID is already the PK of
-- public.contratos_sedes, so no new idempotency table/RPC is needed.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';

-- 1) Optional private pointer. Existing rows keep storage_path NULL and the
-- legacy archivo_url value; no constraint/default/not-null is added.
ALTER TABLE public.contratos_sedes
  ADD COLUMN IF NOT EXISTS storage_path text;

-- 2) Fixed private bucket. Refuse to keep/reuse a public bucket with this name.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'contratos-sedes-privados',
  'contratos-sedes-privados',
  false,
  10485760,
  ARRAY['application/pdf', 'image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO NOTHING;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM storage.buckets
    WHERE id = 'contratos-sedes-privados' AND public IS TRUE
  ) THEN
    RAISE EXCEPTION 'CONTRATO_BUCKET_PUBLIC_CONFLICT: contratos-sedes-privados no puede ser público';
  END IF;
END $$;

-- 3) Browser roles (anon/authenticated) may not list/read/write this bucket.
-- RESTRICTIVE so another permissive storage.objects policy cannot reopen it.
-- The predicate is true for every other bucket, so existing storage policies
-- keep working. service_role bypasses RLS and remains the only writer/reader.
DROP POLICY IF EXISTS contratos_sedes_privados_browser_deny ON storage.objects;
CREATE POLICY contratos_sedes_privados_browser_deny
  ON storage.objects
  AS RESTRICTIVE
  FOR ALL
  TO anon, authenticated
  USING (bucket_id <> 'contratos-sedes-privados')
  WITH CHECK (bucket_id <> 'contratos-sedes-privados');

COMMIT;
