-- PROPOSAL ONLY. Dry-run by default: ends with ROLLBACK.
-- Do not apply without reviewing schema AND the separate access proposal.
-- No organizations, links, invitations or user roles are inserted/backfilled.
BEGIN;
SET LOCAL lock_timeout = '3s';
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
ROLLBACK;
