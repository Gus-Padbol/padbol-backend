-- CANDIDATE — NO AUTOAPLICABLE. Requiere revisión/ventana y precheck del esquema real.
-- Selección declarativa de un participante adulto de Nations, sin vincular cuenta.
-- El cliente recibe un id opaco; el id canónico queda sólo en backend/admin.
BEGIN;

ALTER TABLE public.nations_profile_requests
  ADD COLUMN IF NOT EXISTS selected_participante_id uuid NULL REFERENCES public.torneo_participantes(id),
  ADD COLUMN IF NOT EXISTS selection_status text NOT NULL DEFAULT 'declarada'
    CHECK (selection_status IN ('sin_seleccion','declarada','verificacion_pendiente','en_conflicto','reportada'));

CREATE INDEX IF NOT EXISTS nations_profile_requests_selected_idx
  ON public.nations_profile_requests(torneo_id, selected_participante_id)
  WHERE selected_participante_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.nations_selector_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  torneo_id bigint NOT NULL REFERENCES public.torneos(id),
  participante_id uuid NOT NULL REFERENCES public.torneo_participantes(id),
  reporter_user_id uuid NOT NULL REFERENCES auth.users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nations_selector_reports_one_per_actor UNIQUE (torneo_id, participante_id, reporter_user_id)
);

ALTER TABLE public.nations_selector_reports ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.nations_selector_reports FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.nations_selector_reports TO service_role;

COMMIT;
