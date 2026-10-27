-- Read-only readiness for the runtime's existing 2026-09-09.1 contract.
-- Check actual capabilities. Do not enable delivery, change roles, or seed data.
begin;
create or replace function public.match_backend_release_readiness()
returns jsonb
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
with required_tables(name) as (
  values ('user_roles'), ('jugadores_perfil'), ('sedes'), ('torneos'), ('reservas'), ('canchas'),
    ('crm_contacts'), ('crm_conversations'), ('crm_channel_attempts'), ('crm_replies'), ('crm_activities'),
    ('whatsapp_tenants'), ('whatsapp_tenant_channels'), ('whatsapp_inbound_messages'), ('whatsapp_outbox'),
    ('whatsapp_assistant_operators'), ('whatsapp_assistant_classifications'), ('whatsapp_assistant_config'),
    ('push_tokens'), ('push_notification_preferences'), ('push_delivery_jobs'), ('push_delivery_attempts'),
    ('notificaciones_admin_log')
), required_columns(table_name, column_name) as (
  values ('user_roles','user_id'), ('user_roles','email'), ('user_roles','role'), ('user_roles','alcance'),
    ('user_roles','sede_id'), ('user_roles','organizacion_id'), ('user_roles','pais'), ('user_roles','provincia'),
    ('user_roles','ciudad'), ('user_roles','nombre'), ('user_roles','torneos_oficiales_habilitados'),
    ('jugadores_perfil','created_at'), ('sedes','pais'), ('sedes','estado'),
    ('torneos','estado'), ('torneos','fecha_fin'), ('torneos','deporte'),
    ('reservas','estado'), ('reservas','fecha'), ('reservas','created_at'), ('reservas','deporte'), ('reservas','cancha_id'),
    ('canchas','deporte'), ('push_tokens','expo_push_token'), ('push_tokens','device_id'), ('push_tokens','revoked_at'),
    ('push_tokens','last_seen_at'), ('push_tokens','language'),
    ('notificaciones_admin_log','estado'), ('notificaciones_admin_log','idempotency_key'), ('notificaciones_admin_log','push_job_id')
), required_functions(signature) as (
  values ('public.register_mobile_push_token_v2(uuid,text,text,text,text)'),
    ('public.revoke_mobile_push_token(uuid,text,text)'),
    ('public.set_mobile_push_preferences(uuid,boolean,boolean,text)')
), private_tables(name) as (
  values ('whatsapp_tenants'), ('whatsapp_tenant_channels'), ('whatsapp_inbound_messages'), ('whatsapp_outbox'),
    ('whatsapp_assistant_operators'), ('whatsapp_assistant_classifications'), ('whatsapp_assistant_config'),
    ('push_delivery_jobs'), ('push_delivery_attempts')
), failures(check_name) as (
  select 'table:' || name from required_tables where to_regclass('public.' || name) is null
  union all
  select 'service_read:' || name from required_tables
    where to_regclass('public.' || name) is not null
      and not has_table_privilege('service_role', to_regclass('public.' || name), 'SELECT')
  union all
  select 'column:' || r.table_name || '.' || r.column_name from required_columns r
    where not exists (select 1 from pg_attribute a
      where a.attrelid = to_regclass('public.' || r.table_name)
        and a.attname = r.column_name and a.attnum > 0 and not a.attisdropped)
  union all
  select 'function:' || signature from required_functions where to_regprocedure(signature) is null
  union all
  select 'service_execute:' || signature from required_functions
    where to_regprocedure(signature) is not null
      and not has_function_privilege('service_role', to_regprocedure(signature), 'EXECUTE')
  union all
  select 'private_rls:' || p.name from private_tables p
    join pg_class c on c.oid = to_regclass('public.' || p.name)
    where not c.relrowsecurity
  union all
  select 'private_grant:' || name from private_tables
    where to_regclass('public.' || name) is not null
      and (has_table_privilege('anon', to_regclass('public.' || name), 'SELECT')
        or has_table_privilege('authenticated', to_regclass('public.' || name), 'SELECT'))
)
select jsonb_build_object(
  'release', '2026-09-09.1',
  'ready', not exists (select 1 from failures),
  'missing_checks', coalesce((select jsonb_agg(check_name order by check_name) from failures), '[]'::jsonb)
);
$$;
revoke all on function public.match_backend_release_readiness() from public, anon, authenticated;
grant execute on function public.match_backend_release_readiness() to service_role;
notify pgrst, 'reload schema';
commit;
