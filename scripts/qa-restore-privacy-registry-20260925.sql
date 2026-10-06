-- QA ONLY: project vxikhdulhuvghfqeutnp. Preserve all documents and user acceptances.
BEGIN;
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.documentos_legales IN SHARE ROW EXCLUSIVE MODE;
DO $guard$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.documentos_legales WHERE tipo='privacidad' AND version='2026-09-10' AND vigente AND contenido_sha256='738d9170436965970bc90638e57a22c2b0c04ff5352e1fe159d780b4f1875617') OR NOT EXISTS (SELECT 1 FROM public.documentos_legales WHERE tipo='privacidad' AND version='2026-09-05' AND contenido_sha256='bcfb5a02d827fb46b6273b71db36452ee273753f06ea8fa9decd6953e070c255') THEN
    RAISE EXCEPTION 'Unexpected registry; rollback not applied';
  END IF;
END;
$guard$;
UPDATE public.documentos_legales SET vigente=false WHERE tipo='privacidad' AND version='2026-09-10';
UPDATE public.documentos_legales SET vigente=true WHERE tipo='privacidad' AND version='2026-09-05';
COMMIT;
