BEGIN;
create extension if not exists pgcrypto;
-- Fail without mutation if legacy duplicates need individual review.
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM public.push_tokens GROUP BY user_id,platform,device_id HAVING count(*) > 1) THEN RAISE EXCEPTION 'duplicate_push_installations_require_review'; END IF;
END $$;
CREATE UNIQUE INDEX IF NOT EXISTS push_tokens_installation_uidx ON public.push_tokens(user_id,platform,device_id);
ALTER TABLE public.push_tokens ALTER COLUMN token DROP NOT NULL;
ALTER TABLE public.push_tokens DROP CONSTRAINT IF EXISTS push_tokens_user_id_platform_key;
ALTER TABLE public.push_tokens DROP CONSTRAINT IF EXISTS push_tokens_user_id_expo_push_token_key;
create table if not exists public.push_token_audit (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  device_id text,
  platform text,
  token_fingerprint text,
  action text not null check (action in ('registered', 'rotated', 'revoked', 'reassigned', 'invalidated')),
  reason text,
  created_at timestamptz not null default now()
);

create index if not exists push_token_audit_user_created_idx
  on public.push_token_audit (user_id, created_at desc);

create table if not exists public.push_preference_audit (
  id bigserial primary key,
  user_id uuid references auth.users(id) on delete set null,
  transactional_enabled boolean not null,
  marketing_enabled boolean not null,
  source text not null default 'api',
  created_at timestamptz not null default now()
);

create or replace function public.register_mobile_push_token(
  p_user_id uuid,
  p_token text,
  p_platform text,
  p_device_id text
) returns public.push_tokens
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_existing public.push_tokens;
  v_row public.push_tokens;
  v_token text := trim(coalesce(p_token, ''));
  v_platform text := lower(trim(coalesce(p_platform, '')));
  v_device_id text := trim(coalesce(p_device_id, ''));
begin
  if p_user_id is null or v_token = '' or v_device_id = '' or v_platform not in ('ios', 'android') then
    raise exception 'invalid_push_registration';
  end if;

  perform pg_advisory_xact_lock(hashtextextended(v_token, 0));

  select * into v_existing
    from public.push_tokens
   where user_id = p_user_id and platform = v_platform and device_id = v_device_id
   for update;

  if v_existing.id is not null and v_existing.expo_push_token is distinct from v_token then
    insert into public.push_token_audit
      (user_id, device_id, platform, token_fingerprint, action, reason)
    values
      (p_user_id, v_device_id, v_platform,
       encode(extensions.digest(coalesce(v_existing.expo_push_token, ''), 'sha256'), 'hex'),
       'rotated', 'token_rotation');
  end if;

  insert into public.push_token_audit
    (user_id, device_id, platform, token_fingerprint, action, reason)
  select user_id, device_id, platform,
         encode(extensions.digest(coalesce(expo_push_token, ''), 'sha256'), 'hex'),
         'reassigned', 'token_claimed_by_authenticated_installation'
    from public.push_tokens
   where expo_push_token = v_token
     and (user_id, platform, device_id) is distinct from (p_user_id, v_platform, v_device_id);

  update public.push_tokens set enabled = false, revoked_at = now(), updated_at = now(), invalidation_reason = 'token_claimed_by_authenticated_installation'
   where expo_push_token = v_token
     and (user_id, platform, device_id) is distinct from (p_user_id, v_platform, v_device_id);

  insert into public.push_tokens
    (user_id, expo_push_token, platform, device_id, enabled, created_at, updated_at,
     last_seen_at, revoked_at, invalidated_at, invalidation_reason)
  values
    (p_user_id, v_token, v_platform, v_device_id, true, now(), now(), now(), null, null, null)
  on conflict (user_id, platform, device_id) do update
    set expo_push_token = excluded.expo_push_token,
        enabled = true,
        updated_at = now(),
        last_seen_at = now(),
        revoked_at = null,
        invalidated_at = null,
        invalidation_reason = null
  returning * into v_row;

  insert into public.push_token_audit
    (user_id, device_id, platform, token_fingerprint, action, reason)
  values
    (p_user_id, v_device_id, v_platform, encode(extensions.digest(v_token, 'sha256'), 'hex'),
     'registered', case when v_existing.id is null then 'new_installation' else 'refresh' end);

  insert into public.push_notification_preferences (user_id)
  values (p_user_id)
  on conflict (user_id) do nothing;

  return v_row;
end
$$;

create or replace function public.revoke_mobile_push_token(
  p_user_id uuid,
  p_token text default null,
  p_device_id text default null
) returns integer
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_count integer := 0;
begin
  if p_user_id is null or (nullif(trim(coalesce(p_token, '')), '') is null and nullif(trim(coalesce(p_device_id, '')), '') is null) then
    raise exception 'push_token_or_device_required';
  end if;

  with candidates as (
    select * from public.push_tokens
     where user_id = p_user_id
       and (nullif(trim(coalesce(p_token, '')), '') is null or expo_push_token = trim(p_token))
       and (nullif(trim(coalesce(p_device_id, '')), '') is null or device_id = trim(p_device_id))
       and enabled = true
     for update
  ), audited as (
    insert into public.push_token_audit
      (user_id, device_id, platform, token_fingerprint, action, reason)
    select user_id, device_id, platform,
           encode(extensions.digest(coalesce(expo_push_token, ''), 'sha256'), 'hex'),
           'revoked', 'authenticated_user_request'
      from candidates
    returning 1
  )
  update public.push_tokens p
     set enabled = false,
         revoked_at = now(),
         updated_at = now(),
         invalidation_reason = 'user_revoked'
   where p.id in (select id from candidates);

  get diagnostics v_count = row_count;
  return v_count;
end
$$;

create or replace function public.set_mobile_push_preferences(
  p_user_id uuid,
  p_transactional_enabled boolean,
  p_marketing_enabled boolean,
  p_source text default 'api'
) returns public.push_notification_preferences
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_row public.push_notification_preferences;
begin
  if p_user_id is null or p_transactional_enabled is null or p_marketing_enabled is null then
    raise exception 'invalid_push_preferences';
  end if;

  insert into public.push_notification_preferences
    (user_id, transactional_enabled, marketing_enabled, created_at, updated_at)
  values
    (p_user_id, p_transactional_enabled, p_marketing_enabled, now(), now())
  on conflict (user_id) do update
    set transactional_enabled = excluded.transactional_enabled,
        marketing_enabled = excluded.marketing_enabled,
        updated_at = now()
  returning * into v_row;

  insert into public.push_preference_audit
    (user_id, transactional_enabled, marketing_enabled, source)
  values
    (p_user_id, p_transactional_enabled, p_marketing_enabled,
     left(coalesce(nullif(trim(p_source), ''), 'api'), 80));

  return v_row;
end
$$;


CREATE OR REPLACE FUNCTION public.register_mobile_push_token_v2(p_user_id uuid,p_token text,p_platform text,p_device_id text,p_language text)
RETURNS public.push_tokens LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE v_row public.push_tokens;
BEGIN
 IF p_language IS NULL OR p_language NOT IN ('es','en','it','ro','cs','de','fr','pt-BR','pt-PT','ar','fa','nl-BE','nl-NL','hu','sv','af','el','he','pl','uk') THEN RAISE EXCEPTION 'invalid_push_language'; END IF;
 v_row := public.register_mobile_push_token(p_user_id,p_token,p_platform,p_device_id);
 UPDATE public.push_tokens SET language=p_language WHERE id=v_row.id RETURNING * INTO v_row;
 RETURN v_row;
END $$;
ALTER TABLE public.push_token_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_preference_audit ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.push_token_audit,public.push_preference_audit FROM anon,authenticated;
GRANT ALL ON public.push_token_audit,public.push_preference_audit TO service_role;
GRANT USAGE,SELECT ON SEQUENCE public.push_token_audit_id_seq,public.push_preference_audit_id_seq TO service_role;
REVOKE ALL ON FUNCTION public.register_mobile_push_token(uuid,text,text,text),public.register_mobile_push_token_v2(uuid,text,text,text,text),public.revoke_mobile_push_token(uuid,text,text),public.set_mobile_push_preferences(uuid,boolean,boolean,text) FROM public,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.register_mobile_push_token(uuid,text,text,text),public.register_mobile_push_token_v2(uuid,text,text,text,text),public.revoke_mobile_push_token(uuid,text,text),public.set_mobile_push_preferences(uuid,boolean,boolean,text) TO service_role;
NOTIFY pgrst,'reload schema';
COMMIT;
