-- Next Generation: capa operativa. Los leads siguen viviendo en CRM; sólo una
-- conversión explícita crea una inscripción aquí.
create extension if not exists pgcrypto;

create table if not exists public.ng_solicitudes_sede (
  id uuid primary key default gen_random_uuid(),
  canonical_sede_id bigint references public.sedes(id) on delete set null,
  sede_club text not null,
  ciudad text,
  pais text,
  estado text not null default 'recibida',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ng_solicitudes_sede add column if not exists canonical_sede_id bigint references public.sedes(id) on delete set null;
alter table public.ng_solicitudes_sede add column if not exists estado text not null default 'recibida';
alter table public.ng_solicitudes_sede add column if not exists created_at timestamptz not null default now();
alter table public.ng_solicitudes_sede add column if not exists updated_at timestamptz not null default now();
alter table public.ng_solicitudes_sede add column if not exists crm_conversation_id uuid references public.crm_conversations(id) on delete set null;
alter table public.ng_solicitudes_sede add column if not exists contacto_nombre text;
alter table public.ng_solicitudes_sede add column if not exists contacto_email text;
alter table public.ng_solicitudes_sede add column if not exists contacto_whatsapp text;
alter table public.ng_solicitudes_sede add column if not exists created_by uuid;
create unique index if not exists uq_ng_solicitudes_crm_conversation
  on public.ng_solicitudes_sede(crm_conversation_id)
  where crm_conversation_id is not null;

create table if not exists public.ng_sesiones (
  id uuid primary key default gen_random_uuid(),
  sede_id bigint not null references public.sedes(id) on delete cascade,
  nombre_publico text not null,
  ciudad text,
  pais text,
  categoria text,
  comienza_at timestamptz,
  termina_at timestamptz,
  cupo integer not null default 0 check (cupo >= 0),
  estado text not null default 'borrador',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
alter table public.ng_sesiones add column if not exists updated_at timestamptz not null default now();

create table if not exists public.ng_inscripciones (
  id uuid primary key default gen_random_uuid(),
  sesion_id uuid references public.ng_sesiones(id) on delete restrict,
  sede_id bigint references public.sedes(id) on delete restrict,
  crm_conversation_id uuid references public.crm_conversations(id) on delete set null,
  contacto_nombre text not null,
  contacto_email text,
  contacto_whatsapp text,
  categoria text,
  estado text not null default 'borrador',
  posicion_espera integer,
  continuidad_estado text,
  cancel_reason text,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ng_inscripciones add column if not exists sede_id bigint references public.sedes(id) on delete restrict;
alter table public.ng_inscripciones add column if not exists crm_conversation_id uuid references public.crm_conversations(id) on delete set null;
alter table public.ng_inscripciones add column if not exists categoria text;
alter table public.ng_inscripciones add column if not exists cancel_reason text;
alter table public.ng_inscripciones add column if not exists created_by uuid;

do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.ng_inscripciones'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%estado%'
  loop
    execute format('alter table public.ng_inscripciones drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.ng_inscripciones
  add constraint ng_inscripciones_estado_check
  check (estado in ('borrador','confirmada','en_espera','cancelada'));

create unique index if not exists uq_ng_inscripciones_crm_conversation
  on public.ng_inscripciones(crm_conversation_id)
  where crm_conversation_id is not null;
create index if not exists idx_ng_inscripciones_sede_estado
  on public.ng_inscripciones(sede_id, estado, updated_at desc);
create index if not exists idx_ng_inscripciones_sesion_estado
  on public.ng_inscripciones(sesion_id, estado, posicion_espera);

create table if not exists public.ng_inscripcion_participantes (
  id uuid primary key default gen_random_uuid(),
  inscripcion_id uuid not null references public.ng_inscripciones(id) on delete cascade,
  nombre text not null,
  categoria text,
  created_at timestamptz not null default now()
);

create table if not exists public.ng_inscripcion_eventos (
  id uuid primary key default gen_random_uuid(),
  inscripcion_id uuid not null references public.ng_inscripciones(id) on delete cascade,
  sesion_id uuid references public.ng_sesiones(id) on delete set null,
  tipo text not null,
  actor text,
  detalle jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists idx_ng_eventos_inscripcion_created
  on public.ng_inscripcion_eventos(inscripcion_id, created_at);

-- Confirma sólo si queda capacidad. El bloqueo de jornada evita sobreventa.
create or replace function public.ng_confirm_registration(p_registration_id uuid, p_actor text default null)
returns public.ng_inscripciones
language plpgsql security definer set search_path = public
as $$
declare r public.ng_inscripciones; s public.ng_sesiones; used integer;
begin
  select * into r from public.ng_inscripciones where id = p_registration_id for update;
  if not found then raise exception using errcode = 'P0002', message = 'NG_REGISTRATION_NOT_FOUND'; end if;
  if r.estado = 'cancelada' then raise exception using errcode = 'P0001', message = 'NG_REGISTRATION_CANCELLED'; end if;
  if r.estado = 'confirmada' then return r; end if;
  if r.sesion_id is null or r.sede_id is null or nullif(trim(coalesce(r.categoria,'')), '') is null then
    raise exception using errcode = 'P0001', message = 'NG_ASSIGNMENT_REQUIRED';
  end if;
  select * into s from public.ng_sesiones where id = r.sesion_id for update;
  if not found or s.sede_id <> r.sede_id then raise exception using errcode = 'P0001', message = 'NG_SESSION_INVALID'; end if;
  select count(*) into used from public.ng_inscripciones where sesion_id = s.id and estado = 'confirmada' and id <> r.id;
  if s.cupo <= used then raise exception using errcode = 'P0001', message = 'NG_SESSION_FULL'; end if;
  update public.ng_inscripciones set estado='confirmada', posicion_espera=null, updated_at=now() where id=r.id returning * into r;
  insert into public.ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor) values(r.id,r.sesion_id,'confirmada',p_actor);
  return r;
end $$;

create or replace function public.ng_waitlist_registration(p_registration_id uuid, p_actor text default null)
returns public.ng_inscripciones
language plpgsql security definer set search_path = public
as $$
declare r public.ng_inscripciones; next_position integer;
begin
  select * into r from public.ng_inscripciones where id=p_registration_id for update;
  if not found then raise exception using errcode='P0002', message='NG_REGISTRATION_NOT_FOUND'; end if;
  if r.estado='cancelada' then raise exception using errcode='P0001', message='NG_REGISTRATION_CANCELLED'; end if;
  if r.estado='en_espera' then return r; end if;
  if r.sesion_id is null then raise exception using errcode='P0001', message='NG_ASSIGNMENT_REQUIRED'; end if;
  perform 1 from public.ng_sesiones where id=r.sesion_id for update;
  select coalesce(max(posicion_espera),0)+1 into next_position from public.ng_inscripciones where sesion_id=r.sesion_id and estado='en_espera';
  update public.ng_inscripciones set estado='en_espera', posicion_espera=next_position, updated_at=now() where id=r.id returning * into r;
  insert into public.ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor,detalle) values(r.id,r.sesion_id,'lista_espera',p_actor,jsonb_build_object('posicion',next_position));
  return r;
end $$;

create or replace function public.ng_promote_waitlist(p_session_id uuid, p_actor text default null)
returns public.ng_inscripciones
language plpgsql security definer set search_path = public
as $$
declare r public.ng_inscripciones; s public.ng_sesiones; used integer; old_position integer;
begin
  select * into s from public.ng_sesiones where id=p_session_id for update;
  if not found then raise exception using errcode='P0002', message='NG_SESSION_NOT_FOUND'; end if;
  select count(*) into used from public.ng_inscripciones where sesion_id=s.id and estado='confirmada';
  if s.cupo <= used then return null; end if;
  select * into r from public.ng_inscripciones where sesion_id=s.id and estado='en_espera' order by posicion_espera nulls last, created_at for update skip locked limit 1;
  if not found then return null; end if;
  old_position := r.posicion_espera;
  update public.ng_inscripciones set estado='confirmada',posicion_espera=null,updated_at=now() where id=r.id returning * into r;
  update public.ng_inscripciones set posicion_espera=posicion_espera-1,updated_at=now() where sesion_id=s.id and estado='en_espera' and posicion_espera>coalesce(old_position,0);
  insert into public.ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor) values(r.id,r.sesion_id,'promovida_desde_espera',p_actor);
  return r;
end $$;

create or replace function public.ng_cancel_registration(p_registration_id uuid, p_actor text default null, p_reason text default null)
returns public.ng_inscripciones
language plpgsql security definer set search_path = public
as $$
declare r public.ng_inscripciones; old_state text; old_position integer;
begin
  select * into r from public.ng_inscripciones where id=p_registration_id for update;
  if not found then raise exception using errcode='P0002', message='NG_REGISTRATION_NOT_FOUND'; end if;
  if r.estado='cancelada' then return r; end if;
  old_state := r.estado; old_position := r.posicion_espera;
  update public.ng_inscripciones set estado='cancelada',posicion_espera=null,cancel_reason=nullif(trim(coalesce(p_reason,'')),''),updated_at=now() where id=r.id returning * into r;
  if old_state='en_espera' then update public.ng_inscripciones set posicion_espera=posicion_espera-1,updated_at=now() where sesion_id=r.sesion_id and estado='en_espera' and posicion_espera>old_position; end if;
  insert into public.ng_inscripcion_eventos(inscripcion_id,sesion_id,tipo,actor,detalle) values(r.id,r.sesion_id,'cancelada',p_actor,jsonb_build_object('motivo',p_reason));
  if old_state='confirmada' and r.sesion_id is not null then perform public.ng_promote_waitlist(r.sesion_id,p_actor); end if;
  return r;
end $$;

revoke all on table public.ng_inscripciones, public.ng_inscripcion_participantes, public.ng_inscripcion_eventos from anon, authenticated;
grant all on table public.ng_inscripciones, public.ng_inscripcion_participantes, public.ng_inscripcion_eventos to service_role;
revoke all on function public.ng_confirm_registration(uuid,text), public.ng_waitlist_registration(uuid,text), public.ng_promote_waitlist(uuid,text), public.ng_cancel_registration(uuid,text,text) from public, anon, authenticated;
grant execute on function public.ng_confirm_registration(uuid,text), public.ng_waitlist_registration(uuid,text), public.ng_promote_waitlist(uuid,text), public.ng_cancel_registration(uuid,text,text) to service_role;
