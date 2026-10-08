BEGIN;

-- Esta política pretendía proteger un único bucket, pero por la semántica OR de
-- RLS terminaba concediendo ALL sobre cualquier otro bucket a anon/authenticated.
DROP POLICY IF EXISTS fipa_secure_documents_backend_only ON storage.objects;

CREATE OR REPLACE FUNCTION public.pm_auth_can_manage_sponsor_object(object_name text)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public, auth, storage
AS $function$
  SELECT
    public.pm_auth_has_admin_role(ARRAY['editor_contenido','admin_nacional','super_admin'])
    OR EXISTS (
      SELECT 1
      FROM public.user_roles ur
      WHERE ur.user_id = auth.uid()
        AND ur.role IN ('admin_club','admin_sede')
        AND ur.sede_id IS NOT NULL
        AND (storage.foldername(object_name))[1] IN ('sedes','extras')
        AND (storage.foldername(object_name))[2] ~ '^[0-9]+$'
        AND ((storage.foldername(object_name))[2])::bigint = ur.sede_id
    );
$function$;

REVOKE ALL ON FUNCTION public.pm_auth_can_manage_sponsor_object(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.pm_auth_can_manage_sponsor_object(text) TO authenticated;

DROP POLICY IF EXISTS "Sponsor editors upload media" ON storage.objects;
DROP POLICY IF EXISTS "Sponsor editors update media" ON storage.objects;
DROP POLICY IF EXISTS "Sponsor editors delete media" ON storage.objects;

CREATE POLICY "Sponsor editors upload media"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (
  bucket_id = 'sponsors'
  AND public.pm_auth_can_manage_sponsor_object(name)
);

CREATE POLICY "Sponsor editors update media"
ON storage.objects FOR UPDATE TO authenticated
USING (
  bucket_id = 'sponsors'
  AND public.pm_auth_can_manage_sponsor_object(name)
)
WITH CHECK (
  bucket_id = 'sponsors'
  AND public.pm_auth_can_manage_sponsor_object(name)
);

CREATE POLICY "Sponsor editors delete media"
ON storage.objects FOR DELETE TO authenticated
USING (
  bucket_id = 'sponsors'
  AND public.pm_auth_can_manage_sponsor_object(name)
);

COMMIT;

