-- Authorized production repair; not yet applied. Target vpldffhsxhgnmitiikof only.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '20s';
DO $$ BEGIN
 IF current_user <> 'postgres' THEN RAISE EXCEPTION 'MULTISEDE_UNEXPECTED_MIGRATION_ROLE'; END IF;
 IF to_regclass('public.organizacion_sedes') IS NOT NULL THEN RAISE EXCEPTION 'MULTISEDE_SCHEMA_DRIFT'; END IF;
 IF (SELECT count(*) FROM public.organizaciones) <> 1 OR EXISTS(SELECT 1 FROM public.user_roles WHERE role='admin_cadena' OR organizacion_id IS NOT NULL) THEN RAISE EXCEPTION 'MULTISEDE_BASELINE_DRIFT'; END IF;
END $$;
CREATE TABLE public.organizacion_sedes (
 organizacion_id uuid NOT NULL REFERENCES public.organizaciones(id) ON DELETE CASCADE,
 sede_id bigint NOT NULL REFERENCES public.sedes(id) ON DELETE CASCADE,
 created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY (organizacion_id,sede_id),
 CONSTRAINT organizacion_sedes_sede_unica UNIQUE (sede_id)
);
ALTER TABLE public.invitaciones_admin
 ADD COLUMN organizacion_id uuid REFERENCES public.organizaciones(id) ON DELETE SET NULL;
ALTER TABLE public.sedes_pendientes
 ADD COLUMN organizacion_id uuid REFERENCES public.organizaciones(id) ON DELETE SET NULL,
 ADD COLUMN cantidad_canchas_solicitadas integer,
 ADD CONSTRAINT sedes_pendientes_cantidad_canchas_solicitadas_check
 CHECK (cantidad_canchas_solicitadas IS NULL OR cantidad_canchas_solicitadas > 0);
CREATE INDEX idx_sedes_pendientes_organizacion_id ON public.sedes_pendientes(organizacion_id)
 WHERE organizacion_id IS NOT NULL;
-- Existing user_roles.organizacion_id and role/alcance constraints are untouched.
-- This proposal intentionally fails on conflicting/preexisting objects: inspect, do not hide drift.
ALTER TABLE public.organizacion_sedes ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.organizacion_sedes FROM PUBLIC, anon, authenticated, service_role;
GRANT SELECT, INSERT, DELETE ON public.organizacion_sedes TO service_role;
DO $$ DECLARE r text; p text; BEGIN
 FOREACH r IN ARRAY ARRAY['anon','authenticated'] LOOP
  FOREACH p IN ARRAY ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
   IF has_table_privilege(r,'public.organizacion_sedes',p) THEN RAISE EXCEPTION 'MULTISEDE_PUBLIC_PRIVILEGE'; END IF;
  END LOOP;
 END LOOP;
 FOREACH p IN ARRAY ARRAY['SELECT','INSERT','DELETE'] LOOP
  IF NOT has_table_privilege('service_role','public.organizacion_sedes',p) THEN RAISE EXCEPTION 'MULTISEDE_SERVICE_PRIVILEGE_MISSING'; END IF;
 END LOOP;
 FOREACH p IN ARRAY ARRAY['UPDATE','TRUNCATE','REFERENCES','TRIGGER'] LOOP
  IF has_table_privilege('service_role','public.organizacion_sedes',p) THEN RAISE EXCEPTION 'MULTISEDE_SERVICE_PRIVILEGE_EXCESS'; END IF;
 END LOOP;
 IF EXISTS(SELECT 1 FROM pg_class c CROSS JOIN LATERAL aclexplode(c.relacl) a WHERE c.oid='public.organizacion_sedes'::regclass AND (a.grantee=0 OR a.grantee NOT IN(c.relowner,(SELECT oid FROM pg_roles WHERE rolname='service_role')) OR (a.grantee=(SELECT oid FROM pg_roles WHERE rolname='service_role') AND a.is_grantable))) THEN RAISE EXCEPTION 'MULTISEDE_UNEXPECTED_TABLE_ACL'; END IF;
 IF NOT (SELECT relrowsecurity FROM pg_class WHERE oid='public.organizacion_sedes'::regclass) OR EXISTS(SELECT 1 FROM pg_policy WHERE polrelid='public.organizacion_sedes'::regclass) THEN RAISE EXCEPTION 'MULTISEDE_RLS_NOT_CLOSED'; END IF;
 IF EXISTS(SELECT 1 FROM public.organizacion_sedes) THEN RAISE EXCEPTION 'MULTISEDE_UNEXPECTED_LINK'; END IF;
END $$;
NOTIFY pgrst, 'reload schema';
COMMIT;
