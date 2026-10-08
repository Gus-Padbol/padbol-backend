-- WhatsApp assistant: persistencia local de temas, respuestas, configuración,
-- operadores autorizados y registro de clasificación.
-- NO aplica envíos, credenciales ni mensajes. Aplicar primero sólo en entorno local.

begin;

create table if not exists public.whatsapp_assistant_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now(),
  constraint whatsapp_assistant_config_key_check
    check (key ~ '^[a-z0-9_]{1,80}$'),
  constraint whatsapp_assistant_config_value_check
    check (length(value) between 1 and 2048)
);

comment on table public.whatsapp_assistant_config is
  'Configuración operativa del asistente WhatsApp. Nunca guarda tokens ni secretos.';

create table if not exists public.whatsapp_assistant_topics (
  slug text primary key,
  title_es text not null,
  title_en text not null,
  priority integer not null default 0,
  active boolean not null default true,
  constraint whatsapp_assistant_topics_slug_check
    check (slug ~ '^[a-z0-9_]{1,60}$'),
  constraint whatsapp_assistant_topics_title_check
    check (length(trim(title_es)) between 1 and 160 and length(trim(title_en)) between 1 and 160)
);

comment on table public.whatsapp_assistant_topics is
  'Temas/clasificación del asistente. Fuente de la planilla de respuestas.';

create table if not exists public.whatsapp_assistant_responses (
  id uuid primary key default gen_random_uuid(),
  topic_slug text not null references public.whatsapp_assistant_topics(slug) on delete cascade,
  locale text not null default 'es',
  body text not null,
  active boolean not null default true,
  updated_at timestamptz not null default now(),
  constraint whatsapp_assistant_responses_locale_check
    check (locale in ('es', 'en')),
  constraint whatsapp_assistant_responses_body_check
    check (length(trim(body)) between 1 and 4096),
  unique (topic_slug, locale)
);

comment on table public.whatsapp_assistant_responses is
  'Respuestas seguras aprobadas por tema e idioma. Prohibido precios/condiciones.';

create table if not exists public.whatsapp_assistant_operators (
  id uuid primary key default gen_random_uuid(),
  display_name text not null,
  external_id text not null,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  constraint whatsapp_assistant_operators_external_id_unique unique (external_id),
  constraint whatsapp_assistant_operators_display_name_check
    check (length(trim(display_name)) between 1 and 160),
  constraint whatsapp_assistant_operators_external_id_check
    check (length(trim(external_id)) between 1 and 160)
);

comment on table public.whatsapp_assistant_operators is
  'Operadores autorizados para intervenir/derivar. No guarda secretos de autorización.';

create table if not exists public.whatsapp_assistant_classifications (
  id uuid primary key default gen_random_uuid(),
  inbound_message_id uuid not null references public.whatsapp_inbound_messages(id) on delete cascade,
  tenant_id uuid not null references public.whatsapp_tenants(id) on delete cascade,
  topic_slug text,
  disposition text not null,
  created_at timestamptz not null default now(),
  constraint whatsapp_assistant_classifications_disposition_check
    check (disposition in ('reply', 'handoff', 'held', 'spam', 'invalid'))
);

comment on table public.whatsapp_assistant_classifications is
  'Registro del resultado de clasificación por mensaje entrante (sin cuerpo ni texto sensible).';

alter table public.whatsapp_assistant_config enable row level security;
alter table public.whatsapp_assistant_topics enable row level security;
alter table public.whatsapp_assistant_responses enable row level security;
alter table public.whatsapp_assistant_operators enable row level security;
alter table public.whatsapp_assistant_classifications enable row level security;

revoke all on table public.whatsapp_assistant_config from anon, authenticated;
revoke all on table public.whatsapp_assistant_topics from anon, authenticated;
revoke all on table public.whatsapp_assistant_responses from anon, authenticated;
revoke all on table public.whatsapp_assistant_operators from anon, authenticated;
revoke all on table public.whatsapp_assistant_classifications from anon, authenticated;

grant all on table public.whatsapp_assistant_config to service_role;
grant all on table public.whatsapp_assistant_topics to service_role;
grant all on table public.whatsapp_assistant_responses to service_role;
grant all on table public.whatsapp_assistant_operators to service_role;
grant all on table public.whatsapp_assistant_classifications to service_role;

commit;
