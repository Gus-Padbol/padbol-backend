-- Verificación individual de edad para un participante desconocido, sólo por admin.
-- No guarda DOB/documento: método y referencia opaca; la evidencia vive fuera.
BEGIN;

ALTER TABLE public.nations_profile_requests
  ADD COLUMN IF NOT EXISTS age_verification_status text NOT NULL DEFAULT 'pendiente'
    CHECK (age_verification_status IN ('pendiente','verificada','rechazada')),
  ADD COLUMN IF NOT EXISTS age_verification_method text NULL,
  ADD COLUMN IF NOT EXISTS age_verification_reference text NULL,
  ADD COLUMN IF NOT EXISTS age_verified_by uuid NULL REFERENCES auth.users(id),
  ADD COLUMN IF NOT EXISTS age_verified_at timestamptz NULL;

ALTER TABLE public.nations_profile_requests
  DROP CONSTRAINT IF EXISTS nations_profile_requests_selection_status_check;
ALTER TABLE public.nations_profile_requests
  ADD CONSTRAINT nations_profile_requests_selection_status_check
  CHECK (selection_status IN ('sin_seleccion','declarada','verificacion_pendiente','verificada','en_conflicto','reportada'));

COMMIT;
