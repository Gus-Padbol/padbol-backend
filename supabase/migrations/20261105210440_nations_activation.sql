BEGIN;
CREATE TABLE public.nations_activation_events (
 torneo_id bigint PRIMARY KEY REFERENCES public.torneos(id) ON DELETE RESTRICT,
 slug text NOT NULL UNIQUE CHECK(slug ~ '^[a-z0-9][a-z0-9-]{2,79}$'), title text NOT NULL CHECK(length(title) BETWEEN 3 AND 160),
 enabled boolean NOT NULL DEFAULT false, roster_publication_approved boolean NOT NULL DEFAULT false, names_published boolean NOT NULL DEFAULT false,
 names_release_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE public.nations_activation_delegates (
 torneo_id bigint NOT NULL REFERENCES public.nations_activation_events(torneo_id),
 country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'), user_id uuid NOT NULL REFERENCES auth.users(id),
 enabled boolean NOT NULL DEFAULT true, PRIMARY KEY(torneo_id,country,user_id)
);
CREATE TABLE public.nations_activation_participants (
 participante_id uuid PRIMARY KEY REFERENCES public.torneo_participantes(id),
 torneo_id bigint NOT NULL REFERENCES public.nations_activation_events(torneo_id),
 country text NOT NULL CHECK(country ~ '^[A-Z]{2}$'), row_key text NOT NULL CHECK(length(row_key) BETWEEN 1 AND 120),
 minor boolean NOT NULL DEFAULT false, guardian_reviewed_by uuid REFERENCES auth.users(id), guardian_reviewed_at timestamptz,
 UNIQUE(torneo_id,row_key), FOREIGN KEY(torneo_id,participante_id) REFERENCES public.torneo_participantes(torneo_id,id),
 CHECK((guardian_reviewed_by IS NULL)=(guardian_reviewed_at IS NULL))
);
CREATE TABLE public.nations_activation_imports (
 torneo_id bigint NOT NULL REFERENCES public.nations_activation_events(torneo_id), batch_id uuid NOT NULL,
 actor_id uuid NOT NULL REFERENCES auth.users(id), payload_hash text NOT NULL, receipt jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(torneo_id,batch_id)
);
CREATE TABLE public.nations_activation_invites (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(), participante_id uuid NOT NULL REFERENCES public.nations_activation_participants(participante_id),
 token_hash text NOT NULL UNIQUE CHECK(length(token_hash)=64), created_by uuid NOT NULL REFERENCES auth.users(id),
 expires_at timestamptz NOT NULL, revoked_at timestamptz, used_at timestamptz, used_by uuid REFERENCES auth.users(id),
 created_at timestamptz NOT NULL DEFAULT now(), CHECK((used_at IS NULL)=(used_by IS NULL))
);
CREATE UNIQUE INDEX nations_activation_one_invite ON public.nations_activation_invites(participante_id) WHERE revoked_at IS NULL AND used_at IS NULL;
CREATE TABLE public.nations_activation_audit (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),torneo_id bigint NOT NULL REFERENCES public.nations_activation_events(torneo_id),
 participante_id uuid REFERENCES public.torneo_participantes(id), actor_id uuid REFERENCES auth.users(id),
 action text NOT NULL, detail jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now()
);
DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY['nations_activation_events','nations_activation_delegates','nations_activation_participants','nations_activation_imports','nations_activation_invites','nations_activation_audit'] LOOP
 EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY',t);
 EXECUTE format('REVOKE ALL ON public.%I FROM PUBLIC,anon,authenticated',t);
 EXECUTE format('GRANT SELECT,INSERT,UPDATE,DELETE ON public.%I TO service_role',t);
END LOOP; END $$;
COMMIT;
