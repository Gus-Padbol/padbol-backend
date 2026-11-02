-- QA ONLY reviewed proposal; NOT APPLIED. Exact target vxikhdulhuvghfqeutnp; never production.
-- Las tablas legacy no tienen DDL completo en esa revisión. No fabricarlo:
-- verificar columnas mínimas antes de crear la relación durable y la outbox.
BEGIN;
SET LOCAL lock_timeout = '1ms';
SET LOCAL statement_timeout = '5s';
-- Fail immediately on conflicting legacy activity; no traffic pause/retry loop.
LOCK TABLE public.sedes_pendientes, public.sedes IN SHARE ROW EXCLUSIVE MODE NOWAIT;
DO $$
DECLARE requirement record;
BEGIN
  FOR requirement IN SELECT * FROM (VALUES
    ('sedes_pendientes','id'),('sedes_pendientes','estado'),
    ('sedes_pendientes','nombre'),('sedes_pendientes','licenciatario_email'),
    ('sedes','id'),('sedes','nombre'),('sedes','pais'),('sedes','ciudad'),
    ('user_roles','user_id'),('user_roles','email'),('user_roles','role'),
    ('user_roles','alcance'),('user_roles','sede_id'),('user_roles','pais'),
    ('user_roles','provincia'),('user_roles','ciudad'),('user_roles','nombre'),
    ('user_roles','torneos_oficiales_habilitados')
  ) AS required(table_name,column_name) LOOP
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns c
      WHERE c.table_schema='public' AND c.table_name=requirement.table_name
      AND c.column_name=requirement.column_name) THEN
      RAISE EXCEPTION 'DG09_SCHEMA_REVIEW_REQUIRED: %.%',requirement.table_name,requirement.column_name;
    END IF;
  END LOOP;
END $$;

CREATE TABLE public.sede_approval_operations (
  request_id bigint PRIMARY KEY REFERENCES public.sedes_pendientes(id) ON DELETE RESTRICT,
  sede_id bigint NOT NULL UNIQUE REFERENCES public.sedes(id) ON DELETE RESTRICT,
  actor_user_id uuid NOT NULL,
  completed_at timestamptz NOT NULL DEFAULT now(),
  recovered_existing boolean NOT NULL DEFAULT false,
  role_preserved boolean NOT NULL,
  role_before jsonb,
  role_after jsonb,
  delivery_context jsonb NOT NULL CHECK (jsonb_typeof(delivery_context)='object'),
  request_fingerprint text NOT NULL CHECK (request_fingerprint ~ '^[a-f0-9]{64}$')
);
CREATE TABLE public.sede_approval_outbox (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id bigint NOT NULL REFERENCES public.sede_approval_operations(request_id) ON DELETE RESTRICT,
  kind text NOT NULL CHECK (kind IN ('auth_user','welcome_email','registration_event','whatsapp_creator','whatsapp_license')),
  prerequisite_kind text,
  state text NOT NULL DEFAULT 'pending' CHECK (state IN ('pending','running','succeeded','skipped','retryable','uncertain','blocked')),
  attempts integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  provider_reference text,
  last_error_code text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(request_id,kind)
);
CREATE INDEX sede_approval_outbox_ready ON public.sede_approval_outbox(state,next_attempt_at);
CREATE TABLE public.sede_approval_delivery_reviews (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id bigint NOT NULL,
  kind text NOT NULL,
  actor_user_id uuid NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('confirmed_delivered','confirmed_not_sent')),
  previous_state text NOT NULL,
  evidence_reference text NOT NULL CHECK (length(evidence_reference) BETWEEN 1 AND 200),
  created_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY(request_id,kind) REFERENCES public.sede_approval_outbox(request_id,kind) ON DELETE RESTRICT
);
ALTER TABLE public.sede_approval_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sede_approval_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sede_approval_delivery_reviews ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sede_approval_operations,public.sede_approval_outbox,public.sede_approval_delivery_reviews FROM PUBLIC,anon,authenticated,service_role;
GRANT SELECT,INSERT ON public.sede_approval_operations TO service_role;
GRANT SELECT,INSERT,UPDATE ON public.sede_approval_outbox TO service_role;
GRANT SELECT,INSERT ON public.sede_approval_delivery_reviews TO service_role;
REVOKE ALL ON SEQUENCE public.sede_approval_outbox_id_seq,public.sede_approval_delivery_reviews_id_seq FROM PUBLIC,anon,authenticated,service_role;
GRANT USAGE,SELECT ON SEQUENCE public.sede_approval_outbox_id_seq TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.sede_approval_delivery_reviews_id_seq TO service_role;
COMMIT;
