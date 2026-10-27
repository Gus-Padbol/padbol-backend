-- Adds missing metadata and empty incentive tables.
-- No program activation, seed data, billing, commercial-plan or evaluation triggers.
BEGIN;
ALTER TABLE public.profesores
 ADD COLUMN IF NOT EXISTS especialidad text,
 ADD COLUMN IF NOT EXISTS nivel text,
 ADD COLUMN IF NOT EXISTS certificado_numero text,
 ADD COLUMN IF NOT EXISTS certificado_url text,
 ADD COLUMN IF NOT EXISTS certificado_estado text,
 ADD COLUMN IF NOT EXISTS certificado_nota text,
 ADD COLUMN IF NOT EXISTS certificado_verificado_at timestamptz,
 ADD COLUMN IF NOT EXISTS certificado_verificado_por uuid;
create table if not exists public.sede_programas_beneficios (
  id uuid primary key default gen_random_uuid(),
  sede_id bigint not null references public.sedes(id) on delete cascade,
  codigo text not null,
  estado text not null default 'borrador',
  meses_base integer not null default 0,
  meses_desbloqueados integer not null default 0,
  fecha_inicio date,
  fecha_fin_base date,
  reglas_version text,
  configuracion jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (sede_id, codigo),
  constraint sede_programas_beneficios_estado_check
    check (estado in ('borrador', 'activo', 'pausado', 'finalizado')),
  constraint sede_programas_beneficios_meses_check
    check (meses_base >= 0 and meses_desbloqueados >= 0)
);

create table if not exists public.sede_beneficio_progreso (
  id uuid primary key default gen_random_uuid(),
  programa_id uuid not null references public.sede_programas_beneficios(id) on delete cascade,
  periodo date not null,
  metricas jsonb not null default '{}'::jsonb,
  evidencia jsonb not null default '{}'::jsonb,
  estado text not null default 'pendiente',
  meses_desbloqueados integer not null default 0,
  evaluado_at timestamptz,
  evaluado_por text,
  created_at timestamptz not null default now(),
  unique (programa_id, periodo),
  constraint sede_beneficio_progreso_estado_check
    check (estado in ('pendiente', 'cumplido', 'no_cumplido', 'anulado')),
  constraint sede_beneficio_progreso_meses_check check (meses_desbloqueados >= 0)
);


ALTER TABLE public.sede_programas_beneficios ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.sede_beneficio_progreso ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.sede_programas_beneficios, public.sede_beneficio_progreso FROM anon, authenticated;
GRANT ALL ON public.sede_programas_beneficios, public.sede_beneficio_progreso TO service_role;
NOTIFY pgrst, 'reload schema';
COMMIT;
