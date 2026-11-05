-- Candidate only. Apply after the crm_space_requests table exists. No storage deletion is performed by this migration.

  alter table public.crm_space_requests add column if not exists retention_expires_at timestamptz;
  update public.crm_space_requests set retention_expires_at=created_at + interval '90 days' where retention_expires_at is null;
  alter table public.crm_space_requests alter column retention_expires_at set default (now() + interval '90 days');
  alter table public.crm_space_requests alter column retention_expires_at set not null;
  alter table public.crm_space_requests add column if not exists project_active_hold boolean not null default false;
  alter table public.crm_space_requests add column if not exists project_hold_reason text;
  alter table public.crm_space_requests add column if not exists project_hold_set_by text;
  alter table public.crm_space_requests add column if not exists project_hold_set_at timestamptz;
  alter table public.crm_space_requests add column if not exists media_deleted_at timestamptz;
  alter table public.crm_space_requests add column if not exists metadata_policy text not null default 'legacy_unprocessed';
  do $privacy$
  begin
    if not exists (select 1 from pg_constraint where conname='crm_space_requests_active_hold_reason' and conrelid='public.crm_space_requests'::regclass) then
      alter table public.crm_space_requests add constraint crm_space_requests_active_hold_reason check (
        project_active_hold=false or (nullif(trim(project_hold_reason),'') is not null and nullif(trim(project_hold_set_by),'') is not null and project_hold_set_at is not null and media_deleted_at is null)
      );
    end if;
  end $privacy$;
  create index if not exists crm_space_requests_retention_idx on public.crm_space_requests(retention_expires_at) where project_active_hold=false and media_deleted_at is null;
  alter table public.crm_space_requests enable row level security;
  revoke all on public.crm_space_requests from public, anon, authenticated;
  grant select, insert, update on public.crm_space_requests to service_role;
