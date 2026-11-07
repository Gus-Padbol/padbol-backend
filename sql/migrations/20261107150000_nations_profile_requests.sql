-- Solicitudes PRIVADAS de perfil para una nómina Nations.
-- Regla: no se reclama identidad por nombre+país. El jugador autenticado declara sus datos;
-- queda pendiente de REVISIÓN CENTRAL. Los datos declarados NO tocan el canon hasta aprobarse.
BEGIN;

CREATE TABLE IF NOT EXISTS public.nations_profile_requests (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  torneo_id bigint NOT NULL REFERENCES public.torneos(id),
  actor_user_id uuid NOT NULL REFERENCES auth.users(id),
  request_id text NOT NULL CHECK (length(request_id) BETWEEN 8 AND 120 AND request_id ~ '^[A-Za-z0-9_-]+$'),
  declared_name text NOT NULL CHECK (length(trim(declared_name)) BETWEEN 2 AND 100),
  declared_country text NOT NULL CHECK (declared_country ~ '^[A-Z]{2}$'),
  age_status text NOT NULL CHECK (age_status IN ('adulto','menor','desconocido')),
  guardian_consent boolean NOT NULL DEFAULT false,
  profile_consent boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pendiente' CHECK (status IN ('pendiente','en_revision','aprobada','rechazada')),
  matched_participante_id uuid NULL,
  review_note text NULL,
  reviewed_by uuid NULL,
  reviewed_at timestamptz NULL,
  payload_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT nations_profile_requests_menor_consent CHECK (age_status <> 'menor' OR guardian_consent),
  CONSTRAINT nations_profile_requests_actor_request UNIQUE (actor_user_id, torneo_id, request_id)
);
CREATE INDEX IF NOT EXISTS nations_profile_requests_torneo_idx ON public.nations_profile_requests(torneo_id, status);

ALTER TABLE public.nations_profile_requests ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS nations_profile_requests_own_select ON public.nations_profile_requests;
CREATE POLICY nations_profile_requests_own_select ON public.nations_profile_requests
  FOR SELECT TO authenticated USING (actor_user_id = auth.uid());

REVOKE ALL ON public.nations_profile_requests FROM anon;
GRANT SELECT ON public.nations_profile_requests TO authenticated;

COMMIT;

-- Fase 1b: una sola solicitud ACTIVA por actor y evento (pendiente/en_revision).
BEGIN;
CREATE UNIQUE INDEX IF NOT EXISTS nations_profile_requests_activa_por_actor
  ON public.nations_profile_requests(actor_user_id, torneo_id)
  WHERE status IN ('pendiente','en_revision');
COMMIT;
