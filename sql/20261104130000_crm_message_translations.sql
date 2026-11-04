create table if not exists public.crm_message_translations (
  cache_key text primary key,
  source_hash text not null,
  source_language text,
  target_language text not null default 'es',
  translated_text text not null,
  provider text,
  model text,
  created_at timestamptz not null default now()
);
revoke all on public.crm_message_translations from public, anon, authenticated;
grant select, insert, update on public.crm_message_translations to service_role;
