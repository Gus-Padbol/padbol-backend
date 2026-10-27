-- Align the deployed legacy UUID table with the public request API without
-- changing identifiers, deleting requests, granting access or enabling sends.
begin;
alter table public.solicitudes_licencia
 add column if not exists club_nombre text,
 add column if not exists responsable_nombre text,
 add column if not exists nombre_club text,
 add column if not exists nombre_responsable text,
 add column if not exists club_direccion text,
 add column if not exists provincia_estado text,
 add column if not exists club_telefono text,
 add column if not exists club_email text,
 add column if not exists club_web text,
 add column if not exists deportes_canchas jsonb,
 add column if not exists responsable_cargo text,
 add column if not exists nombre_legal text,
 add column if not exists numero_fiscal text,
 add column if not exists fiscal_misma_que_club boolean not null default true,
 add column if not exists direccion_fiscal text,
 add column if not exists pais_fiscal text,
 add column if not exists updated_at timestamptz not null default now(),
 add column if not exists whatsapp_followup_consent boolean not null default false,
 add column if not exists whatsapp_followup_consent_source text,
 add column if not exists whatsapp_followup_consent_version text,
 add column if not exists whatsapp_followup_consent_text text,
 add column if not exists whatsapp_followup_consent_at timestamptz,
 add column if not exists idempotency_key text,
 add column if not exists idempotency_payload_hash text;
-- WhatsApp is optional on the current public intake; absence is not consent.
alter table public.solicitudes_licencia alter column whatsapp drop not null;
update public.solicitudes_licencia set
 club_nombre=coalesce(club_nombre,nombre_club),
 nombre_club=coalesce(club_nombre,nombre_club),
 responsable_nombre=coalesce(responsable_nombre,nombre_responsable),
 nombre_responsable=coalesce(responsable_nombre,nombre_responsable)
where club_nombre is null or nombre_club is null or responsable_nombre is null or nombre_responsable is null;
create or replace function public.license_request_sync_names() returns trigger
language plpgsql set search_path=public,pg_temp as $$
begin
 if TG_OP='UPDATE' then
  if new.club_nombre is distinct from old.club_nombre then new.nombre_club:=new.club_nombre;
  elsif new.nombre_club is distinct from old.nombre_club then new.club_nombre:=new.nombre_club; end if;
  if new.responsable_nombre is distinct from old.responsable_nombre then new.nombre_responsable:=new.responsable_nombre;
  elsif new.nombre_responsable is distinct from old.nombre_responsable then new.responsable_nombre:=new.nombre_responsable; end if;
 end if;
 new.club_nombre:=coalesce(new.club_nombre,new.nombre_club);
 new.nombre_club:=new.club_nombre;
 new.responsable_nombre:=coalesce(new.responsable_nombre,new.nombre_responsable);
 new.nombre_responsable:=new.responsable_nombre;
 return new;
end $$;
drop trigger if exists license_request_sync_names on public.solicitudes_licencia;
create trigger license_request_sync_names before insert or update of club_nombre,nombre_club,responsable_nombre,nombre_responsable
 on public.solicitudes_licencia for each row execute function public.license_request_sync_names();
create unique index if not exists uq_solicitudes_licencia_idempotency_key on public.solicitudes_licencia(idempotency_key) where idempotency_key is not null;
do $$ begin
 if not exists(select 1 from pg_constraint where conrelid='public.solicitudes_licencia'::regclass and conname='solicitudes_licencia_idempotency_key_check') then
  alter table public.solicitudes_licencia add constraint solicitudes_licencia_idempotency_key_check check(idempotency_key is null or idempotency_key ~ '^[a-f0-9]{64}$');
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.solicitudes_licencia'::regclass and conname='solicitudes_licencia_idempotency_payload_hash_check') then
  alter table public.solicitudes_licencia add constraint solicitudes_licencia_idempotency_payload_hash_check check(idempotency_payload_hash is null or idempotency_payload_hash ~ '^[a-f0-9]{64}$');
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.solicitudes_licencia'::regclass and conname='solicitudes_licencia_idempotency_pair_check') then
  alter table public.solicitudes_licencia add constraint solicitudes_licencia_idempotency_pair_check check((idempotency_key is null)=(idempotency_payload_hash is null)) not valid;
 end if;
 if not exists(select 1 from pg_constraint where conrelid='public.solicitudes_licencia'::regclass and conname='solicitudes_licencia_whatsapp_followup_consent_check') then
  alter table public.solicitudes_licencia add constraint solicitudes_licencia_whatsapp_followup_consent_check check(
   (not whatsapp_followup_consent and whatsapp_followup_consent_source is null and whatsapp_followup_consent_version is null and whatsapp_followup_consent_text is null and whatsapp_followup_consent_at is null)
   or (whatsapp_followup_consent and whatsapp_followup_consent_source is not null and whatsapp_followup_consent_version is not null and whatsapp_followup_consent_text is not null and length(trim(whatsapp_followup_consent_source)) between 1 and 120 and whatsapp_followup_consent_version='whatsapp-followup-v1' and length(whatsapp_followup_consent_text) between 1 and 1000 and whatsapp_followup_consent_at is not null));
 end if;
end $$;
-- Retain existing private access policy; this migration introduces no grants.
notify pgrst,'reload schema';
commit;
