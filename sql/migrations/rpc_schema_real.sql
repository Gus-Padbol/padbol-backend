-- DDL REAL: todas las tablas de public (metadata, sin filas) + constraints en orden.
create table if not exists public.academy_certificates (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  course_id integer not null,
  course_title text,
  student_name text,
  certificate_type text not null,
  issued_at timestamp with time zone default now() not null
);
create table if not exists public.academy_enrollments (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  course_id integer not null,
  product_id integer,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.academy_payment_grants (
  session_id text not null,
  email text not null,
  product_code text not null,
  amount_total bigint not null,
  currency text not null,
  event_id text not null,
  payment_status text not null,
  livemode boolean not null,
  created_at timestamp with time zone default now() not null,
  user_id uuid
);
create table if not exists public.academy_profiles (
  id uuid not null,
  full_name text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.academy_progress (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  course_id integer not null,
  lesson_id integer,
  completed_at timestamp with time zone default now() not null
);
create table if not exists public.academy_quiz_attempts (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  course_id integer not null,
  quiz_id integer not null,
  score integer,
  total integer,
  passed boolean,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.admin_push_notifications (
  id uuid default gen_random_uuid() not null,
  admin_user_id uuid not null,
  admin_email text,
  admin_role text not null,
  segment jsonb default '{}'::jsonb not null,
  segment_type text not null,
  title text not null,
  body text not null,
  recipients integer default 0 not null,
  sent_count integer default 0 not null,
  status text default 'sent'::text not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.app_launch_events (
  id bigint not null,
  path text not null,
  mode text not null,
  referrer text,
  created_at timestamp with time zone default now() not null,
  detail jsonb
);
create table if not exists public.busca_dupla_invitacion (
  id bigint not null,
  torneo_id bigint,
  from_user_id uuid,
  to_user_id uuid,
  estado text default 'pendiente'::text,
  created_at timestamp with time zone default now()
);
create table if not exists public.busca_dupla_torneo (
  id bigint not null,
  torneo_id bigint,
  user_id uuid,
  created_at timestamp with time zone default now()
);
create table if not exists public.cancelaciones_jugador (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  reserva_id bigint,
  sede_id integer,
  horas_anticipacion numeric,
  penaliza boolean default true,
  created_at timestamp with time zone default now()
);
create table if not exists public.canchas (
  id bigint not null,
  sede_id bigint,
  nombre text not null,
  estado text default 'activa'::text,
  created_at timestamp with time zone default now(),
  descripcion text,
  orden integer,
  deporte text default 'padbol'::text not null,
  deporte_personalizado text,
  cantidad_jugadores integer,
  modalidad_custom text,
  duracion_sugerida_min integer,
  observacion_custom text
);
create table if not exists public.canchas_por_deporte (
  id integer not null,
  sede_id integer,
  deporte text not null,
  cantidad integer default 1 not null,
  activo boolean default true,
  created_at timestamp with time zone default now()
);
create table if not exists public.clases (
  id bigint not null,
  sede_id bigint,
  profesor_id bigint,
  cancha_id bigint,
  deporte text not null,
  titulo text not null,
  descripcion text,
  tipo text not null,
  cupo_maximo integer default 4,
  duracion_minutos integer default 60,
  precio numeric(10,2) not null,
  activo boolean default true,
  created_at timestamp with time zone default now(),
  horas_cancelacion integer default 24
);
create table if not exists public.clases_horarios (
  id bigint not null,
  clase_id bigint,
  dia_semana integer,
  hora_inicio time without time zone not null,
  hora_fin time without time zone not null
);
create table if not exists public.clases_reservas (
  id integer not null,
  clase_id bigint,
  user_id uuid,
  email text,
  created_at timestamp with time zone default now()
);
create table if not exists public.clasificaciones (
  id bigint not null,
  equipo_id bigint,
  torneo_origen_id bigint,
  torneo_destino_id bigint,
  posicion integer not null,
  created_at timestamp without time zone default now()
);
create table if not exists public.clientes (
  id uuid default uuid_generate_v4() not null,
  nombre text not null,
  email text not null,
  whatsapp text not null,
  pais text not null,
  ddi text not null,
  created_at timestamp without time zone default now(),
  rol text default '''user'''::text,
  lateralidad text,
  nivel_juego text
);
create table if not exists public.comunidad_bloqueos (
  id bigint not null,
  blocker_user_id uuid not null,
  blocked_user_id uuid not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.comunidad_comentarios (
  id bigint not null,
  publicacion_id bigint not null,
  autor_user_id uuid not null,
  texto text not null,
  estado text default 'activo'::text not null,
  idempotency_key text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.comunidad_denuncias (
  id bigint not null,
  denunciante_user_id uuid not null,
  objeto_tipo text not null,
  objeto_id bigint not null,
  motivo text not null,
  estado text default 'pendiente'::text not null,
  created_at timestamp with time zone default now() not null,
  revisada_at timestamp with time zone,
  revisada_por uuid,
  resolucion_nota text
);
create table if not exists public.comunidad_medios (
  id bigint not null,
  publicacion_id bigint not null,
  tipo text not null,
  storage_path text not null,
  mime_type text not null,
  bytes bigint,
  ancho integer,
  alto integer,
  duracion_ms integer,
  poster_path text,
  orden smallint default 0 not null,
  estado text default 'listo'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.comunidad_publicaciones (
  id bigint not null,
  autor_user_id uuid not null,
  texto text not null,
  imagen_url text,
  sede_id integer,
  evento_ref text,
  visibilidad text default 'publica'::text not null,
  estado text default 'activa'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.comunidad_reacciones (
  id bigint not null,
  publicacion_id bigint not null,
  user_id uuid not null,
  tipo text default 'like'::text not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.comunidad_seguimientos (
  id bigint not null,
  follower_user_id uuid not null,
  following_user_id uuid not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.config_puntos (
  id integer not null,
  clave text not null,
  valor jsonb not null,
  updated_at timestamp without time zone default now()
);
create table if not exists public.confirmations (
  id uuid default gen_random_uuid() not null,
  reservation_id uuid not null,
  email_sent boolean default false,
  email_sent_at timestamp without time zone,
  whatsapp_sent boolean default false,
  whatsapp_sent_at timestamp without time zone,
  reminder_sent boolean default false,
  reminder_sent_at timestamp without time zone,
  created_at timestamp without time zone default CURRENT_TIMESTAMP,
  updated_at timestamp without time zone default CURRENT_TIMESTAMP
);
create table if not exists public.content_ad_slots (
  id bigint not null,
  deporte text not null,
  slot_key text default 'app_general'::text not null,
  titulo text default ''::text not null,
  media_type text default 'image'::text not null,
  imagen_url text,
  video_url text,
  poster_url text,
  destino_url text,
  activo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.content_editor_drafts (
  id bigint not null,
  content_type text not null,
  deporte text not null,
  item_key text not null,
  payload jsonb default '{}'::jsonb not null,
  status text default 'draft'::text not null,
  review_note text,
  updated_by uuid,
  submitted_at timestamp with time zone,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  published_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.content_meta_audit (
  id bigint not null,
  import_id uuid not null,
  actor_id uuid not null,
  action text not null,
  details jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.content_meta_daily_sources (
  account_id text not null,
  level text not null,
  day date not null,
  import_id uuid not null
);
create table if not exists public.content_meta_imports (
  id uuid not null,
  account_id text not null,
  level text not null,
  sha256 text not null,
  filename text not null,
  raw_csv text not null,
  source text not null,
  timezone text not null,
  currency text not null,
  exported_at text not null,
  exported_precision text not null,
  partial_day date,
  coverage text default ''::text not null,
  from_day date not null,
  to_day date not null,
  row_count integer not null,
  status text default 'preview'::text not null,
  created_by uuid not null,
  created_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone default (now() + '24:00:00'::interval) not null,
  committed_by uuid,
  committed_at timestamp with time zone
);
create table if not exists public.content_meta_monitor_alerts (
  account_id text not null,
  until_day date not null,
  entity_id text not null,
  kind text not null,
  details jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.content_meta_rows (
  import_id uuid not null,
  day date not null,
  entity_id text not null,
  campaign_id text not null,
  campaign_name text not null,
  adset_id text,
  adset_name text,
  ad_id text,
  entity_name text not null,
  spend numeric(24,8),
  impressions bigint,
  clicks bigint,
  link_clicks bigint,
  reach_daily bigint,
  results numeric(24,8),
  result_indicator text,
  attribution text,
  actions jsonb default '{}'::jsonb not null
);
create table if not exists public.content_meta_sync_events (
  id bigint not null,
  account_id text not null,
  until_day date not null,
  event_type text not null,
  details jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.content_meta_sync_runs (
  account_id text not null,
  until_day date not null,
  since_day date not null,
  status text not null,
  actor_id uuid not null,
  attempts integer default 1 not null,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone,
  error_code text,
  comparison jsonb
);
create table if not exists public.content_workspace_access_history (
  id bigint not null,
  user_id uuid not null,
  actor_id uuid not null,
  active boolean not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.content_workspace_coordinators (
  user_id uuid not null,
  email text not null,
  active boolean default true not null,
  granted_by uuid not null,
  granted_at timestamp with time zone default now() not null
);
create table if not exists public.content_workspace_files (
  id uuid not null,
  item_id uuid not null,
  name text not null,
  mime_type text not null,
  size bigint not null,
  storage_path text not null,
  created_by uuid not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.content_workspace_history (
  id bigint not null,
  item_id uuid not null,
  actor_id uuid not null,
  action text not null,
  version bigint not null,
  snapshot jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.content_workspace_items (
  id uuid default gen_random_uuid() not null,
  version bigint default 1 not null,
  payload jsonb not null,
  created_by uuid not null,
  updated_by uuid not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.contratos_sedes (
  id uuid default gen_random_uuid() not null,
  sede_id integer,
  fecha_inicio date not null,
  fecha_vencimiento date,
  referencia text,
  archivo_url text,
  created_at timestamp with time zone default now(),
  storage_path text
);
create table if not exists public.courts (
  id uuid default gen_random_uuid() not null,
  location_id uuid not null,
  name character varying(100) not null,
  court_number integer,
  capacity integer default 4,
  price_ars numeric(10,2),
  price_usd numeric(10,2),
  duration_minutes integer default 90,
  is_active boolean default true,
  created_at timestamp without time zone default CURRENT_TIMESTAMP,
  updated_at timestamp without time zone default CURRENT_TIMESTAMP
);
create table if not exists public.creditos (
  id bigint not null,
  email text not null,
  monto numeric not null,
  sede_id bigint,
  created_at timestamp with time zone default now(),
  vence_at timestamp with time zone,
  usado boolean default false
);
create table if not exists public.crm_ab_assignments (
  id uuid default gen_random_uuid() not null,
  campaign_id uuid not null,
  contact_id uuid not null,
  variant text not null,
  assigned_at timestamp with time zone default now() not null
);
create table if not exists public.crm_ab_campaigns (
  id uuid default gen_random_uuid() not null,
  campaign_key text not null,
  name text not null,
  enabled boolean default false not null,
  automatic_percent integer default 50 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.crm_activities (
  id uuid default gen_random_uuid() not null,
  contact_id uuid not null,
  conversation_id uuid not null,
  activity_type text not null,
  summary text not null,
  outcome text,
  next_step text,
  follow_up_at timestamp with time zone,
  author text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  support_command_hash text
);
create table if not exists public.crm_channel_attempts (
  id uuid default gen_random_uuid() not null,
  attempt_id text not null,
  contact_id uuid,
  channel text not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_commercial_advisor_requests (
  id uuid default gen_random_uuid() not null,
  email text not null,
  name text default ''::text not null,
  territory text default ''::text not null,
  status text default 'pending'::text not null,
  requested_by uuid not null,
  requested_at timestamp with time zone default now() not null,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  review_note text default ''::text not null,
  advisor_id uuid,
  agreed_conditions text default ''::text not null
);
create table if not exists public.crm_commercial_advisors (
  user_id uuid not null,
  email text not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_commercial_case_inbound (
  case_id uuid not null,
  conversation_id uuid not null,
  inbound_event_id uuid not null
);
create table if not exists public.crm_commercial_case_replies (
  case_id uuid not null,
  conversation_id uuid not null,
  reply_id uuid not null
);
create table if not exists public.crm_commercial_case_send_attempts (
  reply_id uuid not null,
  case_id uuid not null,
  status text default 'reserved'::text not null
);
create table if not exists public.crm_commercial_cases (
  id uuid default gen_random_uuid() not null,
  conversation_id uuid not null,
  assigned_user_id uuid not null,
  status text default 'open'::text not null,
  created_at timestamp with time zone default now() not null,
  assignment_version bigint default 0 not null,
  progress_state text default 'nuevo'::text not null,
  commercial_next_step text,
  next_contact_at timestamp with time zone,
  reminder_hours integer[] default ARRAY[24, 8] not null,
  closure_outcome text
);
create table if not exists public.crm_commercial_email_triage (
  conversation_id uuid not null,
  classified_by uuid not null,
  initial_assigned_user_id uuid not null,
  reason text not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_commercial_email_triage_audit (
  id uuid default gen_random_uuid() not null,
  conversation_id uuid not null,
  actor_id uuid not null,
  details jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_commercial_followup_dispatches (
  id uuid default gen_random_uuid() not null,
  plan_id uuid not null,
  conversation_id uuid not null,
  step integer not null,
  claim_token uuid not null,
  status text not null,
  recipient_wa_id text not null,
  template_name text not null,
  language_code text not null,
  body text not null,
  provider_message_id text,
  created_at timestamp with time zone default now() not null,
  accepted_at timestamp with time zone,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.crm_commercial_followup_optouts (
  recipient_wa_id text not null,
  conversation_id uuid not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_commercial_followups (
  id uuid default gen_random_uuid() not null,
  case_type text not null,
  case_id uuid not null,
  conversation_id uuid not null,
  language text not null,
  consent_evidence text not null,
  template_key text not null,
  status text default 'active'::text not null,
  started_by uuid not null,
  started_at timestamp with time zone default now() not null,
  paused_at timestamp with time zone,
  paused_reason text,
  cancelled_at timestamp with time zone,
  cancelled_by uuid,
  dispatch_enabled boolean default false not null,
  recipient_wa_id text,
  dispatch_activated_at timestamp with time zone,
  started_superadmin boolean default false not null,
  consent_revoked_at timestamp with time zone
);
create table if not exists public.crm_commercial_form_cases (
  conversation_id uuid not null,
  assigned_user_id uuid not null,
  assignment_version bigint default 0 not null,
  created_at timestamp with time zone default now() not null,
  progress_state text default 'nuevo'::text not null,
  commercial_next_step text,
  next_contact_at timestamp with time zone,
  reminder_hours integer[] default ARRAY[24, 8] not null,
  closure_outcome text
);
create table if not exists public.crm_commercial_form_send_attempts (
  reply_id uuid not null,
  conversation_id uuid not null,
  actor_id uuid not null,
  status text not null
);
create table if not exists public.crm_commercial_team_activities (
  id uuid default gen_random_uuid() not null,
  case_type text not null,
  case_id uuid not null,
  actor_id uuid not null,
  body text not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_commercial_team_audit (
  id bigint not null,
  actor_id uuid not null,
  action text not null,
  subject_id uuid not null,
  details jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_commercial_team_calls (
  id uuid default gen_random_uuid() not null,
  case_type text not null,
  case_id uuid not null,
  conversation_id uuid not null,
  opened_by uuid not null,
  completed_by uuid,
  status text default 'pending'::text not null,
  situation text,
  discussed text,
  distinguishing text,
  created_at timestamp with time zone default now() not null,
  completed_at timestamp with time zone
);
create table if not exists public.crm_contacts (
  id uuid default gen_random_uuid() not null,
  email_normalized text,
  phone_normalized text,
  nombre text,
  review_needed boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.crm_conversations (
  id uuid default gen_random_uuid() not null,
  contact_id uuid not null,
  source_channel text not null,
  source_ref text not null,
  attempt_id text not null,
  identity_used text,
  estado text default 'nuevo'::text not null,
  operador text,
  derivado boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  origin text not null,
  subject text,
  inbound_body text,
  received_at timestamp with time zone not null,
  funnel_state text default 'awaiting_path'::text not null,
  selected_path text,
  qualification_data jsonb default '{}'::jsonb not null,
  qualification_question_count smallint default 0 not null,
  qualification_status text default 'pending'::text not null,
  next_prompt text,
  prompt_options jsonb default '[]'::jsonb not null,
  next_step text,
  handoff_ready boolean default false not null,
  sede_id bigint,
  assigned_by text,
  assigned_at timestamp with time zone,
  ticket_number bigint not null,
  test_hidden_at timestamp with time zone,
  test_visibility_version bigint default 0 not null,
  email_return_linked_to uuid,
  support_protocol smallint,
  support_last_command_id uuid
);
create table if not exists public.crm_email_provider_receipts (
  reply_id uuid not null,
  provider_message_id text not null,
  rfc_message_id text not null,
  sent_at timestamp with time zone,
  delivered_at timestamp with time zone,
  bounced_at timestamp with time zone,
  failed_at timestamp with time zone,
  complained_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_email_return_pending (
  id text not null,
  external_id text not null,
  sender text not null,
  recipient text not null,
  message_refs text[] not null,
  raw_event jsonb not null,
  payload_hash text not null,
  fallback_origin text not null,
  status text default 'pending'::text not null,
  linked_conversation_id uuid,
  fallback_conversation_id uuid,
  review_reason text,
  last_checked_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_email_return_queue_audit (
  id bigint not null,
  queue_id text not null,
  event_type text not null,
  details jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_form_welcome_dispatches (
  id uuid not null,
  conversation_id uuid not null,
  event_id uuid not null,
  recipient_wa_id text not null,
  language text not null,
  consent jsonb not null,
  template_name text not null,
  body text not null,
  status text not null,
  provider_message_id text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  accepted_at timestamp with time zone
);
create table if not exists public.crm_inbound_events (
  id uuid default gen_random_uuid() not null,
  conversation_id uuid not null,
  source_channel text not null,
  source_ref text not null,
  origin text not null,
  subject text,
  body text,
  received_at timestamp with time zone not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_lead_alerts (
  id uuid default gen_random_uuid() not null,
  case_type text not null,
  case_id uuid not null,
  advisor_id uuid not null,
  cycle integer default 1 not null,
  state text default 'pendiente'::text not null,
  opened_at timestamp with time zone default now() not null,
  due_reminder_at timestamp with time zone not null,
  due_escalation_at timestamp with time zone not null,
  reminded_at timestamp with time zone,
  escalated_at timestamp with time zone,
  resolved_at timestamp with time zone,
  resolution text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.crm_lead_notifications (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  case_type text not null,
  case_id uuid not null,
  conversation_id uuid,
  title text not null,
  body text not null,
  link text,
  read_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_message_translations (
  cache_key text not null,
  source_hash text not null,
  source_language text,
  target_language text default 'es'::text not null,
  translated_text text not null,
  provider text,
  model text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_prospect_campaign_steps (
  id uuid default gen_random_uuid() not null,
  campaign_id uuid not null,
  day integer not null,
  subject text not null,
  body text not null
);
create table if not exists public.crm_prospect_campaigns (
  id uuid default gen_random_uuid() not null,
  name text not null,
  opportunity_type text,
  country text,
  language text default 'en'::text not null,
  status text default 'draft'::text not null,
  daily_limit integer default 25 not null,
  sender_identity text,
  template_key text,
  subject_template text,
  body_template text,
  approved_by uuid,
  approved_at timestamp with time zone,
  created_by text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.crm_prospect_events (
  id bigint not null,
  prospect_id uuid,
  campaign_id uuid,
  message_id uuid,
  event_type text not null,
  detail jsonb default '{}'::jsonb not null,
  actor_id uuid,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_prospect_messages (
  id uuid default gen_random_uuid() not null,
  campaign_id uuid not null,
  prospect_id uuid not null,
  step_day integer not null,
  recipient text,
  subject text,
  body text,
  status text default 'simulated'::text not null,
  idempotency_key text not null,
  provider_message_id text,
  scheduled_at timestamp with time zone,
  sent_at timestamp with time zone,
  error text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_prospect_runs (
  id uuid default gen_random_uuid() not null,
  actor_id uuid,
  source text not null,
  country text not null,
  state text,
  city text,
  sector text,
  opportunity_type text,
  requested_limit integer default 50 not null,
  found_count integer default 0 not null,
  inserted_count integer default 0 not null,
  updated_count integer default 0 not null,
  duplicate_count integer default 0 not null,
  excluded_count integer default 0 not null,
  status text default 'running'::text not null,
  cost_cents integer default 0 not null,
  error text,
  metadata jsonb default '{}'::jsonb not null,
  started_at timestamp with time zone default now() not null,
  finished_at timestamp with time zone
);
create table if not exists public.crm_prospect_settings (
  singleton boolean default true not null,
  enabled boolean default true not null,
  send_enabled boolean default false not null,
  weights jsonb default '{"sport": 25, "activity": 5, "franchise": 5, "locations": 10, "facilities": 15, "investment": 20, "compatibility": 10, "contactability": 5, "representation": 10}'::jsonb not null,
  daily_limit integer default 25 not null,
  updated_by text,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.crm_prospect_suppressions (
  id uuid default gen_random_uuid() not null,
  email text,
  domain text,
  phone text,
  reason text not null,
  source text,
  active boolean default true not null,
  created_by text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_prospect_territories (
  territory_key text not null,
  country text not null,
  region text,
  city text,
  protected boolean default true not null,
  reason text not null,
  source text not null,
  updated_by text,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.crm_prospects (
  id uuid default gen_random_uuid() not null,
  dedupe_key text not null,
  external_source text not null,
  external_id text,
  name text,
  legal_name text,
  trade_name text,
  website text,
  domain text,
  email text,
  phone text,
  address text,
  city text,
  state text,
  country text default 'US'::text not null,
  region text,
  latitude numeric,
  longitude numeric,
  sector text,
  opportunity_type text,
  parent_company text,
  location_type text default 'independent'::text not null,
  locations_count integer,
  activities text,
  facility_notes text,
  contact_name text,
  contact_role text,
  source_url text,
  source_checked_at timestamp with time zone,
  data_status jsonb default '{}'::jsonb not null,
  score integer default 0 not null,
  grade text default 'C'::text not null,
  score_breakdown jsonb default '[]'::jsonb not null,
  status text default 'investigated'::text not null,
  priority text default 'normal'::text not null,
  assigned_user_id uuid,
  crm_contact_id uuid,
  crm_conversation_id uuid,
  crm_case_id uuid,
  is_padel_only boolean default false not null,
  exclusion_reason text,
  contact_block_reason text,
  last_verified_at timestamp with time zone,
  created_by text,
  updated_by text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.crm_replies (
  id uuid default gen_random_uuid() not null,
  conversation_id uuid not null,
  body text not null,
  operador text,
  status text default 'pending'::text not null,
  created_at timestamp with time zone default now() not null,
  provider_message_id text,
  long_email_channel text,
  support_protocol smallint
);
create table if not exists public.crm_space_requests (
  id uuid default gen_random_uuid() not null,
  conversation_id uuid not null,
  contact_id uuid,
  status text default 'recibida'::text not null,
  length_m numeric not null,
  width_m numeric not null,
  covered boolean default false not null,
  height_m numeric,
  desired_courts integer,
  files jsonb default '[]'::jsonb not null,
  simulation_path text,
  actor text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  retention_expires_at timestamp with time zone default (now() + '90 days'::interval) not null,
  project_active_hold boolean default false not null,
  project_hold_reason text,
  project_hold_set_by text,
  project_hold_set_at timestamp with time zone,
  media_deleted_at timestamp with time zone,
  metadata_policy text default 'legacy_unprocessed'::text not null
);
create table if not exists public.crm_test_visibility_audit (
  id bigint not null,
  conversation_id uuid,
  conversation_reference uuid not null,
  actor_id uuid,
  action text not null,
  created_at timestamp with time zone default clock_timestamp() not null
);
create table if not exists public.crm_whatsapp_automation_release_audit (
  id bigint not null,
  conversation_id uuid not null,
  released_by uuid not null,
  released_at timestamp with time zone default clock_timestamp() not null
);
create table if not exists public.crm_whatsapp_automation_releases (
  conversation_id uuid not null,
  released_by uuid not null,
  released_at timestamp with time zone default clock_timestamp() not null
);
create table if not exists public.crm_whatsapp_context_sync (
  inbound_event_id uuid not null,
  conversation_id uuid not null,
  revision bigint not null,
  content_hash text not null,
  event_received_at timestamp with time zone not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_whatsapp_manual_attempts (
  reply_id uuid not null,
  conversation_id uuid not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_whatsapp_menu_events (
  inbound_message_id uuid not null,
  conversation_id uuid not null,
  reply_id uuid,
  outbox_id uuid,
  menu_revision bigint,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_whatsapp_menu_reconciliation (
  id uuid default gen_random_uuid() not null,
  outbox_id uuid not null,
  conversation_id uuid not null,
  reviewer_id uuid not null,
  outcome text not null,
  evidence_sha256 text not null,
  provider_message_id text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.crm_whatsapp_processing_decisions (
  inbound_message_id uuid not null,
  status text default 'pending'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.crm_whatsapp_review_log (
  id uuid not null,
  reply_id uuid not null,
  reviewer_id uuid not null,
  evidence_kind text not null,
  evidence_sha256 text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.cuentas_elegibilidad_legal (
  user_id uuid not null,
  fecha_nacimiento date not null,
  franja_edad text not null,
  estado text not null,
  privacidad_reforzada boolean default true not null,
  verificado_at timestamp with time zone default now() not null,
  fuente text default 'unknown'::text not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.documentos_legales (
  id bigint not null,
  tipo text not null,
  version text not null,
  url text not null,
  contenido_canonico text not null,
  contenido_sha256 text not null,
  publicado_at timestamp with time zone not null,
  vigente boolean default false not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.equipos (
  id bigint not null,
  torneo_id bigint,
  nombre text not null,
  sede_id bigint,
  jugadores jsonb default '[]'::jsonb,
  puntos_totales integer default 0,
  posicion integer,
  created_at timestamp without time zone default now(),
  updated_at timestamp without time zone default now(),
  sets_ganados integer default 0,
  sets_perdidos integer default 0,
  games_ganados integer default 0,
  games_perdidos integer default 0,
  partidos_jugados integer default 0,
  puntos_ranking integer default 0,
  jugadores_nombres text,
  cupo_maximo integer default 2,
  creador_email text,
  solicitudes jsonb default '[]'::jsonb,
  equipo_abierto boolean default false,
  inscripcion_estado text default 'pendiente'::text,
  creador_id uuid,
  tipo_equipo text,
  foto_url text,
  plantel_revision bigint default 0 not null,
  modalidad_plantel text default 'dobles'::text not null,
  participantes_ranking uuid[]
);
create table if not exists public.equipos_jugadores (
  id bigint not null,
  equipo_id bigint not null,
  user_id uuid,
  email text not null,
  nombre text,
  rol text default 'jugador'::text not null,
  estado text default 'pendiente'::text not null,
  invited_at timestamp with time zone default now() not null,
  responded_at timestamp with time zone,
  tipo text default 'invitacion'::text not null,
  expires_at timestamp with time zone
);
create table if not exists public.equipos_usuario (
  id bigint not null,
  nombre text not null,
  deporte text not null,
  capitan_user_id uuid not null,
  capitan_email text,
  min_jugadores integer default 2 not null,
  max_jugadores integer default 4 not null,
  estado text default 'formando'::text not null,
  torneo_id integer,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  visibilidad text default 'cerrado'::text not null
);
create table if not exists public.extras (
  id integer not null,
  sede_id integer,
  nombre text not null,
  descripcion text,
  precio numeric not null,
  moneda text default 'ARS'::text,
  categoria text default 'otros'::text,
  imagen_url text,
  stock integer,
  activo boolean default true,
  created_at timestamp with time zone default now()
);
create table if not exists public.fipa_acceptances (
  id uuid default gen_random_uuid() not null,
  player_id uuid not null,
  representative_id uuid,
  accepted_by_user_id uuid,
  signer_type text not null,
  document_id uuid not null,
  document_code text not null,
  document_version text not null,
  language text not null,
  document_title text not null,
  accepted_text text,
  immutable_url text,
  content_hash text,
  status text not null,
  accepted_at timestamp with time zone,
  ip_address text,
  user_agent text,
  device_info jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_audit_log (
  id bigint not null,
  torneo_id bigint not null,
  registration_id uuid,
  player_id uuid,
  actor_user_id uuid,
  actor_email text,
  actor_role text not null,
  action text not null,
  entity_type text not null,
  entity_id text,
  previous_data jsonb,
  new_data jsonb,
  reason text,
  ip_address text,
  user_agent text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_documents (
  id uuid default gen_random_uuid() not null,
  torneo_id bigint not null,
  code text not null,
  title text not null,
  version text not null,
  language text not null,
  body_text text,
  immutable_url text,
  content_hash text,
  required boolean default true not null,
  signer_type text default 'player'::text not null,
  active boolean default true not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_invitations (
  id uuid default gen_random_uuid() not null,
  player_id uuid not null,
  representative_id uuid,
  invitee_type text not null,
  email text not null,
  token_hash text not null,
  expires_at timestamp with time zone not null,
  used_at timestamp with time zone,
  revoked_at timestamp with time zone,
  created_by uuid not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_legal_representatives (
  id uuid default gen_random_uuid() not null,
  player_id uuid not null,
  full_name text not null,
  identity_document text not null,
  relationship text not null,
  email text not null,
  phone text not null,
  user_id uuid,
  identity_confirmed boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_offline_authorizations (
  id uuid default gen_random_uuid() not null,
  player_id uuid not null,
  document_code text not null,
  document_version text not null,
  language text not null,
  signer_type text not null,
  storage_path text not null,
  original_name text not null,
  reason text not null,
  received_at timestamp with time zone not null,
  uploaded_by uuid not null,
  uploaded_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_organizer_access (
  id uuid default gen_random_uuid() not null,
  torneo_id bigint not null,
  user_id uuid not null,
  granted_by uuid not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_player_files (
  id uuid default gen_random_uuid() not null,
  player_id uuid not null,
  requirement_code text not null,
  storage_path text not null,
  original_name text not null,
  mime_type text,
  size_bytes bigint,
  status text default 'pending'::text not null,
  observation_reason text,
  uploaded_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_ranking_claim_audit (
  id bigint not null,
  source_key text not null,
  action text not null,
  actor_id uuid not null,
  invitation_id uuid,
  created_at timestamp with time zone default now() not null,
  request_id uuid
);
create table if not exists public.fipa_ranking_claim_invites (
  id uuid default gen_random_uuid() not null,
  source_key text not null,
  token_hash text not null,
  email text not null,
  player_name text not null,
  verification_note text not null,
  created_by uuid not null,
  created_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone not null,
  state text default 'pending'::text not null,
  used_by uuid,
  used_at timestamp with time zone
);
create table if not exists public.fipa_ranking_links (
  source_key text not null,
  user_id uuid not null,
  linked_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_ranking_operators (
  user_id uuid not null,
  enabled boolean default true not null,
  granted_by uuid,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_ranking_requests (
  id uuid default gen_random_uuid() not null,
  source_key text not null,
  user_id uuid not null,
  email text not null,
  state text default 'pending'::text not null,
  created_at timestamp with time zone default now() not null,
  reviewed_at timestamp with time zone,
  reviewed_by uuid,
  review_note text
);
create table if not exists public.fipa_registration_players (
  id uuid default gen_random_uuid() not null,
  registration_id uuid not null,
  user_id uuid,
  email text not null,
  full_name text not null,
  birth_date date not null,
  nationality text not null,
  identity_document text,
  fipa_id text,
  represented_association text not null,
  emergency_name text not null,
  emergency_phone text not null,
  planned_partner text,
  data_confirmed boolean default false not null,
  data_confirmed_at timestamp with time zone,
  is_minor boolean default false not null,
  status text default 'pending_player'::text not null,
  observation_reason text,
  created_by uuid not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.fipa_registrations (
  id uuid default gen_random_uuid() not null,
  torneo_id bigint not null,
  association_name text not null,
  country text not null,
  responsible_name text not null,
  responsible_email text not null,
  responsible_phone text not null,
  responsible_user_id uuid,
  association_declaration boolean default false not null,
  association_declared_at timestamp with time zone,
  association_declared_ip text,
  status text default 'draft'::text not null,
  observation_reason text,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  created_by uuid not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.franjas_precio (
  id bigint not null,
  sede_id integer not null,
  deporte text not null,
  dia_semana integer,
  hora_inicio time without time zone not null,
  hora_fin time without time zone not null,
  precio_60min integer,
  precio_90min integer,
  precio_120min integer,
  activo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.games (
  id bigint not null,
  partido_id bigint,
  numero_game integer not null,
  equipo_a_score integer default 0,
  equipo_b_score integer default 0,
  duracion_minutos integer,
  estado text default 'pendiente'::text not null,
  created_at timestamp without time zone default now(),
  updated_at timestamp without time zone default now()
);
create table if not exists public.horarios_excepcionales (
  id bigint not null,
  sede_id bigint not null,
  fecha date not null,
  horario_apertura_especial text,
  horario_cierre_especial text,
  cerrado boolean default false,
  descripcion text,
  created_at timestamp without time zone default now()
);
create table if not exists public.horarios_excepciones (
  id bigint not null,
  sede_id bigint not null,
  fecha date not null,
  nombre text,
  hora_inicio time without time zone not null,
  hora_fin time without time zone not null,
  precio numeric,
  activo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.hub_config (
  id text not null,
  titulo text not null,
  subtitulo text,
  foto_url text,
  fotos_urls text[] default '{}'::text[],
  activo boolean default true,
  orden integer default 0,
  updated_at timestamp with time zone default now(),
  chivi_imagen_url text
);
create table if not exists public.hub_deporte_config (
  id uuid default gen_random_uuid() not null,
  deporte text not null,
  card_key text not null,
  titulo text,
  subtitulo text,
  imagen_url text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  media_type text default 'image'::text not null,
  video_url text,
  poster_url text
);
create table if not exists public.hub_promo_global (
  id integer default 1 not null,
  activo boolean default false,
  imagen_url text,
  titulo text,
  subtitulo text,
  texto_boton text default 'Ver más'::text,
  url_destino text,
  updated_at timestamp with time zone default now()
);
create table if not exists public.hub_promo_sede (
  id uuid default gen_random_uuid() not null,
  sede_id integer,
  activo boolean default false,
  imagen_url text,
  titulo text,
  subtitulo text,
  texto_boton text default 'Ver más'::text,
  url_destino text,
  updated_at timestamp with time zone default now()
);
create table if not exists public.inscripciones_clases (
  id bigint not null,
  clase_id bigint,
  user_id uuid,
  fecha date not null,
  hora_inicio time without time zone not null,
  estado text default 'pendiente'::text,
  precio_pagado numeric(10,2),
  metodo_pago text,
  reserva_cancha_id bigint,
  created_at timestamp with time zone default now(),
  asistio boolean,
  asistencia_marcada_at timestamp with time zone,
  asistencia_marcada_por text
);
create table if not exists public.invitaciones_admin (
  id uuid default gen_random_uuid() not null,
  email text not null,
  token text not null,
  pais text not null,
  nombre_club text,
  estado text default 'pendiente'::text not null,
  created_at timestamp with time zone default now() not null,
  expires_at timestamp with time zone not null,
  sede_id bigint,
  invited_role text default 'admin_club'::text not null,
  invited_alcance text,
  provincia text,
  ciudad text,
  organizacion_id uuid
);
create table if not exists public.jugador_nivel_externo (
  id bigint not null,
  user_id uuid not null,
  deporte text default 'padel'::text not null,
  plataforma text not null,
  puntuacion text not null,
  categoria_inicial text not null,
  estado text default 'declarado'::text not null,
  evidencia_storage_path text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.jugador_rankings (
  id uuid default gen_random_uuid() not null,
  user_id uuid,
  deporte text default 'padbol'::text not null,
  nivel text not null,
  puntos integer default 0 not null,
  posicion_club integer,
  posicion_nacional integer,
  posicion_fipa integer,
  sede_id integer,
  pais text,
  temporada text default '2026'::text,
  updated_at timestamp with time zone default now()
);
create table if not exists public.jugadores (
  id bigint not null,
  user_id uuid,
  nombre text not null,
  email text not null,
  documento text not null,
  tipo_documento text default 'DNI'::text not null,
  nacionalidad text not null,
  fecha_nacimiento date,
  foto_url text,
  pierna_habil text default 'derecha'::text not null,
  bio text,
  estado text default 'activo'::text not null,
  created_at timestamp without time zone default now(),
  updated_at timestamp without time zone default now()
);
create table if not exists public.jugadores_aceptaciones (
  id bigint not null,
  user_id uuid not null,
  tipo text not null,
  version text not null,
  torneo_id integer,
  aceptado_at timestamp with time zone default now() not null,
  ip text,
  user_agent text,
  manifestacion text,
  fuente text,
  version_app text,
  locale text,
  documento_url text,
  documento_sha256 text
);
create table if not exists public.jugadores_identidad (
  user_id uuid not null,
  fecha_nacimiento date,
  tipo_documento text,
  pais_documento text,
  numero_documento_cifrado text,
  numero_documento_hash text,
  nacionalidad text,
  genero text,
  categoria_deportiva text,
  telefono text,
  telefono_verificado_at timestamp with time zone,
  contacto_emergencia_nombre text,
  contacto_emergencia_telefono text,
  contacto_emergencia_relacion text,
  identidad_estado text default 'incompleta'::text not null,
  identidad_verificada_at timestamp with time zone,
  identidad_verificada_por uuid,
  identidad_notas_admin text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.jugadores_perfil (
  id bigint not null,
  email text not null,
  nombre text,
  whatsapp text,
  lateralidad text,
  nivel text,
  pais text,
  created_at timestamp with time zone default now(),
  ciudad text,
  club text,
  fecha_nacimiento date,
  sede_id integer,
  numero_fipa text,
  es_federado boolean default false,
  categoria_validada boolean default false,
  pendiente_validacion boolean default true,
  alias text,
  user_id uuid,
  foto_url text,
  instagram_url text,
  companero_id uuid,
  ultimo_companero_id uuid,
  localidad text,
  mostrar_torneos_jugados boolean default false not null,
  apellido text,
  nombre_saludo text,
  genero text,
  apodo text,
  notificaciones_whatsapp boolean default false,
  busca_companero boolean default false,
  deportes_preferidos text[] default '{}'::text[],
  es_jugador_torneos boolean default false,
  expo_push_token text,
  telefono text,
  push_token text,
  username text,
  deportes text[],
  companero_habitual_id uuid,
  posicion_cancha text,
  mano_preferida text,
  xp integer default 0,
  liga text default 'INIT'::text,
  rango text default 'Rookie'::text,
  suspendido_hasta timestamp with time zone,
  idioma_preferido text,
  es_prueba boolean default false not null
);
create table if not exists public.jugadores_torneo (
  id bigint not null,
  torneo_id bigint,
  nombre text not null,
  email text not null,
  user_id uuid,
  numero_camiseta integer,
  es_capitan boolean default false,
  created_at timestamp without time zone default now(),
  pais text
);
create table if not exists public.ligas_premios (
  id uuid default gen_random_uuid() not null,
  sede_id bigint,
  liga text not null,
  descripcion_premio text not null,
  activo boolean default true,
  fecha_vencimiento date,
  created_at timestamp with time zone default now()
);
create table if not exists public.lista_espera_general (
  id bigint not null,
  sede_id bigint,
  user_id uuid,
  deporte text not null,
  created_at timestamp with time zone default now(),
  notificado_at timestamp with time zone
);
create table if not exists public.lista_espera_torneos (
  id uuid default gen_random_uuid() not null,
  torneo_id bigint,
  user_id uuid,
  email text,
  nombre text,
  whatsapp text,
  created_at timestamp with time zone default now(),
  inscripcion_abierta_notificado_at timestamp with time zone
);
create table if not exists public.locations (
  id uuid default gen_random_uuid() not null,
  name character varying(255) not null,
  city character varying(100),
  country character varying(100),
  timezone character varying(50) default 'America/Argentina/Buenos_Aires'::character varying,
  currency character varying(10) default 'ARS'::character varying,
  opening_time time without time zone default '18:00:00'::time without time zone,
  closing_time time without time zone default '23:00:00'::time without time zone,
  created_at timestamp without time zone default CURRENT_TIMESTAMP,
  updated_at timestamp without time zone default CURRENT_TIMESTAMP
);
create table if not exists public.logros_jugador (
  id uuid default gen_random_uuid() not null,
  user_id uuid,
  slug text not null,
  desbloqueado_at timestamp with time zone default now(),
  sede_id bigint,
  desbloqueado_en timestamp with time zone default now()
);
create table if not exists public.logros_premios (
  id uuid default gen_random_uuid() not null,
  sede_id bigint,
  logro_slug text not null,
  descripcion_premio text not null,
  activo boolean default true,
  fecha_vencimiento date,
  created_at timestamp with time zone default now()
);
create table if not exists public.manual_player_booking_receipts (
  reference uuid not null,
  actor_id uuid not null,
  payload jsonb not null,
  reserva_id bigint not null
);
create table if not exists public.match_attendance_audit_log (
  id uuid default gen_random_uuid() not null,
  match_id integer not null,
  actor_user_id uuid,
  actor_role text,
  action text not null,
  target_user_id uuid,
  previous_status text,
  new_status text,
  reason text,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.match_participants (
  id bigint not null,
  match_type text default 'casual'::text not null,
  match_id text not null,
  reserva_id bigint,
  user_id uuid not null,
  email text,
  role text default 'participant'::text not null,
  team text,
  source text default 'manual'::text not null,
  attendance_status text default 'pending'::text not null,
  attendance_confirmed_at timestamp with time zone,
  reward_status text default 'pending'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  attendance_requested_at timestamp with time zone,
  attendance_responded_at timestamp with time zone,
  attendance_response_source text,
  attendance_denial_reason text
);
create table if not exists public.match_reward_events (
  id bigint not null,
  match_type text default 'casual'::text not null,
  match_id text not null,
  reserva_id bigint,
  user_id uuid not null,
  reward_type text not null,
  amount integer default 0 not null,
  status text default 'pending'::text not null,
  source_key text not null,
  padcoins_movimiento_id bigint,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.membresia_planes (
  id bigint not null,
  sede_id integer not null,
  nombre text not null,
  descripcion text,
  precio numeric(12,2) default 0 not null,
  moneda text default 'ARS'::text not null,
  duracion_tipo text default 'mensual'::text not null,
  duracion_dias integer,
  activo boolean default true not null,
  cupo integer,
  vigencia_desde timestamp with time zone,
  vigencia_hasta timestamp with time zone,
  renovacion_automatica boolean default false not null,
  beneficios jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.membresia_usos_reserva (
  id bigint not null,
  membresia_id bigint not null,
  user_id uuid not null,
  sede_id integer not null,
  reserva_id bigint,
  periodo_key text not null,
  beneficio text not null,
  detalle jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.membresias (
  id bigint not null,
  user_id uuid not null,
  email text,
  plan_id text default 'gratuito'::text not null,
  estado text default 'activa'::text not null,
  started_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.membresias_sede (
  id bigint not null,
  user_id uuid not null,
  email text,
  sede_id integer not null,
  plan_id bigint not null,
  estado text default 'pendiente'::text not null,
  origen text default 'manual'::text not null,
  inicio timestamp with time zone default now() not null,
  vencimiento timestamp with time zone not null,
  renovacion_automatica boolean default false not null,
  notas text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  cancelada_at timestamp with time zone,
  suspendida_at timestamp with time zone
);
create table if not exists public.nations_activation_audit (
  id uuid default gen_random_uuid() not null,
  torneo_id bigint not null,
  participante_id uuid,
  actor_id uuid,
  action text not null,
  detail jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.nations_activation_delegates (
  torneo_id bigint not null,
  country text not null,
  user_id uuid not null,
  enabled boolean default true not null
);
create table if not exists public.nations_activation_events (
  torneo_id bigint not null,
  slug text not null,
  title text not null,
  enabled boolean default false not null,
  roster_publication_approved boolean default false not null,
  names_published boolean default false not null,
  names_release_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.nations_activation_imports (
  torneo_id bigint not null,
  batch_id uuid not null,
  actor_id uuid not null,
  payload_hash text not null,
  receipt jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.nations_activation_invites (
  id uuid default gen_random_uuid() not null,
  participante_id uuid not null,
  token_hash text not null,
  created_by uuid not null,
  expires_at timestamp with time zone not null,
  revoked_at timestamp with time zone,
  used_at timestamp with time zone,
  used_by uuid,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.nations_activation_participants (
  participante_id uuid not null,
  torneo_id bigint not null,
  country text not null,
  row_key text not null,
  minor boolean default false not null,
  guardian_reviewed_by uuid,
  guardian_reviewed_at timestamp with time zone,
  age_status text not null
);
create table if not exists public.news_article_events (
  id bigint not null,
  article_id uuid not null,
  actor_id uuid,
  event_type text not null,
  from_status text,
  to_status text,
  notes text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.news_articles (
  id uuid default gen_random_uuid() not null,
  sede_id bigint,
  author_id uuid default auth.uid() not null,
  author_name text not null,
  author_credit text,
  slug text not null,
  locale text default 'es'::text not null,
  category text default 'actualidad'::text not null,
  title text not null,
  excerpt text not null,
  body text not null,
  hero_image_url text not null,
  hero_image_alt text not null,
  hero_focal_x smallint default 50 not null,
  hero_focal_y smallint default 50 not null,
  source_url text,
  social_title text,
  social_excerpt text,
  status text default 'draft'::text not null,
  submitted_at timestamp with time zone,
  reviewed_by uuid,
  reviewed_at timestamp with time zone,
  review_notes text,
  published_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.ng_inscripcion_eventos (
  id uuid default gen_random_uuid() not null,
  inscripcion_id uuid not null,
  sesion_id uuid,
  tipo text not null,
  actor text,
  detalle jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.ng_inscripcion_participantes (
  id uuid default gen_random_uuid() not null,
  inscripcion_id uuid not null,
  nombre text not null,
  categoria text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.ng_inscripciones (
  id uuid default gen_random_uuid() not null,
  sesion_id uuid,
  sede_id bigint,
  crm_conversation_id uuid,
  contacto_nombre text not null,
  contacto_email text,
  contacto_whatsapp text,
  categoria text,
  estado text default 'borrador'::text not null,
  posicion_espera integer,
  continuidad_estado text,
  cancel_reason text,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.ng_sesiones (
  id uuid default gen_random_uuid() not null,
  sede_id bigint not null,
  nombre_publico text not null,
  ciudad text,
  pais text,
  categoria text,
  comienza_at timestamp with time zone,
  termina_at timestamp with time zone,
  cupo integer default 0 not null,
  estado text default 'borrador'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.ng_solicitudes_sede (
  id uuid default gen_random_uuid() not null,
  canonical_sede_id bigint,
  sede_club text not null,
  ciudad text,
  pais text,
  estado text default 'recibida'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  crm_conversation_id uuid,
  contacto_nombre text,
  contacto_email text,
  contacto_whatsapp text,
  created_by uuid
);
create table if not exists public.notificaciones (
  id bigint not null,
  user_id uuid not null,
  tipo text not null,
  titulo text not null,
  mensaje text not null,
  leida boolean default false not null,
  link text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.notificaciones_admin_log (
  id integer not null,
  admin_user_id uuid,
  titulo text not null,
  mensaje text,
  segmento jsonb,
  cantidad_enviadas integer default 0,
  created_at timestamp with time zone default now(),
  estado text default 'sent'::text not null,
  idempotency_key text,
  push_job_id uuid
);
create table if not exists public.notificaciones_zona_interes (
  id uuid default gen_random_uuid() not null,
  user_id text,
  deporte text,
  lat double precision,
  lng double precision,
  email text,
  created_at timestamp with time zone default now()
);
create table if not exists public.organizacion_sedes (
  organizacion_id uuid not null,
  sede_id bigint not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.organizaciones (
  id uuid default gen_random_uuid() not null,
  nombre text not null,
  nombre_legal text,
  pais_principal text,
  email_contacto text,
  whatsapp_contacto text,
  plan_codigo text default 'business'::text not null,
  limite_sedes integer default 1 not null,
  limite_canchas_total integer default 1 not null,
  limite_admins_centrales integer default 1 not null,
  funciones_habilitadas text[] default ARRAY['reservas'::text, 'torneos'::text, 'jugadores'::text, 'reportes'::text] not null,
  estado text default 'activa'::text not null,
  metadata jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.padbol_match_setup_status (
  id uuid default gen_random_uuid() not null,
  sede_id integer not null,
  admin_sede_configurado boolean default false not null,
  padcoins_activado boolean default false not null,
  padcoins_default_5_configurado boolean default false not null,
  beneficios_iniciales_configurados boolean default false not null,
  campanas_habilitadas boolean default false not null,
  reserva_visible_para_jugador boolean default false not null,
  checklist_completo boolean default false not null,
  last_checked_at timestamp with time zone,
  notes text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  sede_datos_basicos_configurados boolean default false not null,
  canchas_configuradas boolean default false not null,
  horarios_configurados boolean default false not null,
  precios_configurados boolean default false not null,
  reservas_habilitadas boolean default false not null,
  pagos_configurados boolean default false not null,
  reglas_operativas_configuradas boolean default false not null,
  readiness_level text default 'incomplete'::text not null,
  attendance_confirmation_enabled boolean default false not null
);
create table if not exists public.padcoins_campaign_applications (
  id uuid default gen_random_uuid() not null,
  campaign_id uuid not null,
  sede_id integer not null,
  user_id uuid not null,
  reserva_id text,
  movimiento_id uuid,
  base_padcoins integer default 0 not null,
  final_padcoins integer default 0 not null,
  calculation_detail jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.padcoins_campaign_audit_logs (
  id uuid default gen_random_uuid() not null,
  campaign_id uuid not null,
  sede_id integer not null,
  action text not null,
  actor_user_id uuid,
  actor_role text,
  details jsonb default '{}'::jsonb not null,
  high_impact boolean default false not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.padcoins_campaigns (
  id uuid default gen_random_uuid() not null,
  sede_id integer not null,
  name text not null,
  description text,
  campaign_type text not null,
  start_at timestamp with time zone not null,
  end_at timestamp with time zone not null,
  status text default 'draft'::text not null,
  multiplier numeric(8,2),
  loyalty_percentage_override integer,
  fixed_padcoins integer,
  benefit_id uuid,
  max_total_uses integer,
  max_uses_per_player integer,
  estimated_cost_reference integer,
  high_impact boolean default false not null,
  message_title text,
  message_body text,
  segment_config jsonb default '{}'::jsonb not null,
  created_by uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.padcoins_canjes (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  sede_id integer not null,
  premio_id uuid not null,
  monto_padcoins integer not null,
  estado text default 'pendiente'::text not null,
  codigo text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  entregado_at timestamp with time zone,
  entregado_por uuid,
  expires_at timestamp with time zone,
  aprobado_at timestamp with time zone,
  aprobado_por uuid,
  vencido_at timestamp with time zone
);
create table if not exists public.padcoins_global_config (
  id uuid default gen_random_uuid() not null,
  key text not null,
  value_integer integer,
  value_text text,
  descripcion text,
  activo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  updated_by uuid
);
create table if not exists public.padcoins_movimientos (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  tipo text not null,
  monto integer not null,
  saldo_antes integer not null,
  saldo_despues integer not null,
  referencia_tipo text,
  referencia_id text,
  sede_id integer,
  descripcion text,
  created_at timestamp with time zone default now() not null,
  created_by uuid,
  metadata jsonb
);
create table if not exists public.padcoins_saldo (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  disponible integer default 0 not null,
  historico_total integer default 0 not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.padcoins_sede_config (
  id uuid default gen_random_uuid() not null,
  sede_id integer not null,
  activo boolean default false not null,
  descripcion text,
  fecha_inicio timestamp with time zone,
  fecha_fin timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  updated_by uuid,
  rule_overrides jsonb default '{}'::jsonb not null
);
create table if not exists public.partido_resumenes (
  id bigint not null,
  partido_id bigint not null,
  source_type text default 'partidos_abiertos'::text not null,
  version text not null,
  prompt_version text,
  payload_hash text not null,
  payload jsonb not null,
  response jsonb,
  status text default 'pending'::text not null,
  error_code text,
  error_message text,
  generated_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.partidos (
  id bigint not null,
  torneo_id bigint,
  equipo_a_id bigint,
  equipo_b_id bigint,
  fecha_hora timestamp without time zone,
  cancha_id integer,
  sede_id bigint,
  estado text default 'pendiente'::text not null,
  resultado jsonb,
  created_at timestamp without time zone default now(),
  updated_at timestamp without time zone default now(),
  ronda integer default 1,
  grupo text,
  cancha text,
  ganador_equipo_id bigint,
  partido_siguiente_id bigint,
  partido_siguiente_slot text,
  bracket_position integer,
  bracket_round integer
);
create table if not exists public.partidos_abiertos (
  id bigint not null,
  reserva_id bigint,
  sede_id bigint,
  sede_nombre text not null,
  cancha text not null,
  deporte text not null,
  fecha date not null,
  hora time without time zone not null,
  duracion_minutos integer default 90 not null,
  nivel text,
  jugadores_requeridos integer not null,
  jugadores_confirmados jsonb default '[]'::jsonb not null,
  capitan_user_id uuid,
  capitan_email text not null,
  capitan_nombre text not null,
  capitan_foto_url text,
  estado text default 'abierto'::text not null,
  share_token text default encode(gen_random_bytes(12), 'hex'::text) not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  resultado jsonb,
  ganador text,
  cancha_id integer,
  jugadores_actuales integer default 1,
  jugadores_necesarios integer default 4,
  deadline_cancel timestamp with time zone,
  pago_url text,
  resultado_json jsonb,
  estado_resultado text default 'sin_resultado'::text,
  equipos_asignacion jsonb,
  attendance_collection_status text default 'none'::text not null,
  attendance_opened_at timestamp with time zone,
  attendance_deadline_at timestamp with time zone,
  attendance_resolved_at timestamp with time zone,
  attendance_resolution_reason text,
  rewards_processed_at timestamp with time zone
);
create table if not exists public.partidos_abiertos_jugadores (
  id bigint not null,
  partido_id bigint,
  user_id uuid,
  email text,
  joined_at timestamp with time zone default now()
);
create table if not exists public.partidos_abiertos_solicitudes (
  id bigint not null,
  partido_id bigint not null,
  jugador_user_id uuid,
  jugador_email text not null,
  jugador_nombre text not null,
  jugador_foto_url text,
  estado text default 'pendiente'::text not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.payments (
  id uuid default gen_random_uuid() not null,
  reservation_id uuid not null,
  amount numeric(10,2) not null,
  currency character varying(10),
  payment_method character varying(50),
  payment_status character varying(50) default 'pending'::character varying,
  transaction_id character varying(255),
  mercado_pago_id character varying(255),
  stripe_payment_id character varying(255),
  refund_amount numeric(10,2),
  refund_date timestamp without time zone,
  created_at timestamp without time zone default CURRENT_TIMESTAMP,
  updated_at timestamp without time zone default CURRENT_TIMESTAMP
);
create table if not exists public.plan_pricing (
  id integer not null,
  nombre text not null,
  canchas_min integer not null,
  canchas_max integer,
  precio_usd numeric(10,2) not null,
  activo boolean default true,
  created_at timestamp with time zone default now()
);
create table if not exists public.precios_por_deporte (
  id integer not null,
  sede_id integer,
  deporte text not null,
  precio_ars numeric,
  precio_usd numeric,
  activo boolean default true,
  created_at timestamp with time zone default now()
);
create table if not exists public.premios_canjeables (
  id uuid default gen_random_uuid() not null,
  sede_id integer not null,
  nombre text not null,
  descripcion text,
  costo_padcoins integer not null,
  stock_total integer,
  stock_disponible integer,
  activo boolean default true not null,
  fecha_inicio timestamp with time zone,
  fecha_fin timestamp with time zone,
  condiciones text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  imagen_url text,
  limite_usuario_cantidad integer,
  limite_usuario_periodo text,
  limite_global_cantidad integer,
  limite_global_periodo text,
  canje_validez_dias integer
);
create table if not exists public.profesores (
  id bigint not null,
  sede_id bigint,
  user_id uuid,
  nombre text not null,
  apellido text,
  foto_url text,
  bio text,
  deportes text[] default '{}'::text[],
  certificado_fipa text,
  activo boolean default true,
  aprobado boolean default false,
  aprobado_por uuid,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  whatsapp text,
  fecha_nacimiento date,
  genero text,
  especialidad text,
  nivel text,
  certificado_numero text,
  certificado_url text,
  certificado_estado text,
  certificado_nota text,
  certificado_verificado_at timestamp with time zone,
  certificado_verificado_por uuid
);
create table if not exists public.push_delivery_attempts (
  id bigint not null,
  job_id uuid not null,
  push_token_id integer,
  user_id uuid,
  token_fingerprint text not null,
  expo_ticket_id text,
  status text not null,
  error_code text,
  error_message text,
  attempt_count integer default 1 not null,
  receipt_check_count integer default 0 not null,
  next_receipt_check_at timestamp with time zone,
  receipt_checked_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.push_delivery_jobs (
  id uuid default gen_random_uuid() not null,
  idempotency_key text not null,
  source text not null,
  category text not null,
  event_type text not null,
  title text not null,
  body text not null,
  payload jsonb default '{}'::jsonb not null,
  actor_user_id uuid,
  recipient_count integer default 0 not null,
  token_count integer default 0 not null,
  accepted_count integer default 0 not null,
  failed_count integer default 0 not null,
  status text default 'processing'::text not null,
  last_error text,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.push_notification_preferences (
  user_id uuid not null,
  transactional_enabled boolean default true not null,
  marketing_enabled boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.push_preference_audit (
  id bigint not null,
  user_id uuid,
  transactional_enabled boolean not null,
  marketing_enabled boolean not null,
  source text default 'api'::text not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.push_token_audit (
  id bigint not null,
  user_id uuid,
  device_id text,
  platform text,
  token_fingerprint text,
  action text not null,
  reason text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.push_tokens (
  id integer not null,
  user_id uuid,
  token text,
  platform text,
  created_at timestamp with time zone default now(),
  expo_push_token text,
  device_id text,
  language text,
  enabled boolean default true not null,
  updated_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null,
  revoked_at timestamp with time zone,
  invalidated_at timestamp with time zone,
  invalidation_reason text
);
create table if not exists public.push_web_subscriptions (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  endpoint text not null,
  p256dh text not null,
  auth text not null,
  user_agent text,
  created_at timestamp with time zone default now() not null,
  last_seen_at timestamp with time zone default now() not null,
  revoked_at timestamp with time zone,
  failure_count integer default 0 not null
);
create table if not exists public.rangos_historial (
  id uuid default gen_random_uuid() not null,
  user_id uuid,
  rango_anterior text,
  rango_nuevo text not null,
  created_at timestamp with time zone default now()
);
create table if not exists public.ranking_jugadores (
  id bigint not null,
  torneo_id bigint,
  jugador_id bigint,
  equipo_id bigint,
  nivel_ranking text default 'club'::text not null,
  partidos_jugados integer default 0,
  partidos_ganados integer default 0,
  partidos_perdidos integer default 0,
  puntos integer default 0,
  posicion integer,
  trofeos jsonb default '[]'::jsonb,
  updated_at timestamp without time zone default now()
);
create table if not exists public.rankings_leaderboard (
  id uuid default gen_random_uuid() not null,
  user_id uuid,
  deporte text default 'padbol'::text not null,
  nivel text default 'club'::text not null,
  puntos integer default 0 not null,
  posicion integer,
  sede_id integer,
  pais text,
  temporada text default '2026'::text,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  partidos_jugados integer default 0 not null,
  ganados integer default 0 not null,
  perdidos integer default 0 not null,
  empatados integer default 0 not null,
  racha_actual integer default 0 not null,
  mejor_racha integer default 0 not null
);
create table if not exists public.recorridos_externos (
  id bigint not null,
  user_id uuid not null,
  email text,
  origen text not null,
  categorias text[] default '{}'::text[] not null,
  comentario text,
  capturas_paths text[] default '{}'::text[] not null,
  estado text default 'recibido'::text not null,
  datos_reconocidos jsonb default '{}'::jsonb not null,
  nota_revision text,
  revisar_antes_de timestamp with time zone default (now() + '24:00:00'::interval) not null,
  revisado_por uuid,
  revisado_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.resenas (
  id uuid default gen_random_uuid() not null,
  sede_id bigint,
  user_id uuid,
  estrellas integer,
  comentario text,
  created_at timestamp with time zone default now(),
  nombre text default ''::text not null
);
create table if not exists public.resenas_sedes (
  id uuid default gen_random_uuid() not null,
  sede_id integer,
  user_id uuid,
  estrellas integer,
  comentario text,
  respuesta_admin text,
  fecha_respuesta timestamp with time zone,
  created_at timestamp with time zone default now()
);
create table if not exists public.reservas (
  id bigint not null,
  sede text not null,
  fecha text not null,
  hora text not null,
  cancha integer not null,
  nombre text not null,
  email text not null,
  telefono text not null,
  whatsapp text not null,
  nivel text not null,
  precio integer not null,
  estado text default 'confirmada'::text,
  created_at timestamp without time zone default now(),
  recordatorio_enviado boolean default false,
  mp_payment_id text,
  mp_comprobante_url text,
  monto_pagado numeric,
  moneda text default 'ARS'::text,
  user_id uuid,
  duracion_minutos integer default 90 not null,
  tipo text default 'cancha'::text,
  qr_token text,
  checkin_at timestamp with time zone,
  checkin_by text,
  checkin_realizado boolean default false not null,
  pago_estado text default 'pendiente'::text,
  hora_inicio text,
  hora_fin text,
  cancha_id integer,
  sede_id integer,
  notificacion_post_partido_enviada boolean default false,
  partido_id bigint,
  deporte text default 'padbol'::text,
  precio_esperado integer,
  pricing_snapshot jsonb,
  stripe_checkout_session_id text,
  stripe_payment_intent_id text,
  payment_provider text default 'mercadopago'::text,
  mp_preference_id text,
  origen_creacion text
);
create table if not exists public.reservas_historial (
  id bigint not null,
  reserva_id bigint,
  estado_anterior text,
  estado_nuevo text,
  changed_by text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.reservations (
  id uuid default gen_random_uuid() not null,
  court_id uuid not null,
  user_id uuid not null,
  location_id uuid not null,
  reservation_date date not null,
  start_time time without time zone not null,
  end_time time without time zone not null,
  number_of_players integer default 4,
  skill_level character varying(50),
  status character varying(50) default 'pending'::character varying,
  price_ars numeric(10,2),
  price_usd numeric(10,2),
  currency_used character varying(10),
  notes text,
  created_at timestamp without time zone default CURRENT_TIMESTAMP,
  updated_at timestamp without time zone default CURRENT_TIMESTAMP
);
create table if not exists public.scoreboard_control_actions (
  session_id uuid not null,
  action_id text not null,
  device_id text not null,
  scoreboard_id uuid not null,
  expected_revision bigint not null,
  applied_revision bigint not null,
  response jsonb not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.scoreboard_control_sessions (
  id uuid default gen_random_uuid() not null,
  scoreboard_id uuid not null,
  device_id text,
  token_hash text,
  pairing_code_hash text,
  pairing_expires_at timestamp with time zone,
  pairing_claimed_at timestamp with time zone,
  expires_at timestamp with time zone not null,
  revoked_at timestamp with time zone,
  last_seen_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.scoreboard_court_occupancy_candidate (
  scoreboard_id uuid not null,
  sede_id bigint not null,
  court_id bigint not null,
  starts_at timestamp with time zone not null,
  ends_at timestamp with time zone not null
);
create table if not exists public.scoreboard_historial_puntos (
  id uuid default gen_random_uuid() not null,
  partido_id uuid,
  equipo text,
  tipo_punto text default 'normal'::text,
  score_a_antes text,
  score_b_antes text,
  set_numero integer,
  games_a_antes integer,
  games_b_antes integer,
  timestamp timestamp with time zone default now(),
  es_tiebreak_antes boolean default false,
  estado_antes text,
  historial_sets_antes jsonb,
  saque_actual_antes text,
  score_a_game_antes text,
  score_b_game_antes text,
  estado_partido_antes text,
  sets_a_antes jsonb,
  sets_b_antes jsonb,
  games_a_set_actual_antes integer default 0,
  games_b_set_actual_antes integer default 0,
  set_actual_antes integer default 1
);
create table if not exists public.scoreboard_jugadores_temp (
  id uuid default gen_random_uuid() not null,
  partido_id uuid,
  equipo text,
  slot integer,
  nombre text,
  numero integer,
  foto_url text,
  user_id uuid,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now()
);
create table if not exists public.scoreboard_linked_suspend_candidate (
  scoreboard_id uuid not null,
  booking_id bigint,
  open_id bigint,
  booking_state text,
  open_state text,
  created_at timestamp with time zone default clock_timestamp() not null
);
create table if not exists public.scoreboard_partial_correction_audit (
  id bigint not null,
  scoreboard_id uuid not null,
  actor_id uuid not null,
  reason text not null,
  previous_score jsonb not null,
  corrected_score jsonb not null,
  created_at timestamp with time zone default clock_timestamp() not null
);
create table if not exists public.scoreboard_partidos (
  id uuid default gen_random_uuid() not null,
  sede_id integer,
  torneo_id integer,
  cancha text,
  equipo_a_nombre text not null,
  equipo_b_nombre text not null,
  equipo_a_jugadores jsonb default '[]'::jsonb,
  equipo_b_jugadores jsonb default '[]'::jsonb,
  estado text default 'pendiente'::text,
  saque_actual text default 'A'::text,
  score_a integer default 0,
  score_b integer default 0,
  games_a integer default 0,
  games_b integer default 0,
  sets_a integer default 0,
  sets_b integer default 0,
  historial_sets jsonb default '[]'::jsonb,
  es_tiebreak boolean default false,
  ultimo_punto text,
  historial_puntos jsonb default '[]'::jsonb,
  cronometro_inicio timestamp with time zone,
  cronometro_pausado boolean default false,
  cronometro_segundos integer default 0,
  created_at timestamp with time zone default now(),
  updated_at timestamp with time zone default now(),
  torneo_nombre text,
  color_a text default '#1a3a6e'::text,
  color_b text default '#6e1a1a'::text,
  jersey_a1 integer default 1,
  jersey_a2 integer default 2,
  jersey_a3 integer default 3,
  jersey_a4 integer default 4,
  jersey_b1 integer default 1,
  jersey_b2 integer default 2,
  jersey_b3 integer default 3,
  jersey_b4 integer default 4,
  color_uniforme_a1 text,
  color_uniforme_a2 text,
  color_uniforme_b1 text,
  color_uniforme_b2 text,
  logo_torneo_url text,
  partido_abierto_id bigint,
  reserva_id bigint,
  partido_torneo_id bigint,
  control_token_hash text,
  control_token_created_at timestamp with time zone,
  control_token_revoked_at timestamp with time zone,
  synced_to_torneo_at timestamp with time zone,
  sync_torneo_status text,
  revision bigint default 0 not null
);
create table if not exists public.scoreboard_resumption_history_candidate (
  id bigint not null,
  scoreboard_id uuid not null,
  actor_id uuid not null,
  previous_schedule jsonb not null,
  new_court_id bigint not null,
  resumed_at timestamp with time zone default clock_timestamp() not null
);
create table if not exists public.scoreboard_sponsors (
  id uuid default gen_random_uuid() not null,
  sede_id integer,
  nombre text not null,
  categoria text,
  logo_url text,
  orden integer default 0,
  activo boolean default true,
  created_at timestamp with time zone default now()
);
create table if not exists public.scoreboard_suspension_reason_isolated_candidate (
  action_id uuid not null,
  scoreboard_id uuid not null,
  actor_id uuid not null,
  reason text not null,
  created_at timestamp with time zone default clock_timestamp() not null
);
create table if not exists public.scoreboard_transition_cancelled_isolated_candidate (
  action_id uuid not null,
  scoreboard_id uuid not null,
  actor_id uuid not null,
  action text not null,
  created_at timestamp with time zone default clock_timestamp() not null
);
create table if not exists public.scoreboard_transition_receipt_isolated_candidate (
  action_id uuid not null,
  scoreboard_id uuid not null,
  actor_id uuid not null,
  action text not null,
  parameters jsonb not null,
  result jsonb not null,
  created_at timestamp with time zone default clock_timestamp() not null
);
create table if not exists public.sede_beneficio_progreso (
  id uuid default gen_random_uuid() not null,
  programa_id uuid not null,
  periodo date not null,
  metricas jsonb default '{}'::jsonb not null,
  evidencia jsonb default '{}'::jsonb not null,
  estado text default 'pendiente'::text not null,
  meses_desbloqueados integer default 0 not null,
  evaluado_at timestamp with time zone,
  evaluado_por text,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.sede_extras (
  id bigint not null,
  sede_id bigint,
  nombre text not null,
  descripcion text,
  precio numeric not null,
  precio_moneda text default 'ARS'::text,
  imagen_url text,
  activo boolean default true,
  aprobado_super boolean default false,
  created_at timestamp with time zone default now(),
  stock integer
);
create table if not exists public.sede_jugadores (
  id bigint not null,
  sede_id integer not null,
  user_id uuid not null,
  estado text default 'activo'::text not null,
  origen text default 'manual'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  created_by uuid,
  desvinculado_at timestamp with time zone,
  notas text
);
create table if not exists public.sede_programas_beneficios (
  id uuid default gen_random_uuid() not null,
  sede_id bigint not null,
  codigo text not null,
  estado text default 'borrador'::text not null,
  meses_base integer default 0 not null,
  meses_desbloqueados integer default 0 not null,
  fecha_inicio date,
  fecha_fin_base date,
  reglas_version text,
  configuracion jsonb default '{}'::jsonb not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.sedes (
  id bigint not null,
  nombre text not null,
  pais text not null,
  ciudad text not null,
  idioma text default 'es'::text not null,
  cantidad_canchas integer,
  horario_apertura text,
  horario_cierre text,
  duracion_reserva_minutos integer default 90 not null,
  precio_por_reserva integer,
  moneda text default 'ARS'::text not null,
  estado text default 'activo'::text not null,
  google_maps_url text,
  google_maps_lat numeric(10,8),
  google_maps_lng numeric(10,8),
  imagen_portada text,
  descripcion_corta text,
  whatsapp_contacto text,
  email_contacto text,
  zona_horaria text default 'America/Argentina/Buenos_Aires'::text not null,
  created_at timestamp without time zone default now(),
  updated_at timestamp without time zone default now(),
  direccion text,
  telefono text,
  precio_turno numeric,
  numero_licencia text,
  fecha_licencia date,
  licencia_activa boolean default true,
  logo_url text,
  fotos_urls jsonb default '[]'::jsonb,
  descripcion text,
  mp_access_token text,
  latitud numeric,
  longitud numeric,
  instagram text,
  facebook text,
  tiktok text,
  twitter text,
  youtube text,
  website text,
  precio_manana numeric,
  precio_tarde numeric,
  color_nombre text,
  color_fondo_logo text default '#000000'::text,
  franjas_horarias jsonb default '[]'::jsonb,
  fotos_destacadas jsonb default '[]'::jsonb,
  color_hero_primario text default '#4C1D95'::text,
  color_hero_secundario text default '#7C3AED'::text,
  color_borde_hero text default '#6D28D9'::text,
  provincia text,
  historia text,
  metodo_pago text default 'mercadopago'::text,
  stripe_account_id text,
  pago_manual_instrucciones text,
  stripe_customer_id text,
  stripe_subscription_id text,
  suscripcion_estado text,
  suscripcion_proximo_cobro timestamp with time zone,
  timezone text default 'America/Argentina/Buenos_Aires'::text,
  anio_fundacion integer,
  tipo_licencia text default 'club_afiliado'::text,
  mp_public_key text,
  slogan text,
  amenities jsonb default '[]'::jsonb,
  precio_60min integer,
  precio_90min integer,
  precio_120min integer,
  foto_portada text,
  surge_activo boolean default false,
  surge_precio_minimo integer,
  surge_precio_maximo integer,
  foto_url text,
  deportes_disponibles text[] default ARRAY['padbol'::text],
  es_prueba boolean default false not null,
  tipo_sede text default 'reservable'::text not null
);
create table if not exists public.sedes_duraciones (
  id bigint not null,
  sede_id bigint,
  duracion_minutos integer not null,
  precio numeric not null,
  activo boolean default true,
  created_at timestamp with time zone default now(),
  deporte text
);
create table if not exists public.sedes_pendientes (
  id bigint not null,
  created_at timestamp with time zone default now(),
  created_by text,
  estado text default 'pendiente'::text,
  motivo_rechazo text,
  nombre text not null,
  direccion text,
  ciudad text,
  pais text,
  latitud numeric,
  longitud numeric,
  horario_apertura text,
  horario_cierre text,
  precio_base numeric,
  moneda text default 'ARS'::text,
  whatsapp text,
  email_contacto text,
  numero_licencia text,
  fecha_contrato date,
  tipo_licencia text default 'club_afiliado'::text,
  licenciatario_nombre text,
  licenciatario_email text,
  licenciatario_telefono text,
  licenciatario_pais text,
  provincia text,
  organizacion_id uuid,
  cantidad_canchas_solicitadas integer
);
create table if not exists public.sedes_precios_por_duracion (
  id integer not null,
  sede_id integer not null,
  duracion_minutos integer not null,
  precio numeric default 0 not null,
  created_at timestamp with time zone default now()
);
create table if not exists public.solicitudes_licencia (
  id uuid default gen_random_uuid() not null,
  nombre_club text not null,
  pais text not null,
  ciudad text not null,
  nombre_responsable text not null,
  email text not null,
  whatsapp text,
  cantidad_canchas integer,
  tipo_interes text,
  mensaje text,
  estado text default 'pendiente'::text,
  created_at timestamp with time zone default now(),
  deportes_canchas jsonb,
  club_nombre text,
  responsable_nombre text,
  club_direccion text,
  provincia_estado text,
  club_telefono text,
  club_email text,
  club_web text,
  responsable_cargo text,
  nombre_legal text,
  numero_fiscal text,
  fiscal_misma_que_club boolean default true not null,
  direccion_fiscal text,
  pais_fiscal text,
  updated_at timestamp with time zone default now() not null,
  whatsapp_followup_consent boolean default false not null,
  whatsapp_followup_consent_source text,
  whatsapp_followup_consent_version text,
  whatsapp_followup_consent_text text,
  whatsapp_followup_consent_at timestamp with time zone,
  idempotency_key text,
  idempotency_payload_hash text
);
create table if not exists public.solicitudes_partido (
  id uuid default gen_random_uuid() not null,
  partido_id bigint,
  solicitante_id uuid,
  estado text default 'pendiente'::text,
  created_at timestamp with time zone default now(),
  expires_at timestamp with time zone
);
create table if not exists public.sponsor_config (
  id integer default 1 not null,
  max_global integer default 5,
  max_por_sede_starter integer default 2,
  max_por_sede_pro integer default 5,
  max_por_sede_elite integer default 20,
  max_por_nacion integer default 3,
  updated_at timestamp with time zone default now(),
  hub_jugar_slots jsonb default '{}'::jsonb,
  deportes text[],
  hub_jugar_ticker jsonb default '[]'::jsonb not null,
  hub_reserva_banner_paso3 jsonb default '{}'::jsonb not null
);
create table if not exists public.sponsors (
  id uuid default gen_random_uuid() not null,
  nombre text not null,
  logo_url text,
  url_destino text,
  texto_boton text default 'Ver oferta'::text,
  scope text not null,
  sede_id integer,
  torneo_id bigint,
  pais text,
  activo boolean default true,
  fecha_desde date,
  fecha_hasta date,
  creado_por uuid,
  created_at timestamp with time zone default now(),
  aprobado boolean default true,
  descripcion text,
  deportes text[],
  formato text default 'ticker'::text,
  banner_url text,
  video_url text,
  tipo_media text default 'imagen'::text,
  scoreboard_placements text[] default ARRAY['ticker'::text, 'game_break'::text, 'rest'::text, 'set_break'::text, 'waiting'::text] not null,
  scoreboard_order integer default 0 not null
);
create table if not exists public.store_catalog_products (
  id bigint not null,
  slug text not null,
  nombre text not null,
  categoria text default 'official_merchandise'::text not null,
  descripcion text,
  imagen_url text,
  activo boolean default true not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.store_central_offers (
  id bigint not null,
  product_id bigint not null,
  activo boolean default false not null,
  stock integer default 0 not null,
  precio numeric(12,2),
  moneda text default 'ARS'::text not null,
  pais_codigo text,
  ciudad text,
  radio_entrega_km numeric(6,2),
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.store_sede_offers (
  id bigint not null,
  sede_id integer not null,
  product_id bigint not null,
  autorizado boolean default false not null,
  autorizado_por_super boolean default false not null,
  activo boolean default false not null,
  precio numeric(12,2),
  moneda text default 'ARS'::text not null,
  stock integer default 0 not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.support_ticket_messages (
  id bigint not null,
  ticket_id bigint not null,
  author_user_id uuid not null,
  author_role text not null,
  body text not null,
  internal boolean default false not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.support_tickets (
  id bigint not null,
  public_id uuid default gen_random_uuid() not null,
  requester_user_id uuid not null,
  requester_email text,
  requester_role text default 'jugador'::text not null,
  sede_id bigint,
  categoria text not null,
  asunto text not null,
  estado text default 'abierto'::text not null,
  prioridad text default 'normal'::text not null,
  assigned_to uuid,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null,
  closed_at timestamp with time zone
);
create table if not exists public.surge_config (
  id bigint not null,
  sede_id bigint,
  deporte text not null,
  precio_minimo integer,
  precio_maximo integer,
  activo boolean default true,
  created_at timestamp with time zone default now(),
  descuento_max_pct integer default 20,
  aumento_max_pct integer default 40,
  updated_at timestamp with time zone default now()
);
create table if not exists public.surge_historial (
  id bigint not null,
  sede_id bigint,
  deporte text not null,
  ocupacion_porcentaje numeric,
  precio_calculado integer,
  precio_base integer,
  multiplicador numeric,
  calculado_en timestamp with time zone default now()
);
create table if not exists public.suspensiones_jugador (
  id uuid default gen_random_uuid() not null,
  user_id uuid not null,
  motivo text default 'cancelaciones_excesivas'::text,
  suspendido_hasta timestamp with time zone not null,
  levantada_por uuid,
  levantada_at timestamp with time zone,
  created_at timestamp with time zone default now()
);
create table if not exists public.tabla_puntos (
  id integer not null,
  torneo_id integer,
  equipo_id integer,
  posicion integer not null,
  puntos integer not null,
  created_at timestamp without time zone default now(),
  deporte text default 'padbol'::text not null
);
create table if not exists public.torneo_fixture_planes (
  torneo_id bigint not null,
  origen text not null,
  actor_id uuid not null,
  equipo_ids bigint[] not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.torneo_homologaciones (
  torneo_id bigint not null,
  referencia_oficial text not null,
  evidencia text not null,
  confirmado_por uuid not null,
  confirmado_at timestamp with time zone default now() not null,
  requisitos_snapshot jsonb not null
);
create table if not exists public.torneo_interes (
  id integer not null,
  sede_id integer not null,
  user_id uuid not null,
  deporte text,
  created_at timestamp with time zone default now()
);
create table if not exists public.torneo_nations_planes (
  torneo_id bigint not null,
  plan jsonb not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.torneo_nations_programacion (
  partido_id bigint not null,
  torneo_id bigint not null,
  court_id bigint not null,
  inicio timestamp with time zone not null,
  duration_minutes integer not null,
  timezone text not null,
  actor_id uuid not null,
  revision bigint not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.torneo_participante_acreditaciones (
  id uuid default gen_random_uuid() not null,
  torneo_id bigint not null,
  participante_id uuid not null,
  user_id uuid not null,
  estado text default 'pendiente'::text not null,
  referencia_oficial text,
  evidencia text,
  resuelto_por uuid,
  resolved_at timestamp with time zone,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.torneo_participante_equipos (
  torneo_id bigint not null,
  participante_id uuid not null,
  equipo_id bigint not null,
  cuenta_user_id uuid
);
create table if not exists public.torneo_participante_operaciones (
  torneo_id bigint not null,
  request_id uuid not null,
  actor_id uuid not null,
  accion text not null,
  payload jsonb not null,
  receipt jsonb not null
);
create table if not exists public.torneo_participante_ranking_cierres (
  torneo_id bigint not null,
  equipo_id bigint not null,
  participantes jsonb not null,
  closed_at timestamp with time zone default now() not null
);
create table if not exists public.torneo_participante_vinculaciones (
  id uuid default gen_random_uuid() not null,
  torneo_id bigint not null,
  participante_id uuid not null,
  user_id uuid not null,
  estado text default 'pendiente'::text not null,
  resuelto_por uuid,
  created_at timestamp with time zone default now() not null,
  resolved_at timestamp with time zone
);
create table if not exists public.torneo_participantes (
  id uuid default gen_random_uuid() not null,
  torneo_id bigint not null,
  sede_id bigint not null,
  nombre text default ''::text not null,
  tipo_identidad text not null,
  origen text not null,
  creado_por uuid not null,
  linked_user_id uuid,
  estado_vinculacion text default 'sin_cuenta'::text not null,
  ranking_oficial_elegible boolean default false not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.torneo_partido_alineaciones (
  partido_id bigint not null,
  equipo_id bigint not null,
  torneo_id bigint not null,
  iniciales uuid[] not null,
  suplentes uuid[] not null,
  revision bigint not null,
  actor_id uuid not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.torneo_partido_participacion (
  partido_id bigint not null,
  torneo_id bigint not null,
  equipo_a_id bigint not null,
  equipo_b_id bigint not null,
  convocados_a uuid[] not null,
  convocados_b uuid[] not null,
  alineacion_revision_a bigint not null,
  alineacion_revision_b bigint not null,
  procedencia text not null,
  resultado_snapshot jsonb not null,
  fuente text not null,
  actor_id uuid,
  registrado_at timestamp with time zone default now() not null
);
create table if not exists public.torneo_partidos_programacion (
  partido_id bigint not null,
  torneo_id bigint not null,
  court_id bigint not null,
  inicio timestamp with time zone not null,
  duration_minutes integer not null,
  actor_id uuid not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.torneo_qa_inscripcion_requests (
  torneo_id bigint not null,
  request_id uuid not null,
  actor_id uuid not null,
  payload jsonb not null,
  equipo_id bigint not null
);
create table if not exists public.torneos (
  id bigint not null,
  nombre text not null,
  sede_id bigint,
  nivel_torneo text default 'club'::text not null,
  tipo_torneo text default 'round_robin'::text not null,
  estado text default 'planificacion'::text not null,
  fecha_inicio date not null,
  fecha_fin date not null,
  cantidad_equipos integer,
  es_multisede boolean default false,
  created_by uuid,
  created_at timestamp without time zone default now(),
  updated_at timestamp without time zone default now(),
  categoria text default 'Libre'::text,
  equipos_por_grupo integer,
  clasificados_por_grupo integer,
  mejores_terceros integer default 0,
  mejores_terceros_clasificados integer default 0,
  costo_inscripcion numeric default 0,
  cupos_maximos integer,
  horas_revelar_equipos integer default 48,
  fecha_apertura_inscripcion timestamp with time zone,
  tipo_torneo_genero text default 'masculino'::text,
  categoria_edad text default 'open'::text,
  inscripcion_monto numeric,
  inscripcion_moneda text default 'ARS'::text,
  premios_descripcion text,
  puntos_total integer,
  deporte text default 'padbol'::text not null,
  formato_equipo text default 'dobles'::text,
  genero text,
  categoria_femenina text,
  fipa_registration_enabled boolean default false not null,
  fipa_registration_deadline timestamp with time zone,
  fipa_delegation_capacity integer,
  fipa_minor_age integer default 18 not null,
  fipa_eligibility_requirements jsonb default '{}'::jsonb not null,
  fipa_required_fields jsonb default '{}'::jsonb not null,
  modalidad_plantel text default 'dobles'::text not null,
  plan_nations jsonb,
  es_prueba boolean default false not null
);
create table if not exists public.user_roles (
  id bigint not null,
  user_id uuid,
  role text not null,
  pais text,
  sede_id bigint,
  created_at timestamp without time zone default now(),
  email text,
  nombre text,
  torneos_oficiales_habilitados boolean default false,
  alcance text default 'sede'::text,
  ciudad text,
  provincia text,
  organizacion_id uuid
);
create table if not exists public.users (
  id uuid default auth.uid() not null,
  email character varying(255) not null,
  full_name character varying(255),
  phone character varying(20),
  whatsapp character varying(20),
  skill_level character varying(50),
  created_at timestamp without time zone default CURRENT_TIMESTAMP,
  updated_at timestamp without time zone default CURRENT_TIMESTAMP,
  foto_perfil text
);
create table if not exists public.webhook_logs (
  id uuid default gen_random_uuid() not null,
  source text not null,
  event_type text,
  mp_payment_id text,
  payload jsonb,
  procesado boolean default false,
  created_at timestamp with time zone default now()
);
create table if not exists public.whatsapp_assistant_classifications (
  id uuid default gen_random_uuid() not null,
  inbound_message_id uuid not null,
  tenant_id uuid not null,
  topic_slug text,
  disposition text not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.whatsapp_assistant_config (
  key text not null,
  value text not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.whatsapp_assistant_operators (
  id uuid default gen_random_uuid() not null,
  display_name text not null,
  external_id text not null,
  active boolean default true not null,
  created_at timestamp with time zone default now() not null
);
create table if not exists public.whatsapp_assistant_responses (
  id uuid default gen_random_uuid() not null,
  topic_slug text not null,
  locale text default 'es'::text not null,
  body text not null,
  active boolean default true not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.whatsapp_assistant_topics (
  slug text not null,
  title_es text not null,
  title_en text not null,
  priority integer default 0 not null,
  active boolean default true not null
);
create table if not exists public.whatsapp_delivery_receipts (
  tenant_id uuid not null,
  channel_id uuid not null,
  provider_message_id text not null,
  recipient_id text not null,
  delivery_status text not null,
  provider_at timestamp with time zone not null,
  error_code integer,
  received_at timestamp with time zone default now() not null
);
create table if not exists public.whatsapp_inbound_messages (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  channel_id uuid not null,
  provider_message_id text not null,
  from_wa_id text not null,
  message_type text not null,
  text_body text not null,
  received_at timestamp with time zone not null,
  created_at timestamp with time zone default now() not null,
  meta_media_id text,
  meta_media_type text
);
create table if not exists public.whatsapp_outbox (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  channel_id uuid not null,
  inbound_message_id uuid not null,
  idempotency_key text not null,
  to_wa_id text not null,
  reply_to_provider_message_id text,
  message_type text default 'text'::text not null,
  text_body text not null,
  status text default 'pending'::text not null,
  attempts integer default 0 not null,
  next_attempt_at timestamp with time zone default now() not null,
  last_attempt_at timestamp with time zone,
  customer_service_window_expires_at timestamp with time zone not null,
  provider_message_id text,
  last_error text,
  sent_at timestamp with time zone,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.whatsapp_tenant_channels (
  id uuid default gen_random_uuid() not null,
  tenant_id uuid not null,
  meta_phone_number_id text not null,
  meta_waba_id text,
  credential_ref text not null,
  auto_reply_text text default 'Gracias por escribir a Padbol Match. Recibimos tu mensaje y continuaremos por aquí.'::text not null,
  active boolean default false not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.whatsapp_tenants (
  id uuid default gen_random_uuid() not null,
  organization_id uuid,
  sede_id bigint,
  display_name text not null,
  status text default 'inactive'::text not null,
  created_at timestamp with time zone default now() not null,
  updated_at timestamp with time zone default now() not null
);
create table if not exists public.xp_transacciones (
  id uuid default gen_random_uuid() not null,
  user_id uuid,
  tipo text not null,
  xp integer not null,
  descripcion text,
  referencia_id uuid,
  created_at timestamp with time zone default now()
);
alter table public.organizacion_sedes add constraint organizacion_sedes_pkey PRIMARY KEY (organizacion_id, sede_id);
alter table public.locations add constraint locations_pkey PRIMARY KEY (id);
alter table public.courts add constraint courts_pkey PRIMARY KEY (id);
alter table public.users add constraint users_pkey PRIMARY KEY (id);
alter table public.reservations add constraint reservations_pkey PRIMARY KEY (id);
alter table public.payments add constraint payments_pkey PRIMARY KEY (id);
alter table public.confirmations add constraint confirmations_pkey PRIMARY KEY (id);
alter table public.reservas add constraint reservas_pkey PRIMARY KEY (id);
alter table public.clientes add constraint clientes_pkey PRIMARY KEY (id);
alter table public.sedes add constraint sedes_pkey PRIMARY KEY (id);
alter table public.horarios_excepcionales add constraint horarios_excepcionales_pkey PRIMARY KEY (id);
alter table public.jugadores add constraint jugadores_pkey PRIMARY KEY (id);
alter table public.user_roles add constraint user_roles_pkey PRIMARY KEY (id);
alter table public.torneos add constraint torneos_pkey PRIMARY KEY (id);
alter table public.jugadores_torneo add constraint jugadores_torneo_pkey PRIMARY KEY (id);
alter table public.equipos add constraint equipos_pkey PRIMARY KEY (id);
alter table public.partidos add constraint partidos_pkey PRIMARY KEY (id);
alter table public.games add constraint games_pkey PRIMARY KEY (id);
alter table public.ranking_jugadores add constraint ranking_jugadores_pkey PRIMARY KEY (id);
alter table public.clasificaciones add constraint clasificaciones_pkey PRIMARY KEY (id);
alter table public.jugadores_perfil add constraint jugadores_perfil_pkey PRIMARY KEY (id);
alter table public.tabla_puntos add constraint tabla_puntos_pkey PRIMARY KEY (id);
alter table public.config_puntos add constraint config_puntos_pkey PRIMARY KEY (id);
alter table public.canchas add constraint canchas_pkey PRIMARY KEY (id);
alter table public.creditos add constraint creditos_pkey PRIMARY KEY (id);
alter table public.sedes_pendientes add constraint sedes_pendientes_pkey PRIMARY KEY (id);
alter table public.lista_espera_torneos add constraint lista_espera_torneos_pkey PRIMARY KEY (id);
alter table public.resenas add constraint resenas_pkey PRIMARY KEY (id);
alter table public.contratos_sedes add constraint contratos_sedes_pkey PRIMARY KEY (id);
alter table public.solicitudes_licencia add constraint solicitudes_licencia_pkey PRIMARY KEY (id);
alter table public.webhook_logs add constraint webhook_logs_pkey PRIMARY KEY (id);
alter table public.busca_dupla_torneo add constraint busca_dupla_torneo_pkey PRIMARY KEY (id);
alter table public.busca_dupla_invitacion add constraint busca_dupla_invitacion_pkey PRIMARY KEY (id);
alter table public.plan_pricing add constraint plan_pricing_pkey PRIMARY KEY (id);
alter table public.canchas_por_deporte add constraint canchas_por_deporte_pkey PRIMARY KEY (id);
alter table public.partidos_abiertos add constraint partidos_abiertos_pkey PRIMARY KEY (id);
alter table public.invitaciones_admin add constraint invitaciones_admin_pkey PRIMARY KEY (id);
alter table public.reservas_historial add constraint reservas_historial_pkey PRIMARY KEY (id);
alter table public.horarios_excepciones add constraint horarios_excepciones_pkey PRIMARY KEY (id);
alter table public.scoreboard_control_sessions add constraint scoreboard_control_sessions_pkey PRIMARY KEY (id);
alter table public.notificaciones add constraint notificaciones_pkey PRIMARY KEY (id);
alter table public.scoreboard_control_actions add constraint scoreboard_control_actions_pkey PRIMARY KEY (session_id, action_id);
alter table public.partidos_abiertos_solicitudes add constraint partidos_abiertos_solicitudes_pkey PRIMARY KEY (id);
alter table public.hub_config add constraint hub_config_pkey PRIMARY KEY (id);
alter table public.extras add constraint extras_pkey PRIMARY KEY (id);
alter table public.equipos_usuario add constraint equipos_usuario_pkey PRIMARY KEY (id);
alter table public.equipos_jugadores add constraint equipos_jugadores_pkey PRIMARY KEY (id);
alter table public.notificaciones_zona_interes add constraint notificaciones_zona_interes_pkey PRIMARY KEY (id);
alter table public.lista_espera_general add constraint lista_espera_general_pkey PRIMARY KEY (id);
alter table public.sponsors add constraint sponsors_pkey PRIMARY KEY (id);
alter table public.crm_prospects add constraint crm_prospects_pkey PRIMARY KEY (id);
alter table public.sponsor_config add constraint sponsor_config_pkey PRIMARY KEY (id);
alter table public.hub_promo_global add constraint hub_promo_global_pkey PRIMARY KEY (id);
alter table public.hub_promo_sede add constraint hub_promo_sede_pkey PRIMARY KEY (id);
alter table public.hub_deporte_config add constraint hub_deporte_config_pkey PRIMARY KEY (id);
alter table public.sedes_duraciones add constraint sedes_duraciones_pkey PRIMARY KEY (id);
alter table public.sede_extras add constraint sede_extras_pkey PRIMARY KEY (id);
alter table public.profesores add constraint profesores_pkey PRIMARY KEY (id);
alter table public.clases add constraint clases_pkey PRIMARY KEY (id);
alter table public.membresias add constraint membresias_pkey PRIMARY KEY (id);
alter table public.clases_horarios add constraint clases_horarios_pkey PRIMARY KEY (id);
alter table public.inscripciones_clases add constraint inscripciones_clases_pkey PRIMARY KEY (id);
alter table public.sedes_precios_por_duracion add constraint sedes_precios_por_duracion_pkey PRIMARY KEY (id);
alter table public.precios_por_deporte add constraint precios_por_deporte_pkey PRIMARY KEY (id);
alter table public.partidos_abiertos_jugadores add constraint partidos_abiertos_jugadores_pkey PRIMARY KEY (id);
alter table public.clases_reservas add constraint clases_reservas_pkey PRIMARY KEY (id);
alter table public.notificaciones_admin_log add constraint notificaciones_admin_log_pkey PRIMARY KEY (id);
alter table public.crm_whatsapp_menu_reconciliation add constraint crm_whatsapp_menu_reconciliation_pkey PRIMARY KEY (id);
alter table public.solicitudes_partido add constraint solicitudes_partido_pkey PRIMARY KEY (id);
alter table public.resenas_sedes add constraint resenas_sedes_pkey PRIMARY KEY (id);
alter table public.jugador_rankings add constraint jugador_rankings_pkey PRIMARY KEY (id);
alter table public.rankings_leaderboard add constraint rankings_leaderboard_pkey PRIMARY KEY (id);
alter table public.cancelaciones_jugador add constraint cancelaciones_jugador_pkey PRIMARY KEY (id);
alter table public.suspensiones_jugador add constraint suspensiones_jugador_pkey PRIMARY KEY (id);
alter table public.torneo_interes add constraint torneo_interes_pkey PRIMARY KEY (id);
alter table public.push_tokens add constraint push_tokens_pkey PRIMARY KEY (id);
alter table public.logros_jugador add constraint logros_jugador_pkey PRIMARY KEY (id);
alter table public.xp_transacciones add constraint xp_transacciones_pkey PRIMARY KEY (id);
alter table public.push_web_subscriptions add constraint push_web_subscriptions_pkey PRIMARY KEY (id);
alter table public.logros_premios add constraint logros_premios_pkey PRIMARY KEY (id);
alter table public.rangos_historial add constraint rangos_historial_pkey PRIMARY KEY (id);
alter table public.ligas_premios add constraint ligas_premios_pkey PRIMARY KEY (id);
alter table public.scoreboard_partidos add constraint scoreboard_partidos_pkey PRIMARY KEY (id);
alter table public.scoreboard_sponsors add constraint scoreboard_sponsors_pkey PRIMARY KEY (id);
alter table public.surge_config add constraint surge_config_pkey PRIMARY KEY (id);
alter table public.surge_historial add constraint surge_historial_pkey PRIMARY KEY (id);
alter table public.scoreboard_jugadores_temp add constraint scoreboard_jugadores_temp_pkey PRIMARY KEY (id);
alter table public.scoreboard_historial_puntos add constraint scoreboard_historial_puntos_pkey PRIMARY KEY (id);
alter table public.franjas_precio add constraint franjas_precio_pkey PRIMARY KEY (id);
alter table public.partido_resumenes add constraint partido_resumenes_pkey PRIMARY KEY (id);
alter table public.padcoins_saldo add constraint padcoins_saldo_pkey PRIMARY KEY (id);
alter table public.padcoins_movimientos add constraint padcoins_movimientos_pkey PRIMARY KEY (id);
alter table public.premios_canjeables add constraint premios_canjeables_pkey PRIMARY KEY (id);
alter table public.padcoins_canjes add constraint padcoins_canjes_pkey PRIMARY KEY (id);
alter table public.padcoins_global_config add constraint padcoins_global_config_pkey PRIMARY KEY (id);
alter table public.padcoins_sede_config add constraint padcoins_sede_config_pkey PRIMARY KEY (id);
alter table public.crm_whatsapp_automation_releases add constraint crm_whatsapp_automation_releases_pkey PRIMARY KEY (conversation_id);
alter table public.padcoins_campaigns add constraint padcoins_campaigns_pkey PRIMARY KEY (id);
alter table public.padcoins_campaign_audit_logs add constraint padcoins_campaign_audit_logs_pkey PRIMARY KEY (id);
alter table public.padcoins_campaign_applications add constraint padcoins_campaign_applications_pkey PRIMARY KEY (id);
alter table public.padbol_match_setup_status add constraint padbol_match_setup_status_pkey PRIMARY KEY (id);
alter table public.jugadores_identidad add constraint jugadores_identidad_pkey PRIMARY KEY (user_id);
alter table public.jugadores_aceptaciones add constraint jugadores_aceptaciones_pkey PRIMARY KEY (id);
alter table public.match_participants add constraint match_participants_pkey PRIMARY KEY (id);
alter table public.match_reward_events add constraint match_reward_events_pkey PRIMARY KEY (id);
alter table public.match_attendance_audit_log add constraint match_attendance_audit_log_pkey PRIMARY KEY (id);
alter table public.comunidad_publicaciones add constraint comunidad_publicaciones_pkey PRIMARY KEY (id);
alter table public.comunidad_comentarios add constraint comunidad_comentarios_pkey PRIMARY KEY (id);
alter table public.comunidad_reacciones add constraint comunidad_reacciones_pkey PRIMARY KEY (id);
alter table public.comunidad_seguimientos add constraint comunidad_seguimientos_pkey PRIMARY KEY (id);
alter table public.comunidad_bloqueos add constraint comunidad_bloqueos_pkey PRIMARY KEY (id);
alter table public.comunidad_denuncias add constraint comunidad_denuncias_pkey PRIMARY KEY (id);
alter table public.membresia_planes add constraint membresia_planes_pkey PRIMARY KEY (id);
alter table public.membresias_sede add constraint membresias_sede_pkey PRIMARY KEY (id);
alter table public.membresia_usos_reserva add constraint membresia_usos_reserva_pkey PRIMARY KEY (id);
alter table public.sede_jugadores add constraint sede_jugadores_pkey PRIMARY KEY (id);
alter table public.crm_whatsapp_automation_release_audit add constraint crm_whatsapp_automation_release_audit_pkey PRIMARY KEY (id);
alter table public.crm_prospect_runs add constraint crm_prospect_runs_pkey PRIMARY KEY (id);
alter table public.crm_prospect_campaigns add constraint crm_prospect_campaigns_pkey PRIMARY KEY (id);
alter table public.admin_push_notifications add constraint admin_push_notifications_pkey PRIMARY KEY (id);
alter table public.comunidad_medios add constraint comunidad_medios_pkey PRIMARY KEY (id);
alter table public.content_ad_slots add constraint content_ad_slots_pkey PRIMARY KEY (id);
alter table public.jugador_nivel_externo add constraint jugador_nivel_externo_pkey PRIMARY KEY (id);
alter table public.content_editor_drafts add constraint content_editor_drafts_pkey PRIMARY KEY (id);
alter table public.fipa_ranking_operators add constraint fipa_ranking_operators_pkey PRIMARY KEY (user_id);
alter table public.fipa_ranking_links add constraint fipa_ranking_links_pkey PRIMARY KEY (source_key);
alter table public.store_catalog_products add constraint store_catalog_products_pkey PRIMARY KEY (id);
alter table public.store_sede_offers add constraint store_sede_offers_pkey PRIMARY KEY (id);
alter table public.store_central_offers add constraint store_central_offers_pkey PRIMARY KEY (id);
alter table public.crm_message_translations add constraint crm_message_translations_pkey PRIMARY KEY (cache_key);
alter table public.fipa_ranking_claim_invites add constraint fipa_ranking_claim_invites_pkey PRIMARY KEY (id);
alter table public.support_tickets add constraint support_tickets_pkey PRIMARY KEY (id);
alter table public.support_ticket_messages add constraint support_ticket_messages_pkey PRIMARY KEY (id);
alter table public.documentos_legales add constraint documentos_legales_pkey PRIMARY KEY (id);
alter table public.news_articles add constraint news_articles_pkey PRIMARY KEY (id);
alter table public.news_article_events add constraint news_article_events_pkey PRIMARY KEY (id);
alter table public.recorridos_externos add constraint recorridos_externos_pkey PRIMARY KEY (id);
alter table public.fipa_documents add constraint fipa_documents_pkey PRIMARY KEY (id);
alter table public.fipa_registrations add constraint fipa_registrations_pkey PRIMARY KEY (id);
alter table public.fipa_registration_players add constraint fipa_registration_players_pkey PRIMARY KEY (id);
alter table public.fipa_player_files add constraint fipa_player_files_pkey PRIMARY KEY (id);
alter table public.fipa_legal_representatives add constraint fipa_legal_representatives_pkey PRIMARY KEY (id);
alter table public.fipa_acceptances add constraint fipa_acceptances_pkey PRIMARY KEY (id);
alter table public.fipa_invitations add constraint fipa_invitations_pkey PRIMARY KEY (id);
alter table public.fipa_offline_authorizations add constraint fipa_offline_authorizations_pkey PRIMARY KEY (id);
alter table public.fipa_organizer_access add constraint fipa_organizer_access_pkey PRIMARY KEY (id);
alter table public.fipa_audit_log add constraint fipa_audit_log_pkey PRIMARY KEY (id);
alter table public.academy_profiles add constraint academy_profiles_pkey PRIMARY KEY (id);
alter table public.academy_enrollments add constraint academy_enrollments_pkey PRIMARY KEY (id);
alter table public.academy_progress add constraint academy_progress_pkey PRIMARY KEY (id);
alter table public.academy_quiz_attempts add constraint academy_quiz_attempts_pkey PRIMARY KEY (id);
alter table public.academy_certificates add constraint academy_certificates_pkey PRIMARY KEY (id);
alter table public.crm_prospect_territories add constraint crm_prospect_territories_pkey PRIMARY KEY (territory_key);
alter table public.push_notification_preferences add constraint push_notification_preferences_pkey PRIMARY KEY (user_id);
alter table public.fipa_ranking_claim_audit add constraint fipa_ranking_claim_audit_pkey PRIMARY KEY (id);
alter table public.crm_contacts add constraint crm_contacts_pkey PRIMARY KEY (id);
alter table public.crm_conversations add constraint crm_conversations_pkey PRIMARY KEY (id);
alter table public.crm_channel_attempts add constraint crm_channel_attempts_pkey PRIMARY KEY (id);
alter table public.crm_replies add constraint crm_replies_pkey PRIMARY KEY (id);
alter table public.ng_inscripcion_eventos add constraint ng_inscripcion_eventos_pkey PRIMARY KEY (id);
alter table public.crm_activities add constraint crm_activities_pkey PRIMARY KEY (id);
alter table public.crm_inbound_events add constraint crm_inbound_events_pkey PRIMARY KEY (id);
alter table public.ng_solicitudes_sede add constraint ng_solicitudes_sede_pkey PRIMARY KEY (id);
alter table public.ng_sesiones add constraint ng_sesiones_pkey PRIMARY KEY (id);
alter table public.ng_inscripciones add constraint ng_inscripciones_pkey PRIMARY KEY (id);
alter table public.ng_inscripcion_participantes add constraint ng_inscripcion_participantes_pkey PRIMARY KEY (id);
alter table public.organizaciones add constraint organizaciones_pkey PRIMARY KEY (id);
alter table public.whatsapp_tenants add constraint whatsapp_tenants_pkey PRIMARY KEY (id);
alter table public.torneo_partido_alineaciones add constraint torneo_partido_alineaciones_pkey PRIMARY KEY (partido_id, equipo_id);
alter table public.whatsapp_tenant_channels add constraint whatsapp_tenant_channels_pkey PRIMARY KEY (id);
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_messages_pkey PRIMARY KEY (id);
alter table public.whatsapp_outbox add constraint whatsapp_outbox_pkey PRIMARY KEY (id);
alter table public.whatsapp_assistant_config add constraint whatsapp_assistant_config_pkey PRIMARY KEY (key);
alter table public.whatsapp_assistant_topics add constraint whatsapp_assistant_topics_pkey PRIMARY KEY (slug);
alter table public.scoreboard_partial_correction_audit add constraint scoreboard_partial_correction_audit_pkey PRIMARY KEY (id);
alter table public.whatsapp_assistant_responses add constraint whatsapp_assistant_responses_pkey PRIMARY KEY (id);
alter table public.whatsapp_assistant_operators add constraint whatsapp_assistant_operators_pkey PRIMARY KEY (id);
alter table public.whatsapp_assistant_classifications add constraint whatsapp_assistant_classifications_pkey PRIMARY KEY (id);
alter table public.push_delivery_jobs add constraint push_delivery_jobs_pkey PRIMARY KEY (id);
alter table public.push_delivery_attempts add constraint push_delivery_attempts_pkey PRIMARY KEY (id);
alter table public.push_token_audit add constraint push_token_audit_pkey PRIMARY KEY (id);
alter table public.push_preference_audit add constraint push_preference_audit_pkey PRIMARY KEY (id);
alter table public.sede_programas_beneficios add constraint sede_programas_beneficios_pkey PRIMARY KEY (id);
alter table public.sede_beneficio_progreso add constraint sede_beneficio_progreso_pkey PRIMARY KEY (id);
alter table public.torneo_partido_participacion add constraint torneo_partido_participacion_pkey PRIMARY KEY (partido_id);
alter table public.torneo_nations_planes add constraint torneo_nations_planes_pkey PRIMARY KEY (torneo_id);
alter table public.torneo_nations_programacion add constraint torneo_nations_programacion_pkey PRIMARY KEY (partido_id);
alter table public.cuentas_elegibilidad_legal add constraint cuentas_elegibilidad_legal_pkey PRIMARY KEY (user_id);
alter table public.torneo_qa_inscripcion_requests add constraint torneo_qa_inscripcion_requests_pkey PRIMARY KEY (torneo_id, request_id);
alter table public.torneo_fixture_planes add constraint torneo_fixture_planes_pkey PRIMARY KEY (torneo_id);
alter table public.torneo_partidos_programacion add constraint torneo_partidos_programacion_pkey PRIMARY KEY (partido_id);
alter table public.crm_commercial_followups add constraint crm_commercial_followups_pkey PRIMARY KEY (id);
alter table public.torneo_participantes add constraint torneo_participantes_pkey PRIMARY KEY (id);
alter table public.torneo_participante_equipos add constraint torneo_participante_equipos_pkey PRIMARY KEY (torneo_id, participante_id);
alter table public.torneo_participante_vinculaciones add constraint torneo_participante_vinculaciones_pkey PRIMARY KEY (id);
alter table public.torneo_participante_operaciones add constraint torneo_participante_operaciones_pkey PRIMARY KEY (torneo_id, request_id);
alter table public.torneo_homologaciones add constraint torneo_homologaciones_pkey PRIMARY KEY (torneo_id);
alter table public.torneo_participante_acreditaciones add constraint torneo_participante_acreditaciones_pkey PRIMARY KEY (id);
alter table public.torneo_participante_ranking_cierres add constraint torneo_participante_ranking_cierres_pkey PRIMARY KEY (torneo_id, equipo_id);
alter table public.crm_whatsapp_manual_attempts add constraint crm_whatsapp_manual_attempts_pkey PRIMARY KEY (reply_id);
alter table public.crm_form_welcome_dispatches add constraint crm_form_welcome_dispatches_pkey PRIMARY KEY (id);
alter table public.crm_whatsapp_review_log add constraint crm_whatsapp_review_log_pkey PRIMARY KEY (id);
alter table public.fipa_ranking_requests add constraint fipa_ranking_requests_pkey PRIMARY KEY (id);
alter table public.app_launch_events add constraint app_launch_events_pkey PRIMARY KEY (id);
alter table public.crm_whatsapp_context_sync add constraint crm_whatsapp_context_sync_pkey PRIMARY KEY (inbound_event_id);
alter table public.crm_test_visibility_audit add constraint crm_test_visibility_audit_pkey PRIMARY KEY (id);
alter table public.crm_whatsapp_menu_events add constraint crm_whatsapp_menu_events_pkey PRIMARY KEY (inbound_message_id);
alter table public.crm_whatsapp_processing_decisions add constraint crm_whatsapp_processing_decisions_pkey PRIMARY KEY (inbound_message_id);
alter table public.scoreboard_linked_suspend_candidate add constraint scoreboard_linked_suspend_candidate_pkey PRIMARY KEY (scoreboard_id);
alter table public.scoreboard_resumption_history_candidate add constraint scoreboard_resumption_history_candidate_pkey PRIMARY KEY (id);
alter table public.scoreboard_court_occupancy_candidate add constraint scoreboard_court_occupancy_candidate_pkey PRIMARY KEY (scoreboard_id);
alter table public.scoreboard_transition_receipt_isolated_candidate add constraint scoreboard_transition_receipt_isolated_candidate_pkey PRIMARY KEY (action_id);
alter table public.scoreboard_transition_cancelled_isolated_candidate add constraint scoreboard_transition_cancelled_isolated_candidate_pkey PRIMARY KEY (action_id);
alter table public.scoreboard_suspension_reason_isolated_candidate add constraint scoreboard_suspension_reason_isolated_candidate_pkey PRIMARY KEY (action_id);
alter table public.manual_player_booking_receipts add constraint manual_player_booking_receipts_pkey PRIMARY KEY (reference);
alter table public.crm_commercial_cases add constraint crm_commercial_cases_pkey PRIMARY KEY (id);
alter table public.crm_commercial_case_inbound add constraint crm_commercial_case_inbound_pkey PRIMARY KEY (inbound_event_id);
alter table public.crm_commercial_case_replies add constraint crm_commercial_case_replies_pkey PRIMARY KEY (reply_id);
alter table public.crm_commercial_case_send_attempts add constraint crm_commercial_case_send_attempts_pkey PRIMARY KEY (reply_id);
alter table public.crm_commercial_advisors add constraint crm_commercial_advisors_pkey PRIMARY KEY (user_id);
alter table public.crm_commercial_team_audit add constraint crm_commercial_team_audit_pkey PRIMARY KEY (id);
alter table public.crm_commercial_form_cases add constraint crm_commercial_form_cases_pkey PRIMARY KEY (conversation_id);
alter table public.crm_commercial_team_activities add constraint crm_commercial_team_activities_pkey PRIMARY KEY (id);
alter table public.crm_commercial_team_calls add constraint crm_commercial_team_calls_pkey PRIMARY KEY (id);
alter table public.crm_commercial_form_send_attempts add constraint crm_commercial_form_send_attempts_pkey PRIMARY KEY (reply_id);
alter table public.crm_commercial_advisor_requests add constraint crm_commercial_advisor_requests_pkey PRIMARY KEY (id);
alter table public.content_workspace_items add constraint content_workspace_items_pkey PRIMARY KEY (id);
alter table public.content_workspace_history add constraint content_workspace_history_pkey PRIMARY KEY (id);
alter table public.content_workspace_files add constraint content_workspace_files_pkey PRIMARY KEY (id);
alter table public.content_meta_audit add constraint content_meta_audit_pkey PRIMARY KEY (id);
alter table public.crm_commercial_followup_dispatches add constraint crm_commercial_followup_dispatches_pkey PRIMARY KEY (id);
alter table public.crm_commercial_followup_optouts add constraint crm_commercial_followup_optouts_pkey PRIMARY KEY (recipient_wa_id);
alter table public.content_workspace_coordinators add constraint content_workspace_coordinators_pkey PRIMARY KEY (user_id);
alter table public.content_workspace_access_history add constraint content_workspace_access_history_pkey PRIMARY KEY (id);
alter table public.content_meta_imports add constraint content_meta_imports_pkey PRIMARY KEY (id);
alter table public.content_meta_rows add constraint content_meta_rows_pkey PRIMARY KEY (import_id, day, entity_id);
alter table public.content_meta_daily_sources add constraint content_meta_daily_sources_pkey PRIMARY KEY (account_id, level, day);
alter table public.content_meta_sync_runs add constraint content_meta_sync_runs_pkey PRIMARY KEY (account_id, until_day);
alter table public.content_meta_monitor_alerts add constraint content_meta_monitor_alerts_pkey PRIMARY KEY (account_id, until_day, entity_id, kind);
alter table public.content_meta_sync_events add constraint content_meta_sync_events_pkey PRIMARY KEY (id);
alter table public.crm_email_provider_receipts add constraint crm_email_provider_receipts_pkey PRIMARY KEY (reply_id);
alter table public.crm_email_return_pending add constraint crm_email_return_pending_pkey PRIMARY KEY (id);
alter table public.crm_email_return_queue_audit add constraint crm_email_return_queue_audit_pkey PRIMARY KEY (id);
alter table public.crm_commercial_email_triage add constraint crm_commercial_email_triage_pkey PRIMARY KEY (conversation_id);
alter table public.crm_commercial_email_triage_audit add constraint crm_commercial_email_triage_audit_pkey PRIMARY KEY (id);
alter table public.whatsapp_delivery_receipts add constraint whatsapp_delivery_receipts_pkey PRIMARY KEY (tenant_id, channel_id, provider_message_id, recipient_id, delivery_status, provider_at);
alter table public.crm_lead_alerts add constraint crm_lead_alerts_pkey PRIMARY KEY (id);
alter table public.crm_prospect_settings add constraint crm_prospect_settings_pkey PRIMARY KEY (singleton);
alter table public.crm_prospect_campaign_steps add constraint crm_prospect_campaign_steps_pkey PRIMARY KEY (id);
alter table public.crm_prospect_messages add constraint crm_prospect_messages_pkey PRIMARY KEY (id);
alter table public.crm_prospect_events add constraint crm_prospect_events_pkey PRIMARY KEY (id);
alter table public.crm_prospect_suppressions add constraint crm_prospect_suppressions_pkey PRIMARY KEY (id);
alter table public.crm_lead_notifications add constraint crm_lead_notifications_pkey PRIMARY KEY (id);
alter table public.crm_space_requests add constraint crm_space_requests_pkey PRIMARY KEY (id);
alter table public.crm_ab_campaigns add constraint crm_ab_campaigns_pkey PRIMARY KEY (id);
alter table public.crm_ab_assignments add constraint crm_ab_assignments_pkey PRIMARY KEY (id);
alter table public.academy_payment_grants add constraint academy_payment_grants_pkey PRIMARY KEY (session_id);
alter table public.nations_activation_events add constraint nations_activation_events_pkey PRIMARY KEY (torneo_id);
alter table public.nations_activation_delegates add constraint nations_activation_delegates_pkey PRIMARY KEY (torneo_id, country, user_id);
alter table public.nations_activation_participants add constraint nations_activation_participants_pkey PRIMARY KEY (participante_id);
alter table public.nations_activation_imports add constraint nations_activation_imports_pkey PRIMARY KEY (torneo_id, batch_id);
alter table public.nations_activation_invites add constraint nations_activation_invites_pkey PRIMARY KEY (id);
alter table public.nations_activation_audit add constraint nations_activation_audit_pkey PRIMARY KEY (id);
alter table public.organizacion_sedes add constraint organizacion_sedes_sede_unica UNIQUE (sede_id);
alter table public.locations add constraint locations_name_key UNIQUE (name);
alter table public.courts add constraint courts_location_id_court_number_key UNIQUE (location_id, court_number);
alter table public.users add constraint users_email_key UNIQUE (email);
alter table public.clientes add constraint clientes_email_key UNIQUE (email);
alter table public.jugadores add constraint jugadores_documento_key UNIQUE (documento);
alter table public.tabla_puntos add constraint tabla_puntos_torneo_id_equipo_id_key UNIQUE (torneo_id, equipo_id);
alter table public.config_puntos add constraint config_puntos_clave_key UNIQUE (clave);
alter table public.jugadores_perfil add constraint jugadores_perfil_email_key UNIQUE (email);
alter table public.jugadores_perfil add constraint alias_unique UNIQUE (alias);
alter table public.resenas add constraint resenas_sede_id_user_id_key UNIQUE (sede_id, user_id);
alter table public.busca_dupla_torneo add constraint busca_dupla_torneo_torneo_id_user_id_key UNIQUE (torneo_id, user_id);
alter table public.partidos_abiertos add constraint partidos_abiertos_share_token_key UNIQUE (share_token);
alter table public.invitaciones_admin add constraint invitaciones_admin_token_key UNIQUE (token);
alter table public.scoreboard_control_sessions add constraint scoreboard_control_sessions_token_hash_key UNIQUE (token_hash);
alter table public.scoreboard_control_sessions add constraint scoreboard_control_sessions_pairing_code_hash_key UNIQUE (pairing_code_hash);
alter table public.crm_conversations add constraint crm_conversations_id_channel_key UNIQUE (id, source_channel);
alter table public.membresias add constraint membresias_user_id_key UNIQUE (user_id);
alter table public.equipos_jugadores add constraint equipos_jugadores_equipo_id_email_key UNIQUE (equipo_id, email);
alter table public.hub_deporte_config add constraint hub_deporte_config_deporte_card_key_key UNIQUE (deporte, card_key);
alter table public.crm_prospects add constraint crm_prospects_dedupe_key_key UNIQUE (dedupe_key);
alter table public.hub_deporte_config add constraint hub_deporte_config_deporte_card_key_uniq UNIQUE (deporte, card_key);
alter table public.clases_reservas add constraint clases_reservas_clase_id_user_id_key UNIQUE (clase_id, user_id);
alter table public.inscripciones_clases add constraint inscripciones_clases_clase_id_user_id_fecha_hora_inicio_key UNIQUE (clase_id, user_id, fecha, hora_inicio);
alter table public.sedes_precios_por_duracion add constraint sedes_precios_por_duracion_sede_id_duracion_minutos_key UNIQUE (sede_id, duracion_minutos);
alter table public.reservas add constraint reservas_qr_token_key UNIQUE (qr_token);
alter table public.precios_por_deporte add constraint precios_por_deporte_sede_id_deporte_key UNIQUE (sede_id, deporte);
alter table public.partidos_abiertos_jugadores add constraint partidos_abiertos_jugadores_partido_id_user_id_key UNIQUE (partido_id, user_id);
alter table public.lista_espera_general add constraint lista_espera_general_sede_id_user_id_deporte_key UNIQUE (sede_id, user_id, deporte);
alter table public.crm_whatsapp_menu_reconciliation add constraint crm_whatsapp_menu_reconciliation_outbox_id_key UNIQUE (outbox_id);
alter table public.jugador_rankings add constraint jugador_rankings_user_id_deporte_temporada_key UNIQUE (user_id, deporte, temporada);
alter table public.rankings_leaderboard add constraint rankings_leaderboard_user_id_deporte_nivel_temporada_key UNIQUE (user_id, deporte, nivel, temporada);
alter table public.torneo_interes add constraint torneo_interes_sede_id_user_id_key UNIQUE (sede_id, user_id);
alter table public.logros_jugador add constraint logros_jugador_user_id_slug_key UNIQUE (user_id, slug);
alter table public.logros_premios add constraint logros_premios_sede_id_logro_slug_key UNIQUE (sede_id, logro_slug);
alter table public.ligas_premios add constraint ligas_premios_sede_id_liga_key UNIQUE (sede_id, liga);
alter table public.surge_config add constraint surge_config_sede_id_deporte_key UNIQUE (sede_id, deporte);
alter table public.scoreboard_jugadores_temp add constraint scoreboard_jugadores_temp_partido_equipo_slot_unique UNIQUE (partido_id, equipo, slot);
alter table public.franjas_precio add constraint franjas_precio_sede_id_deporte_dia_semana_hora_inicio_hora__key UNIQUE (sede_id, deporte, dia_semana, hora_inicio, hora_fin);
alter table public.partido_resumenes add constraint partido_resumenes_unique_payload UNIQUE (partido_id, source_type, payload_hash);
alter table public.padcoins_saldo add constraint padcoins_saldo_user_id_unique UNIQUE (user_id);
alter table public.padcoins_canjes add constraint padcoins_canjes_codigo_unique UNIQUE (codigo);
alter table public.padcoins_global_config add constraint padcoins_global_config_key_unique UNIQUE (key);
alter table public.padcoins_sede_config add constraint padcoins_sede_config_sede_unique UNIQUE (sede_id);
alter table public.padbol_match_setup_status add constraint padbol_match_setup_status_sede_id_unique UNIQUE (sede_id);
alter table public.comunidad_medios add constraint comunidad_medios_storage_path_key UNIQUE (storage_path);
alter table public.push_web_subscriptions add constraint push_web_subscriptions_endpoint_key UNIQUE (endpoint);
alter table public.content_ad_slots add constraint content_ad_slots_deporte_slot_key_key UNIQUE (deporte, slot_key);
alter table public.jugador_nivel_externo add constraint jugador_nivel_externo_user_deporte_unique UNIQUE (user_id, deporte);
alter table public.content_editor_drafts add constraint content_editor_drafts_content_type_deporte_item_key_key UNIQUE (content_type, deporte, item_key);
alter table public.store_catalog_products add constraint store_catalog_products_slug_key UNIQUE (slug);
alter table public.store_sede_offers add constraint store_sede_offers_sede_id_product_id_key UNIQUE (sede_id, product_id);
alter table public.fipa_ranking_links add constraint fipa_ranking_links_user_id_key UNIQUE (user_id);
alter table public.support_tickets add constraint support_tickets_public_id_key UNIQUE (public_id);
alter table public.documentos_legales add constraint documentos_legales_tipo_version_unique UNIQUE (tipo, version);
alter table public.fipa_ranking_claim_invites add constraint fipa_ranking_claim_invites_token_hash_key UNIQUE (token_hash);
alter table public.news_articles add constraint news_articles_slug_key UNIQUE (slug);
alter table public.fipa_documents add constraint fipa_documents_torneo_id_code_version_language_key UNIQUE (torneo_id, code, version, language);
alter table public.fipa_registrations add constraint fipa_registrations_torneo_id_country_key UNIQUE (torneo_id, country);
alter table public.fipa_registration_players add constraint fipa_registration_players_registration_id_email_key UNIQUE (registration_id, email);
alter table public.fipa_legal_representatives add constraint fipa_legal_representatives_player_id_key UNIQUE (player_id);
alter table public.fipa_invitations add constraint fipa_invitations_token_hash_key UNIQUE (token_hash);
alter table public.fipa_organizer_access add constraint fipa_organizer_access_torneo_id_user_id_key UNIQUE (torneo_id, user_id);
alter table public.academy_enrollments add constraint academy_enrollments_user_id_course_id_key UNIQUE (user_id, course_id);
alter table public.academy_progress add constraint academy_progress_user_id_course_id_lesson_id_key UNIQUE (user_id, course_id, lesson_id);
alter table public.academy_certificates add constraint academy_certificates_user_id_course_id_key UNIQUE (user_id, course_id);
alter table public.crm_conversations add constraint crm_conversations_attempt_ref_unique UNIQUE (attempt_id, source_channel, source_ref);
alter table public.crm_channel_attempts add constraint crm_channel_attempts_attempt_id_key UNIQUE (attempt_id);
alter table public.crm_inbound_events add constraint crm_inbound_events_source_unique UNIQUE (source_channel, origin, source_ref);
alter table public.whatsapp_tenant_channels add constraint whatsapp_tenant_channels_tenant_id_id_unique UNIQUE (tenant_id, id);
alter table public.whatsapp_tenant_channels add constraint whatsapp_tenant_channels_phone_number_id_unique UNIQUE (meta_phone_number_id);
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_messages_tenant_channel_id_unique UNIQUE (tenant_id, channel_id, id);
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_messages_provider_unique UNIQUE (tenant_id, provider_message_id);
alter table public.whatsapp_outbox add constraint whatsapp_outbox_idempotency_unique UNIQUE (tenant_id, idempotency_key);
alter table public.whatsapp_assistant_responses add constraint whatsapp_assistant_responses_topic_slug_locale_key UNIQUE (topic_slug, locale);
alter table public.whatsapp_assistant_operators add constraint whatsapp_assistant_operators_external_id_unique UNIQUE (external_id);
alter table public.push_delivery_jobs add constraint push_delivery_jobs_idempotency_key_key UNIQUE (idempotency_key);
alter table public.sede_programas_beneficios add constraint sede_programas_beneficios_sede_id_codigo_key UNIQUE (sede_id, codigo);
alter table public.sede_beneficio_progreso add constraint sede_beneficio_progreso_programa_id_periodo_key UNIQUE (programa_id, periodo);
alter table public.torneo_participantes add constraint torneo_participantes_torneo_id_linked_user_id_key UNIQUE (torneo_id, linked_user_id);
alter table public.torneo_participantes add constraint torneo_participantes_torneo_id_id_key UNIQUE (torneo_id, id);
alter table public.torneo_participante_equipos add constraint torneo_participante_equipos_torneo_id_cuenta_user_id_key UNIQUE (torneo_id, cuenta_user_id);
alter table public.torneo_participante_vinculaciones add constraint torneo_participante_vinculaciones_participante_id_user_id_key UNIQUE (participante_id, user_id);
alter table public.torneo_participante_acreditaciones add constraint torneo_participante_acreditaciones_participante_id_user_id_key UNIQUE (participante_id, user_id);
alter table public.crm_form_welcome_dispatches add constraint crm_form_welcome_dispatches_event_id_key UNIQUE (event_id);
alter table public.fipa_ranking_requests add constraint fipa_ranking_requests_source_key_user_id_key UNIQUE (source_key, user_id);
alter table public.crm_whatsapp_context_sync add constraint crm_whatsapp_context_sync_conversation_id_revision_key UNIQUE (conversation_id, revision);
alter table public.crm_conversations add constraint crm_conversations_ticket_number_unique UNIQUE (ticket_number);
alter table public.crm_commercial_cases add constraint crm_commercial_cases_id_conversation_id_key UNIQUE (id, conversation_id);
alter table public.crm_commercial_advisors add constraint crm_commercial_advisors_email_key UNIQUE (email);
alter table public.crm_form_welcome_dispatches add constraint crm_form_welcome_dispatches_recipient_wa_id_key UNIQUE (recipient_wa_id);
alter table public.content_workspace_files add constraint content_workspace_files_storage_path_key UNIQUE (storage_path);
alter table public.crm_commercial_followup_dispatches add constraint crm_commercial_followup_dispatches_plan_id_step_key UNIQUE (plan_id, step);
alter table public.content_workspace_coordinators add constraint content_workspace_coordinators_email_key UNIQUE (email);
alter table public.content_meta_imports add constraint content_meta_imports_account_id_level_sha256_key UNIQUE (account_id, level, sha256);
alter table public.crm_email_provider_receipts add constraint crm_email_provider_receipts_provider_message_id_key UNIQUE (provider_message_id);
alter table public.crm_email_provider_receipts add constraint crm_email_provider_receipts_rfc_message_id_key UNIQUE (rfc_message_id);
alter table public.crm_email_return_pending add constraint crm_email_return_pending_external_id_key UNIQUE (external_id);
alter table public.crm_lead_alerts add constraint crm_lead_alerts_case_type_case_id_cycle_key UNIQUE (case_type, case_id, cycle);
alter table public.crm_prospect_campaign_steps add constraint crm_prospect_campaign_steps_campaign_id_day_key UNIQUE (campaign_id, day);
alter table public.crm_prospect_messages add constraint crm_prospect_messages_idempotency_key_key UNIQUE (idempotency_key);
alter table public.crm_lead_notifications add constraint crm_lead_notifications_user_id_case_type_case_id_key UNIQUE (user_id, case_type, case_id);
alter table public.crm_ab_campaigns add constraint crm_ab_campaigns_campaign_key_key UNIQUE (campaign_key);
alter table public.crm_ab_assignments add constraint crm_ab_assignments_campaign_id_contact_id_key UNIQUE (campaign_id, contact_id);
alter table public.nations_activation_events add constraint nations_activation_events_slug_key UNIQUE (slug);
alter table public.nations_activation_participants add constraint nations_activation_participants_torneo_id_row_key_key UNIQUE (torneo_id, row_key);
alter table public.nations_activation_invites add constraint nations_activation_invites_token_hash_key UNIQUE (token_hash);
alter table public.crm_replies add constraint crm_replies_support_protocol_check CHECK ((support_protocol = 1));
alter table public.scoreboard_control_sessions add constraint scoreboard_control_sessions_device_id_check CHECK (((device_id IS NULL) OR ((char_length(device_id) >= 3) AND (char_length(device_id) <= 128))));
alter table public.resenas add constraint resenas_estrellas_check CHECK (((estrellas >= 1) AND (estrellas <= 5)));
alter table public.partidos_abiertos add constraint partidos_abiertos_jugadores_check CHECK ((jugadores_requeridos > 1));
alter table public.invitaciones_admin add constraint invitaciones_admin_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'completada'::text, 'expirada'::text, 'cancelada'::text])));
alter table public.sedes add constraint sedes_anio_fundacion_check CHECK (((anio_fundacion IS NULL) OR ((anio_fundacion >= 1800) AND (anio_fundacion <= 2100))));
alter table public.partidos_abiertos add constraint partidos_abiertos_deporte_check CHECK ((deporte = ANY (ARRAY['padbol'::text, 'padel'::text, 'pickleball'::text, 'futbol_5'::text, 'futbol_7'::text])));
alter table public.sedes_pendientes add constraint sedes_pendientes_cantidad_canchas_solicitadas_check CHECK (((cantidad_canchas_solicitadas IS NULL) OR (cantidad_canchas_solicitadas > 0)));
alter table public.partidos_abiertos_solicitudes add constraint solicitudes_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'aceptada'::text, 'rechazada'::text])));
alter table public.sedes add constraint sedes_metodo_pago_check CHECK ((metodo_pago = ANY (ARRAY['mercadopago'::text, 'stripe'::text, 'manual'::text, 'efectivo'::text])));
alter table public.crm_prospect_settings add constraint crm_prospect_settings_singleton_check CHECK (singleton);
alter table public.sponsors add constraint sponsors_scope_check CHECK ((scope = ANY (ARRAY['global'::text, 'sede'::text, 'torneo'::text, 'nacional'::text])));
alter table public.clases add constraint clases_tipo_check CHECK ((tipo = ANY (ARRAY['individual'::text, 'grupal'::text])));
alter table public.clases_horarios add constraint clases_horarios_dia_semana_check CHECK (((dia_semana >= 0) AND (dia_semana <= 6)));
alter table public.inscripciones_clases add constraint inscripciones_clases_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'confirmada'::text, 'cancelada'::text])));
alter table public.crm_conversations add constraint crm_conversations_support_protocol_check CHECK ((support_protocol = 1));
alter table public.push_web_subscriptions add constraint push_web_subscriptions_failure_count_check CHECK ((failure_count >= 0));
alter table public.resenas_sedes add constraint resenas_sedes_estrellas_check CHECK (((estrellas >= 1) AND (estrellas <= 5)));
alter table public.scoreboard_jugadores_temp add constraint scoreboard_jugadores_temp_equipo_check CHECK ((equipo = ANY (ARRAY['a'::text, 'b'::text])));
alter table public.padcoins_movimientos add constraint padcoins_movimientos_saldo_antes_nonneg CHECK ((saldo_antes >= 0));
alter table public.scoreboard_jugadores_temp add constraint scoreboard_jugadores_temp_slot_check CHECK (((slot >= 1) AND (slot <= 4)));
alter table public.franjas_precio add constraint franjas_precio_deporte_check CHECK ((deporte = ANY (ARRAY['padbol'::text, 'padel'::text, 'pickleball'::text, 'tenis'::text])));
alter table public.franjas_precio add constraint franjas_precio_dia_semana_check CHECK (((dia_semana >= 0) AND (dia_semana <= 6)));
alter table public.franjas_precio add constraint hora_fin_mayor CHECK ((hora_fin > hora_inicio));
alter table public.partido_resumenes add constraint partido_resumenes_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'generated'::text, 'failed'::text, 'skipped'::text])));
alter table public.solicitudes_partido add constraint solicitudes_partido_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'aceptado'::text, 'rechazado'::text, 'invitado'::text, 'expirado'::text, 'cancelado'::text, 'conflicto'::text])));
alter table public.partidos add constraint partidos_siguiente_slot_check CHECK (((partido_siguiente_id IS NULL) OR (partido_siguiente_slot = ANY (ARRAY['A'::text, 'B'::text]))));
alter table public.partidos add constraint partidos_siguiente_no_self_check CHECK (((partido_siguiente_id IS NULL) OR (partido_siguiente_id <> id)));
alter table public.padcoins_saldo add constraint padcoins_saldo_disponible_nonneg CHECK ((disponible >= 0));
alter table public.padcoins_saldo add constraint padcoins_saldo_historico_total_nonneg CHECK ((historico_total >= 0));
alter table public.padcoins_movimientos add constraint padcoins_movimientos_tipo_check CHECK ((tipo = ANY (ARRAY['earn'::text, 'spend'::text, 'adjust'::text, 'reverse'::text])));
alter table public.padcoins_movimientos add constraint padcoins_movimientos_monto_nonzero CHECK ((monto <> 0));
alter table public.padcoins_movimientos add constraint padcoins_movimientos_saldo_despues_nonneg CHECK ((saldo_despues >= 0));
alter table public.premios_canjeables add constraint premios_canjeables_costo_positivo CHECK ((costo_padcoins > 0));
alter table public.premios_canjeables add constraint premios_canjeables_stock_total_nonneg CHECK (((stock_total IS NULL) OR (stock_total >= 0)));
alter table public.premios_canjeables add constraint premios_canjeables_stock_disponible_nonneg CHECK (((stock_disponible IS NULL) OR (stock_disponible >= 0)));
alter table public.padcoins_canjes add constraint padcoins_canjes_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'aprobado'::text, 'entregado'::text, 'cancelado'::text, 'vencido'::text])));
alter table public.padcoins_canjes add constraint padcoins_canjes_monto_positivo CHECK ((monto_padcoins > 0));
alter table public.padcoins_global_config add constraint padcoins_global_config_key_nonempty CHECK ((char_length(TRIM(BOTH FROM key)) > 0));
alter table public.padcoins_campaigns add constraint padcoins_campaigns_name_nonempty CHECK ((char_length(TRIM(BOTH FROM name)) > 0));
alter table public.padcoins_campaigns add constraint padcoins_campaigns_type_check CHECK ((campaign_type = ANY (ARRAY['multiplier'::text, 'percentage_override'::text, 'fixed_padcoins'::text, 'benefit_equivalent'::text])));
alter table public.padcoins_campaigns add constraint padcoins_campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'active'::text, 'paused'::text, 'ended'::text])));
alter table public.padcoins_campaigns add constraint padcoins_campaigns_dates_check CHECK ((end_at > start_at));
alter table public.padcoins_campaigns add constraint padcoins_campaigns_multiplier_nonneg CHECK (((multiplier IS NULL) OR (multiplier >= (0)::numeric)));
alter table public.padcoins_campaigns add constraint padcoins_campaigns_loyalty_pct_nonneg CHECK (((loyalty_percentage_override IS NULL) OR (loyalty_percentage_override >= 0)));
alter table public.padcoins_campaigns add constraint padcoins_campaigns_fixed_nonneg CHECK (((fixed_padcoins IS NULL) OR (fixed_padcoins >= 0)));
alter table public.padcoins_campaigns add constraint padcoins_campaigns_max_total_nonneg CHECK (((max_total_uses IS NULL) OR (max_total_uses > 0)));
alter table public.padcoins_campaigns add constraint padcoins_campaigns_max_player_nonneg CHECK (((max_uses_per_player IS NULL) OR (max_uses_per_player > 0)));
alter table public.padcoins_campaigns add constraint padcoins_campaigns_estimated_cost_nonneg CHECK (((estimated_cost_reference IS NULL) OR (estimated_cost_reference >= 0)));
alter table public.padcoins_campaign_audit_logs add constraint padcoins_campaign_audit_action_nonempty CHECK ((char_length(TRIM(BOTH FROM action)) > 0));
alter table public.padcoins_campaign_applications add constraint padcoins_campaign_applications_base_nonneg CHECK ((base_padcoins >= 0));
alter table public.padcoins_campaign_applications add constraint padcoins_campaign_applications_final_nonneg CHECK ((final_padcoins >= 0));
alter table public.jugadores_identidad add constraint jugadores_identidad_tipo_documento_check CHECK (((tipo_documento IS NULL) OR (tipo_documento = ANY (ARRAY['dni'::text, 'pasaporte'::text, 'cedula'::text, 'otro'::text]))));
alter table public.jugadores_identidad add constraint jugadores_identidad_genero_check CHECK (((genero IS NULL) OR (genero = ANY (ARRAY['masculino'::text, 'femenino'::text, 'otro'::text, 'prefiero_no_decir'::text]))));
alter table public.jugadores_identidad add constraint jugadores_identidad_identidad_estado_check CHECK ((identidad_estado = ANY (ARRAY['incompleta'::text, 'pendiente_revision'::text, 'verificada'::text, 'rechazada'::text])));
alter table public.match_participants add constraint match_participants_role_check CHECK ((role = ANY (ARRAY['organizer'::text, 'participant'::text])));
alter table public.match_participants add constraint match_participants_source_check CHECK ((source = ANY (ARRAY['reservation'::text, 'join'::text, 'scoreboard'::text, 'manual'::text, 'admin'::text])));
alter table public.match_participants add constraint match_participants_attendance_status_check CHECK ((attendance_status = ANY (ARRAY['pending'::text, 'confirmed'::text, 'denied'::text, 'admin_validated'::text, 'excluded'::text])));
alter table public.match_participants add constraint match_participants_reward_status_check CHECK ((reward_status = ANY (ARRAY['pending'::text, 'eligible'::text, 'credited'::text, 'skipped'::text, 'reversed'::text])));
alter table public.match_reward_events add constraint match_reward_events_reward_type_check CHECK ((reward_type = ANY (ARRAY['padcoins'::text, 'xp'::text, 'ranking'::text])));
alter table public.match_reward_events add constraint match_reward_events_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'credited'::text, 'skipped'::text, 'reversed'::text])));
alter table public.partidos_abiertos add constraint partidos_abiertos_attendance_collection_status_check CHECK ((attendance_collection_status = ANY (ARRAY['none'::text, 'open'::text, 'expired'::text, 'ready'::text, 'credited'::text, 'blocked'::text])));
alter table public.match_participants add constraint match_participants_attendance_response_source_check CHECK (((attendance_response_source IS NULL) OR (attendance_response_source = ANY (ARRAY['player'::text, 'admin'::text, 'system_timeout'::text, 'system_legacy'::text]))));
alter table public.match_attendance_audit_log add constraint match_attendance_audit_action_nonempty CHECK ((char_length(TRIM(BOTH FROM action)) > 0));
alter table public.premios_canjeables add constraint premios_canjeables_limite_usuario_nonneg CHECK (((limite_usuario_cantidad IS NULL) OR (limite_usuario_cantidad >= 0)));
alter table public.premios_canjeables add constraint premios_canjeables_limite_global_nonneg CHECK (((limite_global_cantidad IS NULL) OR (limite_global_cantidad >= 0)));
alter table public.premios_canjeables add constraint premios_canjeables_canje_validez_pos CHECK (((canje_validez_dias IS NULL) OR (canje_validez_dias > 0)));
alter table public.premios_canjeables add constraint premios_canjeables_limite_usuario_periodo_check CHECK (((limite_usuario_periodo IS NULL) OR (limite_usuario_periodo = ANY (ARRAY['dia'::text, 'semana'::text, 'mes'::text, 'total'::text]))));
alter table public.premios_canjeables add constraint premios_canjeables_limite_global_periodo_check CHECK (((limite_global_periodo IS NULL) OR (limite_global_periodo = ANY (ARRAY['dia'::text, 'semana'::text, 'mes'::text, 'total'::text]))));
alter table public.canchas add constraint canchas_cantidad_jugadores_range_chk CHECK (((cantidad_jugadores IS NULL) OR ((cantidad_jugadores >= 1) AND (cantidad_jugadores <= 40))));
alter table public.canchas add constraint canchas_modalidad_custom_chk CHECK (((modalidad_custom IS NULL) OR (modalidad_custom = ANY (ARRAY['individual'::text, 'parejas'::text, 'equipos'::text]))));
alter table public.canchas add constraint canchas_duracion_sugerida_min_range_chk CHECK (((duracion_sugerida_min IS NULL) OR ((duracion_sugerida_min >= 15) AND (duracion_sugerida_min <= 240))));
alter table public.equipos_usuario add constraint equipos_usuario_visibilidad_chk CHECK ((visibilidad = ANY (ARRAY['abierto'::text, 'cerrado'::text])));
alter table public.equipos_jugadores add constraint equipos_jugadores_tipo_chk CHECK ((tipo = ANY (ARRAY['invitacion'::text, 'solicitud'::text])));
alter table public.equipos_jugadores add constraint equipos_jugadores_estado_chk CHECK ((estado = ANY (ARRAY['pendiente'::text, 'aceptado'::text, 'rechazado'::text, 'cancelado'::text, 'vencido'::text])));
alter table public.comunidad_publicaciones add constraint comunidad_publicaciones_visibilidad_chk CHECK ((visibilidad = ANY (ARRAY['publica'::text, 'seguidores'::text])));
alter table public.comunidad_publicaciones add constraint comunidad_publicaciones_estado_chk CHECK ((estado = ANY (ARRAY['activa'::text, 'ocultada'::text, 'eliminada'::text])));
alter table public.comunidad_comentarios add constraint comunidad_comentarios_estado_chk CHECK ((estado = ANY (ARRAY['activo'::text, 'eliminado'::text, 'ocultado'::text])));
alter table public.comunidad_reacciones add constraint comunidad_reacciones_tipo_chk CHECK ((tipo = 'like'::text));
alter table public.comunidad_seguimientos add constraint comunidad_seguimientos_no_self_chk CHECK ((follower_user_id <> following_user_id));
alter table public.comunidad_bloqueos add constraint comunidad_bloqueos_no_self_chk CHECK ((blocker_user_id <> blocked_user_id));
alter table public.comunidad_denuncias add constraint comunidad_denuncias_objeto_chk CHECK ((objeto_tipo = ANY (ARRAY['publicacion'::text, 'comentario'::text])));
alter table public.comunidad_denuncias add constraint comunidad_denuncias_estado_chk CHECK ((estado = ANY (ARRAY['pendiente'::text, 'revisada'::text, 'descartada'::text])));
alter table public.membresia_planes add constraint membresia_planes_duracion_tipo_chk CHECK ((duracion_tipo = ANY (ARRAY['mensual'::text, 'trimestral'::text, 'semestral'::text, 'anual'::text, 'dias'::text])));
alter table public.membresias_sede add constraint membresias_sede_estado_chk CHECK ((estado = ANY (ARRAY['pendiente'::text, 'activa'::text, 'suspendida'::text, 'vencida'::text, 'cancelada'::text])));
alter table public.membresias_sede add constraint membresias_sede_origen_chk CHECK ((origen = ANY (ARRAY['manual'::text, 'pago'::text, 'promocion'::text])));
alter table public.sede_jugadores add constraint sede_jugadores_estado_chk CHECK ((estado = ANY (ARRAY['activo'::text, 'inactivo'::text])));
alter table public.sede_jugadores add constraint sede_jugadores_origen_chk CHECK ((origen = ANY (ARRAY['manual'::text, 'reserva'::text, 'torneo'::text, 'membresia'::text, 'importacion'::text])));
alter table public.crm_prospect_runs add constraint crm_prospect_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'completed'::text, 'failed'::text, 'simulated'::text])));
alter table public.crm_prospect_campaigns add constraint crm_prospect_campaigns_language_check CHECK ((language = ANY (ARRAY['en'::text, 'es'::text])));
alter table public.crm_prospect_campaigns add constraint crm_prospect_campaigns_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_approval'::text, 'approved'::text, 'active'::text, 'paused'::text, 'completed'::text, 'stopped'::text])));
alter table public.admin_push_notifications add constraint admin_push_notifications_admin_role_check CHECK ((admin_role = ANY (ARRAY['super_admin'::text, 'admin_nacional'::text, 'admin_club'::text])));
alter table public.crm_prospect_campaigns add constraint crm_prospect_campaigns_daily_limit_check CHECK (((daily_limit >= 1) AND (daily_limit <= 200)));
alter table public.crm_space_requests add constraint crm_space_requests_active_hold_reason CHECK (((project_active_hold = false) OR ((NULLIF(TRIM(BOTH FROM project_hold_reason), ''::text) IS NOT NULL) AND (NULLIF(TRIM(BOTH FROM project_hold_set_by), ''::text) IS NOT NULL) AND (project_hold_set_at IS NOT NULL) AND (media_deleted_at IS NULL))));
alter table public.admin_push_notifications add constraint admin_push_notifications_segment_type_check CHECK ((segment_type = ANY (ARRAY['todos_usuarios'::text, 'todos_pais'::text, 'pais'::text, 'sede'::text, 'sede_mia'::text, 'deporte'::text, 'jugador'::text])));
alter table public.admin_push_notifications add constraint admin_push_notifications_recipients_check CHECK ((recipients >= 0));
alter table public.admin_push_notifications add constraint admin_push_notifications_sent_count_check CHECK ((sent_count >= 0));
alter table public.admin_push_notifications add constraint admin_push_notifications_status_check CHECK ((status = ANY (ARRAY['sent'::text, 'failed'::text])));
alter table public.comunidad_medios add constraint comunidad_medios_tipo_check CHECK ((tipo = ANY (ARRAY['foto'::text, 'video'::text])));
alter table public.comunidad_medios add constraint comunidad_medios_orden_check CHECK ((orden >= 0));
alter table public.comunidad_medios add constraint comunidad_medios_estado_check CHECK ((estado = ANY (ARRAY['subiendo'::text, 'listo'::text, 'fallido'::text, 'ocultado'::text])));
alter table public.comunidad_medios add constraint comunidad_medios_dimensiones_validas CHECK ((((ancho IS NULL) OR (ancho > 0)) AND ((alto IS NULL) OR (alto > 0)) AND ((duracion_ms IS NULL) OR (duracion_ms >= 0))));
alter table public.hub_deporte_config add constraint hub_deporte_config_media_type_check CHECK ((media_type = ANY (ARRAY['image'::text, 'video'::text])));
alter table public.content_ad_slots add constraint content_ad_slots_media_type_check CHECK ((media_type = ANY (ARRAY['image'::text, 'video'::text])));
alter table public.jugador_nivel_externo add constraint jugador_nivel_externo_deporte_check CHECK ((deporte = 'padel'::text));
alter table public.jugador_nivel_externo add constraint jugador_nivel_externo_plataforma_check CHECK ((plataforma = ANY (ARRAY['playtomic'::text, 'otra'::text])));
alter table public.jugador_nivel_externo add constraint jugador_nivel_externo_estado_check CHECK ((estado = ANY (ARRAY['declarado'::text, 'validado'::text, 'ajustado'::text, 'en_revision'::text])));
alter table public.content_editor_drafts add constraint content_editor_drafts_content_type_check CHECK ((content_type = ANY (ARRAY['hub'::text, 'ad'::text])));
alter table public.content_editor_drafts add constraint content_editor_drafts_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_review'::text, 'rejected'::text, 'approved'::text])));
alter table public.fipa_ranking_links add constraint fipa_ranking_links_source_key_check CHECK ((source_key ~ '^[0-9a-f]{64}$'::text));
alter table public.store_sede_offers add constraint store_sede_offers_precio_check CHECK (((precio IS NULL) OR (precio >= (0)::numeric)));
alter table public.store_sede_offers add constraint store_sede_offers_stock_check CHECK ((stock >= 0));
alter table public.store_central_offers add constraint store_central_offers_stock_check CHECK ((stock >= 0));
alter table public.store_central_offers add constraint store_central_offers_precio_check CHECK (((precio IS NULL) OR (precio >= (0)::numeric)));
alter table public.store_central_offers add constraint store_central_offers_radio_entrega_km_check CHECK (((radio_entrega_km IS NULL) OR (radio_entrega_km >= (0)::numeric)));
alter table public.fipa_ranking_claim_invites add constraint fipa_ranking_claim_invites_source_key_check CHECK ((source_key ~ '^[0-9a-f]{64}$'::text));
alter table public.user_roles add constraint user_roles_role_check CHECK ((role = ANY (ARRAY['super_admin'::text, 'admin_nacional'::text, 'admin_club'::text, 'empleado'::text, 'editor_contenido'::text])));
alter table public.fipa_ranking_claim_invites add constraint fipa_ranking_claim_invites_verification_note_check CHECK (((length(verification_note) >= 10) AND (length(verification_note) <= 500)));
alter table public.fipa_ranking_claim_invites add constraint fipa_ranking_claim_invites_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'used'::text, 'cancelled'::text])));
alter table public.torneos add constraint torneos_formato_equipo_chk CHECK ((formato_equipo = ANY (ARRAY['singles'::text, 'dobles'::text, 'equipo_5'::text, 'equipo_7'::text])));
alter table public.sponsors add constraint sponsors_tipo_media_check CHECK ((tipo_media = ANY (ARRAY['imagen'::text, 'video'::text])));
alter table public.support_tickets add constraint support_tickets_requester_role_check CHECK ((requester_role = ANY (ARRAY['jugador'::text, 'sede'::text])));
alter table public.fipa_acceptances add constraint fipa_acceptances_signer_type_check CHECK ((signer_type = ANY (ARRAY['player'::text, 'representative'::text, 'association'::text])));
alter table public.support_tickets add constraint support_tickets_categoria_check CHECK ((categoria = ANY (ARRAY['reservas'::text, 'pagos'::text, 'torneos'::text, 'cuenta'::text, 'configuracion'::text, 'tecnico'::text, 'otro'::text])));
alter table public.support_tickets add constraint support_tickets_asunto_check CHECK (((char_length(asunto) >= 4) AND (char_length(asunto) <= 160)));
alter table public.support_tickets add constraint support_tickets_estado_check CHECK ((estado = ANY (ARRAY['abierto'::text, 'en_revision'::text, 'esperando_usuario'::text, 'resuelto'::text, 'cerrado'::text])));
alter table public.support_tickets add constraint support_tickets_prioridad_check CHECK ((prioridad = ANY (ARRAY['baja'::text, 'normal'::text, 'alta'::text, 'urgente'::text])));
alter table public.support_ticket_messages add constraint support_ticket_messages_author_role_check CHECK ((author_role = ANY (ARRAY['jugador'::text, 'sede'::text, 'soporte'::text])));
alter table public.documentos_legales add constraint documentos_legales_sha256_check CHECK ((contenido_sha256 ~ '^[0-9a-f]{64}$'::text));
alter table public.support_ticket_messages add constraint support_ticket_messages_body_check CHECK (((char_length(body) >= 1) AND (char_length(body) <= 5000)));
alter table public.news_articles add constraint news_articles_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'in_review'::text, 'changes_requested'::text, 'approved'::text, 'published'::text, 'archived'::text])));
alter table public.news_articles add constraint news_articles_locale_check CHECK ((locale ~ '^[a-z]{2}(-[A-Z]{2})?$'::text));
alter table public.news_articles add constraint news_articles_slug_check CHECK (((slug ~ '^[a-z0-9]+(?:-[a-z0-9]+)*$'::text) AND ((char_length(slug) >= 3) AND (char_length(slug) <= 120))));
alter table public.news_articles add constraint news_articles_title_check CHECK (((char_length(title) >= 12) AND (char_length(title) <= 90)));
alter table public.fipa_acceptances add constraint fipa_acceptances_language_check CHECK ((language = ANY (ARRAY['es'::text, 'en'::text])));
alter table public.news_articles add constraint news_articles_excerpt_check CHECK (((char_length(excerpt) >= 40) AND (char_length(excerpt) <= 240)));
alter table public.news_articles add constraint news_articles_body_check CHECK (((char_length(body) >= 300) AND (char_length(body) <= 12000)));
alter table public.news_articles add constraint news_articles_author_name_check CHECK (((char_length(author_name) >= 3) AND (char_length(author_name) <= 90)));
alter table public.news_articles add constraint news_articles_alt_check CHECK (((char_length(hero_image_alt) >= 8) AND (char_length(hero_image_alt) <= 160)));
alter table public.news_articles add constraint news_articles_focal_x_check CHECK (((hero_focal_x >= 0) AND (hero_focal_x <= 100)));
alter table public.news_articles add constraint news_articles_focal_y_check CHECK (((hero_focal_y >= 0) AND (hero_focal_y <= 100)));
alter table public.news_articles add constraint news_articles_social_title_check CHECK (((social_title IS NULL) OR ((char_length(social_title) >= 12) AND (char_length(social_title) <= 90))));
alter table public.news_articles add constraint news_articles_social_excerpt_check CHECK (((social_excerpt IS NULL) OR ((char_length(social_excerpt) >= 30) AND (char_length(social_excerpt) <= 200))));
alter table public.news_articles add constraint news_articles_published_check CHECK (((status <> 'published'::text) OR (published_at IS NOT NULL)));
alter table public.news_article_events add constraint news_article_events_type_check CHECK ((event_type = ANY (ARRAY['created'::text, 'updated'::text, 'submitted'::text, 'changes_requested'::text, 'approved'::text, 'published'::text, 'archived'::text])));
alter table public.recorridos_externos add constraint recorridos_externos_estado_check CHECK ((estado = ANY (ARRAY['recibido'::text, 'en_revision'::text, 'requiere_informacion'::text, 'aprobado'::text, 'rechazado'::text])));
alter table public.sponsors add constraint sponsors_scoreboard_placements_check CHECK ((scoreboard_placements <@ ARRAY['ticker'::text, 'game_break'::text, 'rest'::text, 'set_break'::text, 'waiting'::text]));
alter table public.fipa_documents add constraint fipa_documents_language_check CHECK ((language = ANY (ARRAY['es'::text, 'en'::text])));
alter table public.documentos_legales add constraint documentos_legales_tipo_check CHECK ((tipo = ANY (ARRAY['terminos'::text, 'privacidad'::text])));
alter table public.fipa_documents add constraint fipa_documents_signer_type_check CHECK ((signer_type = ANY (ARRAY['player'::text, 'representative'::text, 'both'::text, 'association'::text])));
alter table public.fipa_registrations add constraint fipa_registrations_status_check CHECK ((status = ANY (ARRAY['draft'::text, 'pending_player'::text, 'pending_representative'::text, 'pending_association'::text, 'ready_fipa_validation'::text, 'fipa_review'::text, 'approved'::text, 'observed'::text, 'rejected'::text, 'withdrawn'::text, 'cancelled'::text])));
alter table public.fipa_registration_players add constraint fipa_registration_players_status_check CHECK ((status = ANY (ARRAY['pending_player'::text, 'pending_representative'::text, 'complete'::text, 'observed'::text, 'rejected'::text, 'withdrawn'::text])));
alter table public.fipa_player_files add constraint fipa_player_files_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'accepted'::text, 'observed'::text, 'rejected'::text])));
alter table public.fipa_acceptances add constraint fipa_acceptances_status_check CHECK ((status = ANY (ARRAY['accepted'::text, 'pending'::text, 'rejected'::text, 'revoked'::text])));
alter table public.fipa_invitations add constraint fipa_invitations_invitee_type_check CHECK ((invitee_type = ANY (ARRAY['player'::text, 'representative'::text])));
alter table public.fipa_offline_authorizations add constraint fipa_offline_authorizations_language_check CHECK ((language = ANY (ARRAY['es'::text, 'en'::text])));
alter table public.fipa_offline_authorizations add constraint fipa_offline_authorizations_signer_type_check CHECK ((signer_type = ANY (ARRAY['player'::text, 'representative'::text])));
alter table public.academy_certificates add constraint academy_certificates_certificate_type_check CHECK ((certificate_type = ANY (ARRAY['padbol'::text, 'fipa'::text])));
alter table public.crm_contacts add constraint crm_contacts_email_or_phone_check CHECK (((email_normalized IS NOT NULL) OR (phone_normalized IS NOT NULL)));
alter table public.crm_contacts add constraint crm_contacts_email_check CHECK (((email_normalized IS NULL) OR (email_normalized ~ '^[^@]+@[^@]+$'::text)));
alter table public.crm_contacts add constraint crm_contacts_phone_check CHECK (((phone_normalized IS NULL) OR (phone_normalized ~ '^[0-9]{8,15}$'::text)));
alter table public.crm_contacts add constraint crm_contacts_nombre_check CHECK (((nombre IS NULL) OR ((length(TRIM(BOTH FROM nombre)) >= 1) AND (length(TRIM(BOTH FROM nombre)) <= 160))));
alter table public.crm_conversations add constraint crm_conversations_channel_check CHECK ((source_channel = ANY (ARRAY['whatsapp'::text, 'email'::text])));
alter table public.crm_conversations add constraint crm_conversations_source_ref_check CHECK (((length(source_ref) >= 1) AND (length(source_ref) <= 512)));
alter table public.crm_conversations add constraint crm_conversations_estado_check CHECK ((estado = ANY (ARRAY['nuevo'::text, 'en_atencion'::text, 'derivado'::text, 'cerrado'::text])));
alter table public.crm_channel_attempts add constraint crm_channel_attempts_channel_check CHECK ((channel = ANY (ARRAY['whatsapp'::text, 'email'::text])));
alter table public.organizaciones add constraint organizaciones_estado_check CHECK ((estado = ANY (ARRAY['activa'::text, 'pausada'::text, 'baja'::text])));
alter table public.crm_channel_attempts add constraint crm_channel_attempts_attempt_check CHECK (((length(attempt_id) >= 1) AND (length(attempt_id) <= 256)));
alter table public.crm_replies add constraint crm_replies_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sent'::text, 'cancelled'::text])));
alter table public.crm_conversations add constraint crm_conversations_origin_check CHECK (((length(TRIM(BOTH FROM origin)) >= 1) AND (length(TRIM(BOTH FROM origin)) <= 120)));
alter table public.crm_conversations add constraint crm_conversations_qualification_status_check CHECK ((qualification_status = ANY (ARRAY['pending'::text, 'in_progress'::text, 'qualified'::text, 'disqualified'::text, 'needs_review'::text])));
alter table public.crm_conversations add constraint crm_conversations_subject_check CHECK (((subject IS NULL) OR ((length(subject) >= 1) AND (length(subject) <= 512))));
alter table public.crm_conversations add constraint crm_conversations_inbound_body_check CHECK (((inbound_body IS NULL) OR ((length(inbound_body) >= 1) AND (length(inbound_body) <= 4000))));
alter table public.crm_conversations add constraint crm_conversations_funnel_state_check CHECK (((length(TRIM(BOTH FROM funnel_state)) >= 1) AND (length(TRIM(BOTH FROM funnel_state)) <= 120)));
alter table public.crm_conversations add constraint crm_conversations_selected_path_check CHECK (((selected_path IS NULL) OR ((length(TRIM(BOTH FROM selected_path)) >= 1) AND (length(TRIM(BOTH FROM selected_path)) <= 120))));
alter table public.crm_conversations add constraint crm_conversations_qualification_data_check CHECK ((jsonb_typeof(qualification_data) = 'object'::text));
alter table public.crm_conversations add constraint crm_conversations_qualification_question_count_check CHECK ((((qualification_question_count >= 0) AND (qualification_question_count <= 3)) OR ((selected_path = 'national'::text) AND (qualification_question_count = 4))));
alter table public.crm_conversations add constraint crm_conversations_next_prompt_check CHECK (((next_prompt IS NULL) OR ((length(TRIM(BOTH FROM next_prompt)) >= 1) AND (length(TRIM(BOTH FROM next_prompt)) <= 2000))));
alter table public.crm_conversations add constraint crm_conversations_prompt_options_check CHECK ((jsonb_typeof(prompt_options) = 'array'::text));
alter table public.crm_conversations add constraint crm_conversations_next_step_check CHECK (((next_step IS NULL) OR ((length(TRIM(BOTH FROM next_step)) >= 1) AND (length(TRIM(BOTH FROM next_step)) <= 2000))));
alter table public.crm_conversations add constraint crm_conversations_handoff_ready_check CHECK (((NOT handoff_ready) OR (qualification_status = 'qualified'::text)));
alter table public.whatsapp_outbox add constraint whatsapp_outbox_type_check CHECK ((message_type = 'text'::text));
alter table public.crm_activities add constraint crm_activities_summary_check CHECK (((length(TRIM(BOTH FROM summary)) >= 1) AND (length(TRIM(BOTH FROM summary)) <= 2000)));
alter table public.crm_activities add constraint crm_activities_outcome_check CHECK (((outcome IS NULL) OR ((length(TRIM(BOTH FROM outcome)) >= 1) AND (length(TRIM(BOTH FROM outcome)) <= 2000))));
alter table public.crm_activities add constraint crm_activities_next_step_check CHECK (((next_step IS NULL) OR ((length(TRIM(BOTH FROM next_step)) >= 1) AND (length(TRIM(BOTH FROM next_step)) <= 2000))));
alter table public.ng_inscripciones add constraint ng_inscripciones_estado_check CHECK ((estado = ANY (ARRAY['borrador'::text, 'confirmada'::text, 'en_espera'::text, 'cancelada'::text])));
alter table public.crm_activities add constraint crm_activities_author_check CHECK (((length(TRIM(BOTH FROM author)) >= 3) AND (length(TRIM(BOTH FROM author)) <= 254)));
alter table public.crm_inbound_events add constraint crm_inbound_events_channel_check CHECK ((source_channel = ANY (ARRAY['whatsapp'::text, 'email'::text])));
alter table public.crm_inbound_events add constraint crm_inbound_events_source_ref_check CHECK (((length(source_ref) >= 1) AND (length(source_ref) <= 512)));
alter table public.crm_inbound_events add constraint crm_inbound_events_origin_check CHECK (((length(TRIM(BOTH FROM origin)) >= 1) AND (length(TRIM(BOTH FROM origin)) <= 120)));
alter table public.crm_inbound_events add constraint crm_inbound_events_subject_check CHECK (((subject IS NULL) OR ((length(subject) >= 1) AND (length(subject) <= 512))));
alter table public.crm_inbound_events add constraint crm_inbound_events_body_check CHECK (((body IS NULL) OR ((length(body) >= 1) AND (length(body) <= 4000))));
alter table public.crm_conversations add constraint crm_conversations_assignment_check CHECK ((((sede_id IS NULL) AND (assigned_by IS NULL) AND (assigned_at IS NULL)) OR ((sede_id IS NOT NULL) AND (assigned_by IS NOT NULL) AND (assigned_at IS NOT NULL))));
alter table public.ng_sesiones add constraint ng_sesiones_cupo_check CHECK ((cupo >= 0));
alter table public.organizaciones add constraint organizaciones_nombre_check CHECK ((length(TRIM(BOTH FROM nombre)) > 0));
alter table public.organizaciones add constraint organizaciones_limites_check CHECK (((limite_sedes > 0) AND (limite_canchas_total > 0) AND (limite_admins_centrales > 0)));
alter table public.whatsapp_tenants add constraint whatsapp_tenants_scope_xor_check CHECK ((num_nonnulls(organization_id, sede_id) = 1));
alter table public.whatsapp_tenants add constraint whatsapp_tenants_display_name_check CHECK (((length(TRIM(BOTH FROM display_name)) >= 1) AND (length(TRIM(BOTH FROM display_name)) <= 160)));
alter table public.whatsapp_tenants add constraint whatsapp_tenants_status_check CHECK ((status = ANY (ARRAY['inactive'::text, 'active'::text, 'paused'::text])));
alter table public.whatsapp_tenant_channels add constraint whatsapp_tenant_channels_phone_number_id_check CHECK ((meta_phone_number_id ~ '^[0-9]{6,32}$'::text));
alter table public.whatsapp_tenant_channels add constraint whatsapp_tenant_channels_waba_id_check CHECK (((meta_waba_id IS NULL) OR (meta_waba_id ~ '^[0-9]{6,32}$'::text)));
alter table public.whatsapp_tenant_channels add constraint whatsapp_tenant_channels_credential_ref_check CHECK ((credential_ref ~ '^[A-Z0-9_]{1,40}$'::text));
alter table public.whatsapp_tenant_channels add constraint whatsapp_tenant_channels_auto_reply_check CHECK (((length(TRIM(BOTH FROM auto_reply_text)) >= 1) AND (length(TRIM(BOTH FROM auto_reply_text)) <= 4096)));
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_messages_provider_id_check CHECK (((length(provider_message_id) >= 1) AND (length(provider_message_id) <= 512)));
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_messages_from_wa_id_check CHECK ((from_wa_id ~ '^[0-9]{6,20}$'::text));
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_messages_type_check CHECK ((message_type = 'text'::text));
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_messages_text_check CHECK (((length(text_body) >= 1) AND (length(text_body) <= 4096)));
alter table public.whatsapp_outbox add constraint whatsapp_outbox_to_wa_id_check CHECK ((to_wa_id ~ '^[0-9]{6,20}$'::text));
alter table public.whatsapp_outbox add constraint whatsapp_outbox_text_check CHECK (((length(text_body) >= 1) AND (length(text_body) <= 4096)));
alter table public.whatsapp_outbox add constraint whatsapp_outbox_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'sending'::text, 'sent'::text, 'expired'::text, 'cancelled'::text])));
alter table public.whatsapp_outbox add constraint whatsapp_outbox_attempts_check CHECK ((attempts >= 0));
alter table public.whatsapp_assistant_config add constraint whatsapp_assistant_config_key_check CHECK ((key ~ '^[a-z0-9_]{1,80}$'::text));
alter table public.whatsapp_assistant_config add constraint whatsapp_assistant_config_value_check CHECK (((length(value) >= 1) AND (length(value) <= 2048)));
alter table public.whatsapp_assistant_topics add constraint whatsapp_assistant_topics_slug_check CHECK ((slug ~ '^[a-z0-9_]{1,60}$'::text));
alter table public.whatsapp_assistant_topics add constraint whatsapp_assistant_topics_title_check CHECK ((((length(TRIM(BOTH FROM title_es)) >= 1) AND (length(TRIM(BOTH FROM title_es)) <= 160)) AND ((length(TRIM(BOTH FROM title_en)) >= 1) AND (length(TRIM(BOTH FROM title_en)) <= 160))));
alter table public.whatsapp_assistant_responses add constraint whatsapp_assistant_responses_locale_check CHECK ((locale = ANY (ARRAY['es'::text, 'en'::text])));
alter table public.whatsapp_assistant_responses add constraint whatsapp_assistant_responses_body_check CHECK (((length(TRIM(BOTH FROM body)) >= 1) AND (length(TRIM(BOTH FROM body)) <= 4096)));
alter table public.whatsapp_assistant_operators add constraint whatsapp_assistant_operators_display_name_check CHECK (((length(TRIM(BOTH FROM display_name)) >= 1) AND (length(TRIM(BOTH FROM display_name)) <= 160)));
alter table public.whatsapp_assistant_operators add constraint whatsapp_assistant_operators_external_id_check CHECK (((length(TRIM(BOTH FROM external_id)) >= 1) AND (length(TRIM(BOTH FROM external_id)) <= 160)));
alter table public.whatsapp_assistant_classifications add constraint whatsapp_assistant_classifications_disposition_check CHECK ((disposition = ANY (ARRAY['reply'::text, 'handoff'::text, 'held'::text, 'spam'::text, 'invalid'::text])));
alter table public.push_delivery_jobs add constraint push_delivery_jobs_category_check CHECK ((category = ANY (ARRAY['transactional'::text, 'marketing'::text])));
alter table public.push_delivery_jobs add constraint push_delivery_jobs_status_check CHECK ((status = ANY (ARRAY['processing'::text, 'sent'::text, 'partial'::text, 'no_tokens'::text, 'failed'::text])));
alter table public.push_delivery_attempts add constraint push_delivery_attempts_status_check CHECK ((status = ANY (ARRAY['ticket_ok'::text, 'ticket_error'::text, 'delivered'::text, 'receipt_error'::text, 'invalidated'::text, 'receipt_timeout'::text])));
alter table public.push_token_audit add constraint push_token_audit_action_check CHECK ((action = ANY (ARRAY['registered'::text, 'rotated'::text, 'revoked'::text, 'reassigned'::text, 'invalidated'::text])));
alter table public.sede_programas_beneficios add constraint sede_programas_beneficios_estado_check CHECK ((estado = ANY (ARRAY['borrador'::text, 'activo'::text, 'pausado'::text, 'finalizado'::text])));
alter table public.sede_programas_beneficios add constraint sede_programas_beneficios_meses_check CHECK (((meses_base >= 0) AND (meses_desbloqueados >= 0)));
alter table public.sede_beneficio_progreso add constraint sede_beneficio_progreso_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'cumplido'::text, 'no_cumplido'::text, 'anulado'::text])));
alter table public.sede_beneficio_progreso add constraint sede_beneficio_progreso_meses_check CHECK ((meses_desbloqueados >= 0));
alter table public.torneos add constraint torneos_modalidad_plantel_check CHECK (((modalidad_plantel = ANY (ARRAY['dobles'::text, 'selecciones'::text])) AND ((modalidad_plantel <> 'selecciones'::text) OR ((deporte = 'padbol'::text) AND (COALESCE(formato_equipo, 'dobles'::text) = 'dobles'::text))))) NOT VALID;
alter table public.torneo_partido_alineaciones add constraint torneo_partido_alineaciones_iniciales_check CHECK ((cardinality(iniciales) = 2));
alter table public.torneo_partido_alineaciones add constraint torneo_partido_alineaciones_suplentes_check CHECK ((cardinality(suplentes) = 2));
alter table public.torneo_partido_alineaciones add constraint torneo_partido_alineaciones_revision_check CHECK ((revision > 0));
alter table public.torneo_partido_participacion add constraint torneo_partido_participacion_convocados_a_check CHECK ((cardinality(convocados_a) = 4));
alter table public.torneo_partido_participacion add constraint torneo_partido_participacion_convocados_b_check CHECK ((cardinality(convocados_b) = 4));
alter table public.torneo_partido_participacion add constraint torneo_partido_participacion_procedencia_check CHECK ((procedencia = 'alineacion_convocada'::text));
alter table public.torneo_partido_participacion add constraint torneo_partido_participacion_fuente_check CHECK ((fuente = ANY (ARRAY['manual_admin'::text, 'scoreboard'::text])));
alter table public.torneo_nations_planes add constraint torneo_nations_planes_plan_check CHECK ((jsonb_typeof(plan) = 'object'::text));
alter table public.torneo_nations_programacion add constraint torneo_nations_programacion_duration_minutes_check CHECK (((duration_minutes >= 1) AND (duration_minutes <= 720)));
alter table public.cuentas_elegibilidad_legal add constraint cuentas_elegibilidad_legal_franja_edad_check CHECK ((franja_edad = ANY (ARRAY['under_13'::text, 'requires_verified_parent'::text, 'minor_16_17'::text, 'adult'::text])));
alter table public.cuentas_elegibilidad_legal add constraint cuentas_elegibilidad_legal_estado_check CHECK ((estado = ANY (ARRAY['bloqueada'::text, 'habilitada_restringida'::text, 'habilitada'::text])));
alter table public.torneo_participantes add constraint torneo_participantes_estado_vinculacion_check CHECK ((estado_vinculacion = ANY (ARRAY['sin_cuenta'::text, 'pendiente'::text, 'vinculado'::text])));
alter table public.fipa_ranking_requests add constraint fipa_ranking_requests_source_key_check CHECK ((source_key ~ '^[0-9a-f]{64}$'::text));
alter table public.reservas add constraint reservas_origen_creacion_check CHECK (((origen_creacion IS NULL) OR (origen_creacion = ANY (ARRAY['checkout_jugador_v1'::text, 'encuentro_jugador_v1'::text]))));
alter table public.torneo_fixture_planes add constraint torneo_fixture_planes_origen_check CHECK ((origen = ANY (ARRAY['automatico'::text, 'manual'::text])));
alter table public.torneo_partidos_programacion add constraint torneo_partidos_programacion_duration_minutes_check CHECK (((duration_minutes >= 1) AND (duration_minutes <= 720)));
alter table public.torneo_participantes add constraint torneo_participantes_tipo_identidad_check CHECK ((tipo_identidad = ANY (ARRAY['generico'::text, 'cuenta'::text, 'plaza_pendiente'::text])));
alter table public.torneo_participantes add constraint torneo_participantes_origen_check CHECK ((origen = ANY (ARRAY['club'::text, 'capitan'::text, 'cuenta'::text])));
alter table public.torneo_participantes add constraint torneo_participantes_check CHECK (((tipo_identidad = 'plaza_pendiente'::text) OR ((length(TRIM(BOTH FROM nombre)) >= 1) AND (length(TRIM(BOTH FROM nombre)) <= 100))));
alter table public.torneo_participante_vinculaciones add constraint torneo_participante_vinculaciones_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'aprobado'::text, 'rechazado'::text])));
alter table public.torneo_homologaciones add constraint torneo_homologaciones_referencia_oficial_check CHECK (((length(TRIM(BOTH FROM referencia_oficial)) >= 8) AND (length(TRIM(BOTH FROM referencia_oficial)) <= 1000)));
alter table public.torneo_homologaciones add constraint torneo_homologaciones_evidencia_check CHECK (((length(TRIM(BOTH FROM evidencia)) >= 20) AND (length(TRIM(BOTH FROM evidencia)) <= 4000)));
alter table public.torneo_participante_acreditaciones add constraint torneo_participante_acreditaciones_estado_check CHECK ((estado = ANY (ARRAY['pendiente'::text, 'aprobado'::text, 'rechazado'::text])));
alter table public.torneo_participante_ranking_cierres add constraint torneo_participante_ranking_cierres_participantes_check CHECK ((jsonb_typeof(participantes) = 'array'::text));
alter table public.crm_whatsapp_review_log add constraint crm_whatsapp_review_log_evidence_kind_check CHECK ((evidence_kind = ANY (ARRAY['provider_receipt'::text, 'provider_status'::text, 'no_conclusive_evidence'::text])));
alter table public.crm_whatsapp_review_log add constraint crm_whatsapp_review_log_evidence_sha256_check CHECK (((evidence_sha256 IS NULL) OR (evidence_sha256 ~ '^[0-9a-f]{64}$'::text)));
alter table public.crm_whatsapp_review_log add constraint crm_whatsapp_review_log_check CHECK ((((evidence_kind = 'no_conclusive_evidence'::text) AND (evidence_sha256 IS NULL)) OR ((evidence_kind <> 'no_conclusive_evidence'::text) AND (evidence_sha256 IS NOT NULL))));
alter table public.fipa_ranking_requests add constraint fipa_ranking_requests_state_check CHECK ((state = ANY (ARRAY['pending'::text, 'approved'::text, 'rejected'::text])));
alter table public.crm_replies add constraint crm_replies_long_email_marker_check CHECK ((NOT (long_email_channel IS DISTINCT FROM
CASE
    WHEN (length(btrim(body)) > 4096) THEN 'email'::text
    ELSE NULL::text
END)));
alter table public.crm_whatsapp_menu_reconciliation add constraint crm_whatsapp_menu_reconciliation_outcome_check CHECK ((outcome = ANY (ARRAY['delivered'::text, 'not_delivered'::text])));
alter table public.crm_whatsapp_context_sync add constraint crm_whatsapp_context_sync_revision_check CHECK (((revision >= 1) AND (revision <= '9007199254740991'::bigint)));
alter table public.crm_whatsapp_context_sync add constraint crm_whatsapp_context_sync_content_hash_check CHECK ((content_hash ~ '^[0-9a-f]{64}$'::text));
alter table public.crm_test_visibility_audit add constraint crm_test_visibility_audit_action_check CHECK ((action = ANY (ARRAY['hide'::text, 'restore'::text, 'new_message_restore'::text])));
alter table public.crm_whatsapp_menu_events add constraint crm_whatsapp_menu_event_reply_pair CHECK (((reply_id IS NULL) = (outbox_id IS NULL)));
alter table public.crm_whatsapp_processing_decisions add constraint crm_whatsapp_processing_decisions_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'done'::text])));
alter table public.crm_whatsapp_menu_reconciliation add constraint crm_whatsapp_menu_reconciliation_evidence_sha256_check CHECK ((evidence_sha256 ~ '^[0-9a-f]{64}$'::text));
alter table public.partidos_abiertos add constraint partidos_abiertos_estado_check CHECK ((estado = ANY (ARRAY['abierto'::text, 'completo'::text, 'cancelado'::text, 'finalizado'::text, 'suspendido'::text])));
alter table public.scoreboard_court_occupancy_candidate add constraint scoreboard_court_occupancy_candidate_check CHECK ((starts_at < ends_at));
alter table public.crm_commercial_cases add constraint crm_commercial_cases_status_check CHECK ((status = ANY (ARRAY['open'::text, 'suspended'::text, 'closed'::text])));
alter table public.crm_commercial_case_send_attempts add constraint crm_commercial_case_send_attempts_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'dispatching'::text, 'sent'::text, 'cancelled'::text, 'uncertain'::text])));
alter table public.crm_commercial_advisors add constraint crm_commercial_advisors_email_check CHECK ((email = lower(btrim(email))));
alter table public.crm_commercial_team_activities add constraint crm_commercial_team_activities_case_type_check CHECK ((case_type = ANY (ARRAY['whatsapp'::text, 'form'::text])));
alter table public.crm_commercial_team_activities add constraint crm_commercial_team_activities_body_check CHECK (((length(btrim(body)) >= 1) AND (length(btrim(body)) <= 2000)));
alter table public.crm_commercial_cases add constraint crm_commercial_cases_progress_state_check CHECK ((progress_state = ANY (ARRAY['nuevo'::text, 'en_atencion'::text, 'en_espera'::text, 'cerrado'::text])));
alter table public.crm_commercial_form_cases add constraint crm_commercial_form_cases_progress_state_check CHECK ((progress_state = ANY (ARRAY['nuevo'::text, 'en_atencion'::text, 'en_espera'::text, 'cerrado'::text])));
alter table public.crm_commercial_team_calls add constraint crm_commercial_team_calls_case_type_check CHECK ((case_type = ANY (ARRAY['form'::text, 'whatsapp'::text])));
alter table public.crm_commercial_team_calls add constraint crm_commercial_team_calls_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'completed'::text])));
alter table public.crm_commercial_team_calls add constraint crm_commercial_team_calls_check CHECK (((status = 'pending'::text) OR ((length(btrim(COALESCE(situation, ''::text))) >= 3) AND (length(btrim(COALESCE(discussed, ''::text))) >= 3) AND (length(btrim(COALESCE(distinguishing, ''::text))) >= 3) AND (completed_by IS NOT NULL) AND (completed_at IS NOT NULL))));
alter table public.crm_commercial_cases add constraint crm_commercial_cases_reminder_hours_check CHECK ((((cardinality(reminder_hours) >= 1) AND (cardinality(reminder_hours) <= 5)) AND (array_position(reminder_hours, NULL::integer) IS NULL) AND (1 <= ALL (reminder_hours)) AND (720 >= ALL (reminder_hours))));
alter table public.crm_commercial_form_send_attempts add constraint crm_commercial_form_send_attempts_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'dispatching'::text, 'sent'::text, 'cancelled'::text, 'uncertain'::text])));
alter table public.crm_commercial_followups add constraint crm_commercial_followups_case_type_check CHECK ((case_type = ANY (ARRAY['whatsapp'::text, 'form'::text])));
alter table public.crm_commercial_followups add constraint crm_commercial_followups_language_check CHECK ((language = ANY (ARRAY['es'::text, 'en'::text])));
alter table public.crm_commercial_followups add constraint crm_commercial_followups_consent_evidence_check CHECK (((length(TRIM(BOTH FROM consent_evidence)) >= 3) AND (length(TRIM(BOTH FROM consent_evidence)) <= 2000)));
alter table public.crm_commercial_followups add constraint crm_commercial_followups_template_key_check CHECK (((length(TRIM(BOTH FROM template_key)) >= 3) AND (length(TRIM(BOTH FROM template_key)) <= 120)));
alter table public.crm_commercial_form_cases add constraint crm_commercial_form_cases_reminder_hours_check CHECK ((((cardinality(reminder_hours) >= 1) AND (cardinality(reminder_hours) <= 5)) AND (array_position(reminder_hours, NULL::integer) IS NULL) AND (1 <= ALL (reminder_hours)) AND (720 >= ALL (reminder_hours))));
alter table public.crm_commercial_advisor_requests add constraint crm_commercial_advisor_requests_email_check CHECK (((email = lower(btrim(email))) AND ((length(email) >= 3) AND (length(email) <= 254))));
alter table public.crm_commercial_advisor_requests add constraint crm_commercial_advisor_requests_check CHECK (((length(name) <= 120) AND (length(territory) <= 240) AND (length(review_note) <= 1000)));
alter table public.crm_commercial_cases add constraint crm_commercial_cases_closure_outcome_check CHECK ((closure_outcome = ANY (ARRAY['venta_concretada'::text, 'no_avanzo'::text])));
alter table public.crm_commercial_form_cases add constraint crm_commercial_form_cases_closure_outcome_check CHECK ((closure_outcome = ANY (ARRAY['venta_concretada'::text, 'no_avanzo'::text])));
alter table public.content_meta_audit add constraint content_meta_audit_action_check CHECK ((action = ANY (ARRAY['preview'::text, 'commit'::text])));
alter table public.crm_commercial_followups add constraint crm_commercial_followups_status_check CHECK ((status = ANY (ARRAY['active'::text, 'paused'::text, 'cancelled'::text, 'completed'::text])));
alter table public.crm_commercial_followup_dispatches add constraint crm_commercial_followup_dispatches_step_check CHECK (((step >= 1) AND (step <= 3)));
alter table public.crm_commercial_followup_dispatches add constraint crm_commercial_followup_dispatches_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'dispatching'::text, 'accepted'::text, 'uncertain'::text, 'cancelled'::text])));
alter table public.crm_commercial_advisor_requests add constraint crm_commercial_advisor_requests_agreed_conditions_check CHECK ((length(agreed_conditions) <= 2000));
alter table public.crm_commercial_advisor_requests add constraint crm_commercial_advisor_requests_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'pending_verification'::text, 'approved'::text, 'rejected'::text])));
alter table public.content_meta_imports add constraint content_meta_imports_account_id_check CHECK ((account_id = '1354015098808083'::text));
alter table public.content_meta_imports add constraint content_meta_imports_level_check CHECK ((level = ANY (ARRAY['campaign'::text, 'adset'::text, 'ad'::text])));
alter table public.content_meta_imports add constraint content_meta_imports_sha256_check CHECK ((sha256 ~ '^[a-f0-9]{64}$'::text));
alter table public.content_meta_imports add constraint content_meta_imports_source_check CHECK ((source = ANY (ARRAY['csv'::text, 'meta_api'::text])));
alter table public.content_meta_imports add constraint content_meta_imports_timezone_check CHECK ((timezone = 'America/Los_Angeles'::text));
alter table public.content_meta_imports add constraint content_meta_imports_currency_check CHECK ((currency = 'USD'::text));
alter table public.content_meta_imports add constraint content_meta_imports_exported_precision_check CHECK ((exported_precision = ANY (ARRAY['date'::text, 'timestamp'::text])));
alter table public.content_meta_imports add constraint content_meta_imports_check CHECK ((to_day >= from_day));
alter table public.content_meta_imports add constraint content_meta_imports_row_count_check CHECK (((row_count >= 0) AND (row_count <= 100000)));
alter table public.content_meta_imports add constraint content_meta_imports_status_check CHECK ((status = ANY (ARRAY['preview'::text, 'committed'::text])));
alter table public.solicitudes_licencia add constraint solicitudes_licencia_idempotency_key_check CHECK (((idempotency_key IS NULL) OR (idempotency_key ~ '^[a-f0-9]{64}$'::text)));
alter table public.solicitudes_licencia add constraint solicitudes_licencia_idempotency_payload_hash_check CHECK (((idempotency_payload_hash IS NULL) OR (idempotency_payload_hash ~ '^[a-f0-9]{64}$'::text)));
alter table public.solicitudes_licencia add constraint solicitudes_licencia_idempotency_pair_check CHECK (((idempotency_key IS NULL) = (idempotency_payload_hash IS NULL))) NOT VALID;
alter table public.solicitudes_licencia add constraint solicitudes_licencia_whatsapp_followup_consent_check CHECK ((((NOT whatsapp_followup_consent) AND (whatsapp_followup_consent_source IS NULL) AND (whatsapp_followup_consent_version IS NULL) AND (whatsapp_followup_consent_text IS NULL) AND (whatsapp_followup_consent_at IS NULL)) OR (whatsapp_followup_consent AND (whatsapp_followup_consent_source IS NOT NULL) AND (whatsapp_followup_consent_version IS NOT NULL) AND (whatsapp_followup_consent_text IS NOT NULL) AND ((length(TRIM(BOTH FROM whatsapp_followup_consent_source)) >= 1) AND (length(TRIM(BOTH FROM whatsapp_followup_consent_source)) <= 120)) AND (whatsapp_followup_consent_version = 'whatsapp-followup-v1'::text) AND ((length(whatsapp_followup_consent_text) >= 1) AND (length(whatsapp_followup_consent_text) <= 1000)) AND (whatsapp_followup_consent_at IS NOT NULL))));
alter table public.content_meta_sync_runs add constraint content_meta_sync_runs_account_id_check CHECK ((account_id = '1354015098808083'::text));
alter table public.content_meta_sync_runs add constraint content_meta_sync_runs_check CHECK ((until_day = (since_day + 13)));
alter table public.content_meta_sync_runs add constraint content_meta_sync_runs_status_check CHECK ((status = ANY (ARRAY['running'::text, 'succeeded'::text, 'failed'::text])));
alter table public.content_meta_sync_runs add constraint content_meta_sync_runs_attempts_check CHECK ((attempts > 0));
alter table public.content_meta_monitor_alerts add constraint content_meta_monitor_alerts_kind_check CHECK ((kind = ANY (ARRAY['impressions_drop'::text, 'link_clicks_drop'::text, 'cost_per_link_click_increase'::text, 'coverage_gap'::text])));
alter table public.content_meta_sync_events add constraint content_meta_sync_events_event_type_check CHECK ((event_type = ANY (ARRAY['started'::text, 'succeeded'::text, 'failed'::text])));
alter table public.crm_email_provider_receipts add constraint crm_email_provider_receipts_rfc_message_id_check CHECK (((length(rfc_message_id) >= 3) AND (length(rfc_message_id) <= 500)));
alter table public.crm_email_return_pending add constraint crm_email_return_pending_id_check CHECK ((id ~ '^[a-f0-9]{64}$'::text));
alter table public.crm_email_return_pending add constraint crm_email_return_pending_fallback_origin_check CHECK ((fallback_origin = 'institutional_email'::text));
alter table public.crm_email_return_pending add constraint crm_email_return_pending_status_check CHECK ((status = ANY (ARRAY['pending'::text, 'matched'::text, 'needs_review'::text])));
alter table public.crm_email_return_pending add constraint crm_email_return_pending_raw_event_check CHECK ((jsonb_typeof(raw_event) = 'object'::text));
alter table public.crm_email_return_queue_audit add constraint crm_email_return_queue_audit_event_type_check CHECK ((event_type = ANY (ARRAY['queued'::text, 'payload_conflict'::text, 'matched'::text, 'needs_review'::text, 'fallback_linked'::text])));
alter table public.crm_commercial_email_triage add constraint crm_commercial_email_triage_reason_check CHECK (((length(btrim(reason)) >= 10) AND (length(btrim(reason)) <= 2000)));
alter table public.crm_form_welcome_dispatches add constraint crm_form_welcome_dispatches_recipient_wa_id_check CHECK ((recipient_wa_id ~ '^[1-9][0-9]{7,14}$'::text));
alter table public.crm_form_welcome_dispatches add constraint crm_form_welcome_dispatches_language_check CHECK ((language = ANY (ARRAY['es'::text, 'en'::text])));
alter table public.crm_form_welcome_dispatches add constraint crm_form_welcome_dispatches_status_check CHECK ((status = ANY (ARRAY['reserved'::text, 'dispatching'::text, 'accepted'::text, 'uncertain'::text, 'cancelled'::text])));
alter table public.whatsapp_delivery_receipts add constraint whatsapp_delivery_receipts_provider_message_id_check CHECK ((((length(provider_message_id) >= 7) AND (length(provider_message_id) <= 506)) AND (provider_message_id ~ '^wamid\.[A-Za-z0-9_+/=-]+$'::text)));
alter table public.whatsapp_delivery_receipts add constraint whatsapp_delivery_receipts_recipient_id_check CHECK ((recipient_id ~ '^[1-9][0-9]{5,31}$'::text));
alter table public.whatsapp_delivery_receipts add constraint whatsapp_delivery_receipts_delivery_status_check CHECK ((delivery_status = ANY (ARRAY['sent'::text, 'delivered'::text, 'read'::text, 'failed'::text])));
alter table public.crm_replies add constraint crm_replies_body_check CHECK (((length(TRIM(BOTH FROM body)) >= 1) AND (length(TRIM(BOTH FROM body)) <= 16384)));
alter table public.crm_lead_alerts add constraint crm_lead_alerts_case_type_check CHECK ((case_type = ANY (ARRAY['whatsapp'::text, 'form'::text])));
alter table public.crm_lead_alerts add constraint crm_lead_alerts_cycle_check CHECK ((cycle > 0));
alter table public.crm_lead_alerts add constraint crm_lead_alerts_state_check CHECK ((state = ANY (ARRAY['pendiente'::text, 'recordatorio'::text, 'escalada'::text, 'resuelta'::text])));
alter table public.crm_activities add constraint crm_activities_type_check CHECK ((activity_type = ANY (ARRAY['note'::text, 'phone_call'::text, 'zoom_meeting'::text, 'in_person_meeting'::text, 'email'::text, 'other'::text])));
alter table public.crm_prospect_settings add constraint crm_prospect_settings_daily_limit_check CHECK (((daily_limit >= 1) AND (daily_limit <= 200)));
alter table public.crm_prospect_settings add constraint crm_prospect_settings_singleton CHECK (singleton);
alter table public.crm_prospects add constraint crm_prospects_location_type_check CHECK ((location_type = ANY (ARRAY['independent'::text, 'branch'::text, 'franchise'::text, 'headquarters'::text, 'unknown'::text])));
alter table public.crm_prospects add constraint crm_prospects_locations_count_check CHECK (((locations_count IS NULL) OR ((locations_count >= 1) AND (locations_count <= 10000))));
alter table public.crm_prospects add constraint crm_prospects_score_check CHECK (((score >= 0) AND (score <= 100)));
alter table public.crm_prospects add constraint crm_prospects_grade_check CHECK ((grade = ANY (ARRAY['A'::text, 'B'::text, 'C'::text])));
alter table public.crm_prospects add constraint crm_prospects_status_check CHECK ((status = ANY (ARRAY['investigated'::text, 'verified'::text, 'pending_approval'::text, 'approved'::text, 'contacted'::text, 'delivered'::text, 'responded'::text, 'interested'::text, 'negotiation'::text, 'no_response'::text, 'rejected'::text, 'opt_out'::text, 'bounced'::text, 'paused'::text, 'closed'::text, 'existing'::text])));
alter table public.crm_prospects add constraint crm_prospects_priority_check CHECK ((priority = ANY (ARRAY['low'::text, 'normal'::text, 'high'::text])));
alter table public.crm_prospect_campaign_steps add constraint crm_prospect_campaign_steps_day_check CHECK ((day = ANY (ARRAY[0, 7, 14])));
alter table public.crm_prospect_messages add constraint crm_prospect_messages_step_day_check CHECK ((step_day = ANY (ARRAY[0, 7, 14])));
alter table public.crm_prospect_messages add constraint crm_prospect_messages_status_check CHECK ((status = ANY (ARRAY['simulated'::text, 'queued'::text, 'sent'::text, 'delivered'::text, 'bounced'::text, 'responded'::text, 'suppressed'::text, 'failed'::text, 'cancelled'::text])));
alter table public.crm_prospect_suppressions add constraint crm_prospect_suppression_identity CHECK (((email IS NOT NULL) OR (domain IS NOT NULL) OR (phone IS NOT NULL)));
alter table public.crm_lead_notifications add constraint crm_lead_notifications_case_type_check CHECK ((case_type = ANY (ARRAY['form'::text, 'whatsapp'::text, 'email'::text, 'test'::text])));
alter table public.crm_space_requests add constraint crm_space_requests_status_check CHECK ((status = ANY (ARRAY['recibida'::text, 'en_evaluacion'::text, 'en_preparacion'::text, 'enviada'::text])));
alter table public.crm_space_requests add constraint crm_space_requests_length_m_check CHECK ((length_m > (0)::numeric));
alter table public.crm_space_requests add constraint crm_space_requests_width_m_check CHECK ((width_m > (0)::numeric));
alter table public.crm_space_requests add constraint clear_height_min CHECK (((NOT covered) OR (height_m >= 5.5)));
alter table public.crm_ab_campaigns add constraint crm_ab_campaigns_automatic_percent_check CHECK (((automatic_percent >= 0) AND (automatic_percent <= 100)));
alter table public.crm_ab_assignments add constraint crm_ab_assignments_variant_check CHECK ((variant = ANY (ARRAY['automatic'::text, 'traditional'::text])));
alter table public.academy_payment_grants add constraint academy_payment_grants_session_id_check CHECK ((session_id ~ '^cs_live_[A-Za-z0-9]{1,240}$'::text));
alter table public.academy_payment_grants add constraint academy_payment_grants_email_check CHECK (((email = lower(btrim(email))) AND (length(email) <= 320)));
alter table public.academy_payment_grants add constraint academy_payment_grants_product_code_check CHECK ((product_code = ANY (ARRAY['coach_jugadores'::text, 'coach_formador'::text, 'modulo_infantil'::text, 'masterclass_fide'::text, 'arbitro_nacional'::text, 'arbitro_internacional'::text, 'formador_arbitros'::text])));
alter table public.academy_payment_grants add constraint academy_payment_grants_amount_total_check CHECK ((amount_total > 0));
alter table public.academy_payment_grants add constraint academy_payment_grants_currency_check CHECK ((currency = 'usd'::text));
alter table public.academy_payment_grants add constraint academy_payment_grants_event_id_check CHECK ((event_id ~ '^evt_[A-Za-z0-9]{1,240}$'::text));
alter table public.academy_payment_grants add constraint academy_payment_grants_payment_status_check CHECK ((payment_status = 'paid'::text));
alter table public.academy_payment_grants add constraint academy_payment_grants_livemode_check CHECK ((livemode = true));
alter table public.nations_activation_events add constraint nations_activation_events_slug_check CHECK ((slug ~ '^[a-z0-9][a-z0-9-]{2,79}$'::text));
alter table public.nations_activation_events add constraint nations_activation_events_title_check CHECK (((length(title) >= 3) AND (length(title) <= 160)));
alter table public.nations_activation_delegates add constraint nations_activation_delegates_country_check CHECK ((country ~ '^[A-Z]{2}$'::text));
alter table public.nations_activation_participants add constraint nations_activation_participants_country_check CHECK ((country ~ '^[A-Z]{2}$'::text));
alter table public.nations_activation_participants add constraint nations_activation_participants_row_key_check CHECK (((length(row_key) >= 1) AND (length(row_key) <= 120)));
alter table public.nations_activation_participants add constraint nations_activation_participants_check CHECK (((guardian_reviewed_by IS NULL) = (guardian_reviewed_at IS NULL)));
alter table public.nations_activation_invites add constraint nations_activation_invites_token_hash_check CHECK ((length(token_hash) = 64));
alter table public.nations_activation_invites add constraint nations_activation_invites_check CHECK (((used_at IS NULL) = (used_by IS NULL)));
alter table public.sedes add constraint sedes_tipo_sede_valido CHECK ((tipo_sede = ANY (ARRAY['reservable'::text, 'torneo'::text])));
alter table public.sedes add constraint sedes_reserva_completa_si_reservable CHECK (((tipo_sede = 'torneo'::text) OR ((cantidad_canchas IS NOT NULL) AND (horario_apertura IS NOT NULL) AND (horario_cierre IS NOT NULL) AND (precio_por_reserva IS NOT NULL) AND (whatsapp_contacto IS NOT NULL))));
alter table public.nations_activation_participants add constraint nations_participants_age_status_valido CHECK ((age_status = ANY (ARRAY['adulto'::text, 'menor'::text, 'desconocido'::text])));
alter table public.nations_activation_participants add constraint nations_participants_age_status_consistente CHECK ((((age_status = 'menor'::text) AND (minor = true)) OR ((age_status = ANY (ARRAY['adulto'::text, 'desconocido'::text])) AND (minor = false))));
alter table public.organizacion_sedes add constraint organizacion_sedes_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id) ON DELETE CASCADE;
alter table public.organizacion_sedes add constraint organizacion_sedes_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.invitaciones_admin add constraint invitaciones_admin_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id) ON DELETE SET NULL;
alter table public.courts add constraint courts_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
alter table public.reservations add constraint reservations_court_id_fkey FOREIGN KEY (court_id) REFERENCES courts(id) ON DELETE CASCADE;
alter table public.reservations add constraint reservations_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE;
alter table public.reservations add constraint reservations_location_id_fkey FOREIGN KEY (location_id) REFERENCES locations(id) ON DELETE CASCADE;
alter table public.payments add constraint payments_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE;
alter table public.confirmations add constraint confirmations_reservation_id_fkey FOREIGN KEY (reservation_id) REFERENCES reservations(id) ON DELETE CASCADE;
alter table public.horarios_excepcionales add constraint horarios_excepcionales_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.jugadores add constraint jugadores_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.user_roles add constraint user_roles_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.user_roles add constraint user_roles_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.torneos add constraint torneos_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.torneos add constraint torneos_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table public.jugadores_torneo add constraint jugadores_torneo_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.jugadores_torneo add constraint jugadores_torneo_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.equipos add constraint equipos_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.equipos add constraint equipos_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.partidos add constraint partidos_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.partidos add constraint partidos_equipo_a_id_fkey FOREIGN KEY (equipo_a_id) REFERENCES equipos(id);
alter table public.partidos add constraint partidos_equipo_b_id_fkey FOREIGN KEY (equipo_b_id) REFERENCES equipos(id);
alter table public.partidos add constraint partidos_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.games add constraint games_partido_id_fkey FOREIGN KEY (partido_id) REFERENCES partidos(id) ON DELETE CASCADE;
alter table public.ranking_jugadores add constraint ranking_jugadores_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.ranking_jugadores add constraint ranking_jugadores_jugador_id_fkey FOREIGN KEY (jugador_id) REFERENCES jugadores_torneo(id);
alter table public.ranking_jugadores add constraint ranking_jugadores_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES equipos(id);
alter table public.clasificaciones add constraint clasificaciones_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES equipos(id);
alter table public.clasificaciones add constraint clasificaciones_torneo_origen_id_fkey FOREIGN KEY (torneo_origen_id) REFERENCES torneos(id);
alter table public.clasificaciones add constraint clasificaciones_torneo_destino_id_fkey FOREIGN KEY (torneo_destino_id) REFERENCES torneos(id);
alter table public.tabla_puntos add constraint tabla_puntos_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.tabla_puntos add constraint tabla_puntos_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES equipos(id) ON DELETE CASCADE;
alter table public.canchas add constraint canchas_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.creditos add constraint creditos_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.equipos add constraint equipos_creador_id_fkey FOREIGN KEY (creador_id) REFERENCES auth.users(id);
alter table public.contratos_sedes add constraint contratos_sedes_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.busca_dupla_torneo add constraint busca_dupla_torneo_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.busca_dupla_torneo add constraint busca_dupla_torneo_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.busca_dupla_invitacion add constraint busca_dupla_invitacion_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.busca_dupla_invitacion add constraint busca_dupla_invitacion_from_user_id_fkey FOREIGN KEY (from_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.busca_dupla_invitacion add constraint busca_dupla_invitacion_to_user_id_fkey FOREIGN KEY (to_user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.canchas_por_deporte add constraint canchas_por_deporte_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.partidos_abiertos add constraint partidos_abiertos_reserva_id_fkey FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE SET NULL;
alter table public.invitaciones_admin add constraint invitaciones_admin_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE SET NULL;
alter table public.reservas_historial add constraint reservas_historial_reserva_id_fkey FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE CASCADE;
alter table public.horarios_excepciones add constraint horarios_excepciones_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.scoreboard_control_sessions add constraint scoreboard_control_sessions_scoreboard_id_fkey FOREIGN KEY (scoreboard_id) REFERENCES scoreboard_partidos(id) ON DELETE CASCADE;
alter table public.scoreboard_control_actions add constraint scoreboard_control_actions_session_id_fkey FOREIGN KEY (session_id) REFERENCES scoreboard_control_sessions(id) ON DELETE CASCADE;
alter table public.scoreboard_control_actions add constraint scoreboard_control_actions_scoreboard_id_fkey FOREIGN KEY (scoreboard_id) REFERENCES scoreboard_partidos(id) ON DELETE CASCADE;
alter table public.sedes_pendientes add constraint sedes_pendientes_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id) ON DELETE SET NULL;
alter table public.partidos_abiertos add constraint partidos_abiertos_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE SET NULL;
alter table public.partidos_abiertos_solicitudes add constraint partidos_abiertos_solicitudes_partido_id_fkey FOREIGN KEY (partido_id) REFERENCES partidos_abiertos(id) ON DELETE CASCADE;
alter table public.extras add constraint extras_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.equipos_usuario add constraint equipos_usuario_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id);
alter table public.equipos_jugadores add constraint equipos_jugadores_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES equipos_usuario(id) ON DELETE CASCADE;
alter table public.sponsors add constraint sponsors_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.sponsors add constraint sponsors_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.sponsors add constraint sponsors_creado_por_fkey FOREIGN KEY (creado_por) REFERENCES auth.users(id);
alter table public.hub_promo_sede add constraint hub_promo_sede_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.sedes_duraciones add constraint sedes_duraciones_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.sede_extras add constraint sede_extras_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.profesores add constraint profesores_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.profesores add constraint profesores_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.profesores add constraint profesores_aprobado_por_fkey FOREIGN KEY (aprobado_por) REFERENCES auth.users(id);
alter table public.clases add constraint clases_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.clases add constraint clases_profesor_id_fkey FOREIGN KEY (profesor_id) REFERENCES profesores(id) ON DELETE CASCADE;
alter table public.clases add constraint clases_cancha_id_fkey FOREIGN KEY (cancha_id) REFERENCES canchas(id);
alter table public.clases_reservas add constraint clases_reservas_clase_id_fkey FOREIGN KEY (clase_id) REFERENCES clases(id) ON DELETE CASCADE;
alter table public.clases_horarios add constraint clases_horarios_clase_id_fkey FOREIGN KEY (clase_id) REFERENCES clases(id) ON DELETE CASCADE;
alter table public.inscripciones_clases add constraint inscripciones_clases_clase_id_fkey FOREIGN KEY (clase_id) REFERENCES clases(id) ON DELETE CASCADE;
alter table public.inscripciones_clases add constraint inscripciones_clases_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.inscripciones_clases add constraint inscripciones_clases_reserva_cancha_id_fkey FOREIGN KEY (reserva_cancha_id) REFERENCES reservas(id);
alter table public.crm_prospects add constraint crm_prospects_crm_contact_id_fkey FOREIGN KEY (crm_contact_id) REFERENCES crm_contacts(id) ON DELETE SET NULL;
alter table public.sedes_precios_por_duracion add constraint sedes_precios_por_duracion_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.precios_por_deporte add constraint precios_por_deporte_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.partidos_abiertos_jugadores add constraint partidos_abiertos_jugadores_partido_id_fkey FOREIGN KEY (partido_id) REFERENCES partidos_abiertos(id);
alter table public.notificaciones_admin_log add constraint notificaciones_admin_log_admin_user_id_fkey FOREIGN KEY (admin_user_id) REFERENCES auth.users(id);
alter table public.crm_whatsapp_menu_reconciliation add constraint crm_whatsapp_menu_reconciliation_outbox_id_fkey FOREIGN KEY (outbox_id) REFERENCES whatsapp_outbox(id);
alter table public.crm_whatsapp_menu_reconciliation add constraint crm_whatsapp_menu_reconciliation_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id);
alter table public.solicitudes_partido add constraint solicitudes_partido_partido_id_fkey FOREIGN KEY (partido_id) REFERENCES partidos_abiertos(id) ON DELETE CASCADE;
alter table public.resenas_sedes add constraint resenas_sedes_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.jugador_rankings add constraint jugador_rankings_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.jugador_rankings add constraint jugador_rankings_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.rankings_leaderboard add constraint rankings_leaderboard_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.rankings_leaderboard add constraint rankings_leaderboard_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.cancelaciones_jugador add constraint cancelaciones_jugador_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.cancelaciones_jugador add constraint cancelaciones_jugador_reserva_id_fkey FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE SET NULL;
alter table public.cancelaciones_jugador add constraint cancelaciones_jugador_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE SET NULL;
alter table public.suspensiones_jugador add constraint suspensiones_jugador_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.suspensiones_jugador add constraint suspensiones_jugador_levantada_por_fkey FOREIGN KEY (levantada_por) REFERENCES auth.users(id);
alter table public.torneo_interes add constraint torneo_interes_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.push_tokens add constraint push_tokens_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.lista_espera_general add constraint lista_espera_general_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.lista_espera_general add constraint lista_espera_general_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.logros_jugador add constraint logros_jugador_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.xp_transacciones add constraint xp_transacciones_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.logros_jugador add constraint logros_jugador_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.logros_premios add constraint logros_premios_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.rangos_historial add constraint rangos_historial_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.ligas_premios add constraint ligas_premios_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.scoreboard_partidos add constraint scoreboard_partidos_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.scoreboard_partidos add constraint scoreboard_partidos_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id);
alter table public.scoreboard_sponsors add constraint scoreboard_sponsors_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.surge_config add constraint surge_config_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.surge_historial add constraint surge_historial_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.store_central_offers add constraint store_central_offers_product_id_fkey FOREIGN KEY (product_id) REFERENCES store_catalog_products(id) ON DELETE RESTRICT;
alter table public.scoreboard_jugadores_temp add constraint scoreboard_jugadores_temp_partido_id_fkey FOREIGN KEY (partido_id) REFERENCES scoreboard_partidos(id) ON DELETE CASCADE;
alter table public.scoreboard_jugadores_temp add constraint scoreboard_jugadores_temp_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.scoreboard_historial_puntos add constraint scoreboard_historial_puntos_partido_id_fkey FOREIGN KEY (partido_id) REFERENCES scoreboard_partidos(id) ON DELETE CASCADE;
alter table public.franjas_precio add constraint franjas_precio_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.scoreboard_partidos add constraint scoreboard_partidos_partido_abierto_id_fkey FOREIGN KEY (partido_abierto_id) REFERENCES partidos_abiertos(id);
alter table public.scoreboard_partidos add constraint scoreboard_partidos_reserva_id_fkey FOREIGN KEY (reserva_id) REFERENCES reservas(id);
alter table public.padcoins_sede_config add constraint padcoins_sede_config_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.scoreboard_partidos add constraint scoreboard_partidos_partido_torneo_id_fkey FOREIGN KEY (partido_torneo_id) REFERENCES partidos(id) ON DELETE SET NULL;
alter table public.partidos add constraint partidos_ganador_equipo_id_fkey FOREIGN KEY (ganador_equipo_id) REFERENCES equipos(id);
alter table public.partidos add constraint partidos_partido_siguiente_id_fkey FOREIGN KEY (partido_siguiente_id) REFERENCES partidos(id) ON DELETE SET NULL;
alter table public.comunidad_comentarios add constraint comunidad_comentarios_publicacion_id_fkey FOREIGN KEY (publicacion_id) REFERENCES comunidad_publicaciones(id) ON DELETE CASCADE;
alter table public.padcoins_movimientos add constraint padcoins_movimientos_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE SET NULL;
alter table public.premios_canjeables add constraint premios_canjeables_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.padcoins_canjes add constraint padcoins_canjes_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.padcoins_canjes add constraint padcoins_canjes_premio_id_fkey FOREIGN KEY (premio_id) REFERENCES premios_canjeables(id) ON DELETE RESTRICT;
alter table public.padcoins_campaigns add constraint padcoins_campaigns_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.padcoins_campaigns add constraint padcoins_campaigns_benefit_id_fkey FOREIGN KEY (benefit_id) REFERENCES premios_canjeables(id) ON DELETE SET NULL;
alter table public.padcoins_campaign_audit_logs add constraint padcoins_campaign_audit_logs_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES padcoins_campaigns(id) ON DELETE CASCADE;
alter table public.padcoins_campaign_audit_logs add constraint padcoins_campaign_audit_logs_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.padcoins_campaign_applications add constraint padcoins_campaign_applications_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES padcoins_campaigns(id) ON DELETE CASCADE;
alter table public.padcoins_campaign_applications add constraint padcoins_campaign_applications_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.padcoins_campaign_applications add constraint padcoins_campaign_applications_movimiento_id_fkey FOREIGN KEY (movimiento_id) REFERENCES padcoins_movimientos(id) ON DELETE SET NULL;
alter table public.padbol_match_setup_status add constraint padbol_match_setup_status_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.jugadores_identidad add constraint jugadores_identidad_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.jugadores_identidad add constraint jugadores_identidad_identidad_verificada_por_fkey FOREIGN KEY (identidad_verificada_por) REFERENCES auth.users(id);
alter table public.jugadores_aceptaciones add constraint jugadores_aceptaciones_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.jugadores_aceptaciones add constraint jugadores_aceptaciones_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE SET NULL;
alter table public.match_participants add constraint match_participants_reserva_id_fkey FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE SET NULL;
alter table public.match_participants add constraint match_participants_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.match_reward_events add constraint match_reward_events_reserva_id_fkey FOREIGN KEY (reserva_id) REFERENCES reservas(id) ON DELETE SET NULL;
alter table public.match_reward_events add constraint match_reward_events_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.comunidad_medios add constraint comunidad_medios_publicacion_id_fkey FOREIGN KEY (publicacion_id) REFERENCES comunidad_publicaciones(id) ON DELETE CASCADE;
alter table public.torneo_partido_alineaciones add constraint torneo_partido_alineaciones_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES equipos(id);
alter table public.comunidad_reacciones add constraint comunidad_reacciones_publicacion_id_fkey FOREIGN KEY (publicacion_id) REFERENCES comunidad_publicaciones(id) ON DELETE CASCADE;
alter table public.membresias_sede add constraint membresias_sede_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES membresia_planes(id);
alter table public.torneo_partido_alineaciones add constraint torneo_partido_alineaciones_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id);
alter table public.membresia_usos_reserva add constraint membresia_usos_reserva_membresia_id_fkey FOREIGN KEY (membresia_id) REFERENCES membresias_sede(id) ON DELETE CASCADE;
alter table public.crm_whatsapp_automation_releases add constraint crm_whatsapp_automation_releases_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE CASCADE;
alter table public.content_meta_audit add constraint content_meta_audit_import_id_fkey FOREIGN KEY (import_id) REFERENCES content_meta_imports(id);
alter table public.crm_form_welcome_dispatches add constraint crm_form_welcome_dispatches_event_id_fkey FOREIGN KEY (event_id) REFERENCES crm_inbound_events(id);
alter table public.crm_prospects add constraint crm_prospects_crm_conversation_id_fkey FOREIGN KEY (crm_conversation_id) REFERENCES crm_conversations(id) ON DELETE SET NULL;
alter table public.jugador_nivel_externo add constraint jugador_nivel_externo_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.fipa_ranking_operators add constraint fipa_ranking_operators_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
alter table public.fipa_ranking_operators add constraint fipa_ranking_operators_granted_by_fkey FOREIGN KEY (granted_by) REFERENCES auth.users(id);
alter table public.store_sede_offers add constraint store_sede_offers_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.store_sede_offers add constraint store_sede_offers_product_id_fkey FOREIGN KEY (product_id) REFERENCES store_catalog_products(id) ON DELETE RESTRICT;
alter table public.fipa_ranking_links add constraint fipa_ranking_links_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
alter table public.support_tickets add constraint support_tickets_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE SET NULL;
alter table public.support_ticket_messages add constraint support_ticket_messages_ticket_id_fkey FOREIGN KEY (ticket_id) REFERENCES support_tickets(id) ON DELETE CASCADE;
alter table public.manual_player_booking_receipts add constraint manual_player_booking_receipts_reserva_id_fkey FOREIGN KEY (reserva_id) REFERENCES reservas(id);
alter table public.news_articles add constraint news_articles_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE SET NULL;
alter table public.news_articles add constraint news_articles_author_id_fkey FOREIGN KEY (author_id) REFERENCES auth.users(id) ON DELETE RESTRICT;
alter table public.news_articles add constraint news_articles_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.news_article_events add constraint news_article_events_article_id_fkey FOREIGN KEY (article_id) REFERENCES news_articles(id) ON DELETE CASCADE;
alter table public.news_article_events add constraint news_article_events_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.academy_certificates add constraint academy_certificates_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.recorridos_externos add constraint recorridos_externos_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.recorridos_externos add constraint recorridos_externos_revisado_por_fkey FOREIGN KEY (revisado_por) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.fipa_documents add constraint fipa_documents_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.fipa_registrations add constraint fipa_registrations_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.fipa_registration_players add constraint fipa_registration_players_registration_id_fkey FOREIGN KEY (registration_id) REFERENCES fipa_registrations(id) ON DELETE CASCADE;
alter table public.fipa_player_files add constraint fipa_player_files_player_id_fkey FOREIGN KEY (player_id) REFERENCES fipa_registration_players(id) ON DELETE CASCADE;
alter table public.fipa_legal_representatives add constraint fipa_legal_representatives_player_id_fkey FOREIGN KEY (player_id) REFERENCES fipa_registration_players(id) ON DELETE CASCADE;
alter table public.fipa_ranking_claim_invites add constraint fipa_ranking_claim_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table public.fipa_acceptances add constraint fipa_acceptances_player_id_fkey FOREIGN KEY (player_id) REFERENCES fipa_registration_players(id) ON DELETE CASCADE;
alter table public.fipa_acceptances add constraint fipa_acceptances_representative_id_fkey FOREIGN KEY (representative_id) REFERENCES fipa_legal_representatives(id) ON DELETE CASCADE;
alter table public.fipa_acceptances add constraint fipa_acceptances_document_id_fkey FOREIGN KEY (document_id) REFERENCES fipa_documents(id) ON DELETE RESTRICT;
alter table public.fipa_invitations add constraint fipa_invitations_player_id_fkey FOREIGN KEY (player_id) REFERENCES fipa_registration_players(id) ON DELETE CASCADE;
alter table public.fipa_invitations add constraint fipa_invitations_representative_id_fkey FOREIGN KEY (representative_id) REFERENCES fipa_legal_representatives(id) ON DELETE CASCADE;
alter table public.fipa_offline_authorizations add constraint fipa_offline_authorizations_player_id_fkey FOREIGN KEY (player_id) REFERENCES fipa_registration_players(id) ON DELETE CASCADE;
alter table public.fipa_organizer_access add constraint fipa_organizer_access_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.fipa_audit_log add constraint fipa_audit_log_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.fipa_audit_log add constraint fipa_audit_log_registration_id_fkey FOREIGN KEY (registration_id) REFERENCES fipa_registrations(id) ON DELETE CASCADE;
alter table public.fipa_audit_log add constraint fipa_audit_log_player_id_fkey FOREIGN KEY (player_id) REFERENCES fipa_registration_players(id) ON DELETE CASCADE;
alter table public.academy_profiles add constraint academy_profiles_id_fkey FOREIGN KEY (id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.academy_enrollments add constraint academy_enrollments_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.academy_progress add constraint academy_progress_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.academy_quiz_attempts add constraint academy_quiz_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.push_notification_preferences add constraint push_notification_preferences_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.fipa_ranking_claim_invites add constraint fipa_ranking_claim_invites_used_by_fkey FOREIGN KEY (used_by) REFERENCES auth.users(id);
alter table public.fipa_ranking_claim_audit add constraint fipa_ranking_claim_audit_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id);
alter table public.fipa_ranking_claim_audit add constraint fipa_ranking_claim_audit_invitation_id_fkey FOREIGN KEY (invitation_id) REFERENCES fipa_ranking_claim_invites(id);
alter table public.crm_conversations add constraint crm_conversations_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE CASCADE;
alter table public.crm_channel_attempts add constraint crm_channel_attempts_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE CASCADE;
alter table public.crm_replies add constraint crm_replies_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE CASCADE;
alter table public.ng_inscripcion_eventos add constraint ng_inscripcion_eventos_inscripcion_id_fkey FOREIGN KEY (inscripcion_id) REFERENCES ng_inscripciones(id) ON DELETE CASCADE;
alter table public.ng_inscripcion_eventos add constraint ng_inscripcion_eventos_sesion_id_fkey FOREIGN KEY (sesion_id) REFERENCES ng_sesiones(id) ON DELETE SET NULL;
alter table public.ng_solicitudes_sede add constraint ng_solicitudes_sede_crm_conversation_id_fkey FOREIGN KEY (crm_conversation_id) REFERENCES crm_conversations(id) ON DELETE SET NULL;
alter table public.whatsapp_assistant_classifications add constraint whatsapp_assistant_classifications_inbound_message_id_fkey FOREIGN KEY (inbound_message_id) REFERENCES whatsapp_inbound_messages(id) ON DELETE CASCADE;
alter table public.crm_activities add constraint crm_activities_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES crm_contacts(id) ON DELETE CASCADE;
alter table public.crm_activities add constraint crm_activities_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE CASCADE;
alter table public.whatsapp_assistant_classifications add constraint whatsapp_assistant_classifications_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES whatsapp_tenants(id) ON DELETE CASCADE;
alter table public.crm_inbound_events add constraint crm_inbound_events_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE CASCADE;
alter table public.crm_conversations add constraint crm_conversations_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE SET NULL;
alter table public.ng_solicitudes_sede add constraint ng_solicitudes_sede_canonical_sede_id_fkey FOREIGN KEY (canonical_sede_id) REFERENCES sedes(id) ON DELETE SET NULL;
alter table public.ng_sesiones add constraint ng_sesiones_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.ng_inscripciones add constraint ng_inscripciones_sesion_id_fkey FOREIGN KEY (sesion_id) REFERENCES ng_sesiones(id) ON DELETE RESTRICT;
alter table public.ng_inscripciones add constraint ng_inscripciones_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE RESTRICT;
alter table public.ng_inscripciones add constraint ng_inscripciones_crm_conversation_id_fkey FOREIGN KEY (crm_conversation_id) REFERENCES crm_conversations(id) ON DELETE SET NULL;
alter table public.nations_activation_imports add constraint nations_activation_imports_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES nations_activation_events(torneo_id);
alter table public.ng_inscripcion_participantes add constraint ng_inscripcion_participantes_inscripcion_id_fkey FOREIGN KEY (inscripcion_id) REFERENCES ng_inscripciones(id) ON DELETE CASCADE;
alter table public.user_roles add constraint user_roles_organizacion_id_fkey FOREIGN KEY (organizacion_id) REFERENCES organizaciones(id) ON DELETE SET NULL;
alter table public.whatsapp_tenants add constraint whatsapp_tenants_organization_id_fkey FOREIGN KEY (organization_id) REFERENCES organizaciones(id) ON DELETE CASCADE;
alter table public.whatsapp_tenants add constraint whatsapp_tenants_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.whatsapp_tenant_channels add constraint whatsapp_tenant_channels_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES whatsapp_tenants(id) ON DELETE CASCADE;
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_messages_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES whatsapp_tenants(id) ON DELETE CASCADE;
alter table public.whatsapp_inbound_messages add constraint whatsapp_inbound_messages_channel_fk FOREIGN KEY (tenant_id, channel_id) REFERENCES whatsapp_tenant_channels(tenant_id, id) ON DELETE CASCADE;
alter table public.torneo_partido_alineaciones add constraint torneo_partido_alineaciones_partido_id_fkey FOREIGN KEY (partido_id) REFERENCES partidos(id);
alter table public.whatsapp_outbox add constraint whatsapp_outbox_tenant_id_fkey FOREIGN KEY (tenant_id) REFERENCES whatsapp_tenants(id) ON DELETE CASCADE;
alter table public.whatsapp_outbox add constraint whatsapp_outbox_channel_fk FOREIGN KEY (tenant_id, channel_id) REFERENCES whatsapp_tenant_channels(tenant_id, id) ON DELETE CASCADE;
alter table public.whatsapp_outbox add constraint whatsapp_outbox_inbound_fk FOREIGN KEY (tenant_id, channel_id, inbound_message_id) REFERENCES whatsapp_inbound_messages(tenant_id, channel_id, id) ON DELETE CASCADE;
alter table public.whatsapp_assistant_responses add constraint whatsapp_assistant_responses_topic_slug_fkey FOREIGN KEY (topic_slug) REFERENCES whatsapp_assistant_topics(slug) ON DELETE CASCADE;
alter table public.push_delivery_jobs add constraint push_delivery_jobs_actor_user_id_fkey FOREIGN KEY (actor_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.push_delivery_attempts add constraint push_delivery_attempts_job_id_fkey FOREIGN KEY (job_id) REFERENCES push_delivery_jobs(id) ON DELETE CASCADE;
alter table public.push_delivery_attempts add constraint push_delivery_attempts_push_token_id_fkey FOREIGN KEY (push_token_id) REFERENCES push_tokens(id) ON DELETE SET NULL;
alter table public.push_delivery_attempts add constraint push_delivery_attempts_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.notificaciones_admin_log add constraint notificaciones_admin_log_push_job_fkey FOREIGN KEY (push_job_id) REFERENCES push_delivery_jobs(id) ON DELETE SET NULL NOT VALID;
alter table public.push_token_audit add constraint push_token_audit_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.push_preference_audit add constraint push_preference_audit_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.sede_programas_beneficios add constraint sede_programas_beneficios_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id) ON DELETE CASCADE;
alter table public.sede_beneficio_progreso add constraint sede_beneficio_progreso_programa_id_fkey FOREIGN KEY (programa_id) REFERENCES sede_programas_beneficios(id) ON DELETE CASCADE;
alter table public.torneo_partido_participacion add constraint torneo_partido_participacion_partido_id_fkey FOREIGN KEY (partido_id) REFERENCES partidos(id);
alter table public.torneo_partido_participacion add constraint torneo_partido_participacion_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id);
alter table public.torneo_partido_participacion add constraint torneo_partido_participacion_equipo_a_id_fkey FOREIGN KEY (equipo_a_id) REFERENCES equipos(id);
alter table public.torneo_partido_participacion add constraint torneo_partido_participacion_equipo_b_id_fkey FOREIGN KEY (equipo_b_id) REFERENCES equipos(id);
alter table public.torneo_nations_planes add constraint torneo_nations_planes_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id);
alter table public.torneo_nations_programacion add constraint torneo_nations_programacion_partido_id_fkey FOREIGN KEY (partido_id) REFERENCES partidos(id);
alter table public.torneo_nations_programacion add constraint torneo_nations_programacion_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id);
alter table public.torneo_nations_programacion add constraint torneo_nations_programacion_court_id_fkey FOREIGN KEY (court_id) REFERENCES canchas(id);
alter table public.scoreboard_partial_correction_audit add constraint scoreboard_partial_correction_audit_scoreboard_id_fkey FOREIGN KEY (scoreboard_id) REFERENCES scoreboard_partidos(id);
alter table public.cuentas_elegibilidad_legal add constraint cuentas_elegibilidad_legal_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.torneo_qa_inscripcion_requests add constraint torneo_qa_inscripcion_requests_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.torneo_qa_inscripcion_requests add constraint torneo_qa_inscripcion_requests_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id) ON DELETE CASCADE;
alter table public.torneo_qa_inscripcion_requests add constraint torneo_qa_inscripcion_requests_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES equipos(id) ON DELETE CASCADE;
alter table public.torneo_fixture_planes add constraint torneo_fixture_planes_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id);
alter table public.torneo_partidos_programacion add constraint torneo_partidos_programacion_partido_id_fkey FOREIGN KEY (partido_id) REFERENCES partidos(id);
alter table public.torneo_partidos_programacion add constraint torneo_partidos_programacion_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id);
alter table public.torneo_partidos_programacion add constraint torneo_partidos_programacion_court_id_fkey FOREIGN KEY (court_id) REFERENCES canchas(id);
alter table public.crm_commercial_followups add constraint crm_commercial_followups_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE RESTRICT;
alter table public.torneo_participantes add constraint torneo_participantes_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.torneo_participantes add constraint torneo_participantes_sede_id_fkey FOREIGN KEY (sede_id) REFERENCES sedes(id);
alter table public.torneo_participantes add constraint torneo_participantes_creado_por_fkey FOREIGN KEY (creado_por) REFERENCES auth.users(id);
alter table public.torneo_participantes add constraint torneo_participantes_linked_user_id_fkey FOREIGN KEY (linked_user_id) REFERENCES auth.users(id);
alter table public.torneo_participante_equipos add constraint torneo_participante_equipos_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES equipos(id) ON DELETE CASCADE;
alter table public.torneo_participante_equipos add constraint torneo_participante_equipos_cuenta_user_id_fkey FOREIGN KEY (cuenta_user_id) REFERENCES auth.users(id);
alter table public.torneo_participante_equipos add constraint torneo_participante_equipos_torneo_id_participante_id_fkey FOREIGN KEY (torneo_id, participante_id) REFERENCES torneo_participantes(torneo_id, id) ON DELETE CASCADE;
alter table public.torneo_participante_vinculaciones add constraint torneo_participante_vinculaciones_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.torneo_participante_vinculaciones add constraint torneo_participante_vinculaciones_resuelto_por_fkey FOREIGN KEY (resuelto_por) REFERENCES auth.users(id);
alter table public.torneo_participante_vinculaciones add constraint torneo_participante_vinculacione_torneo_id_participante_id_fkey FOREIGN KEY (torneo_id, participante_id) REFERENCES torneo_participantes(torneo_id, id) ON DELETE CASCADE;
alter table public.torneo_participante_operaciones add constraint torneo_participante_operaciones_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.torneo_participante_operaciones add constraint torneo_participante_operaciones_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id);
alter table public.content_meta_monitor_alerts add constraint content_meta_monitor_alerts_account_id_until_day_fkey FOREIGN KEY (account_id, until_day) REFERENCES content_meta_sync_runs(account_id, until_day);
alter table public.torneo_homologaciones add constraint torneo_homologaciones_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE CASCADE;
alter table public.torneo_homologaciones add constraint torneo_homologaciones_confirmado_por_fkey FOREIGN KEY (confirmado_por) REFERENCES auth.users(id);
alter table public.torneo_participante_acreditaciones add constraint torneo_participante_acreditaciones_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.torneo_participante_acreditaciones add constraint torneo_participante_acreditaciones_resuelto_por_fkey FOREIGN KEY (resuelto_por) REFERENCES auth.users(id);
alter table public.torneo_participante_acreditaciones add constraint torneo_participante_acreditacion_torneo_id_participante_id_fkey FOREIGN KEY (torneo_id, participante_id) REFERENCES torneo_participantes(torneo_id, id) ON DELETE CASCADE;
alter table public.torneo_participante_ranking_cierres add constraint torneo_participante_ranking_cierres_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id);
alter table public.torneo_participante_ranking_cierres add constraint torneo_participante_ranking_cierres_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES equipos(id);
alter table public.crm_whatsapp_manual_attempts add constraint crm_whatsapp_manual_attempts_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES crm_replies(id) ON DELETE RESTRICT;
alter table public.crm_whatsapp_manual_attempts add constraint crm_whatsapp_manual_attempts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE RESTRICT;
alter table public.crm_whatsapp_review_log add constraint crm_whatsapp_review_log_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES crm_whatsapp_manual_attempts(reply_id) ON DELETE RESTRICT;
alter table public.fipa_ranking_requests add constraint fipa_ranking_requests_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.fipa_ranking_requests add constraint fipa_ranking_requests_reviewed_by_fkey FOREIGN KEY (reviewed_by) REFERENCES auth.users(id);
alter table public.fipa_ranking_claim_audit add constraint fipa_ranking_claim_audit_request_id_fkey FOREIGN KEY (request_id) REFERENCES fipa_ranking_requests(id);
alter table public.crm_replies add constraint crm_replies_long_email_channel_fk FOREIGN KEY (conversation_id, long_email_channel) REFERENCES crm_conversations(id, source_channel);
alter table public.crm_whatsapp_context_sync add constraint crm_whatsapp_context_sync_inbound_event_id_fkey FOREIGN KEY (inbound_event_id) REFERENCES crm_inbound_events(id) ON DELETE CASCADE;
alter table public.crm_whatsapp_context_sync add constraint crm_whatsapp_context_sync_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE CASCADE;
alter table public.crm_test_visibility_audit add constraint crm_test_visibility_audit_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE SET NULL;
alter table public.crm_whatsapp_menu_events add constraint crm_whatsapp_menu_events_inbound_message_id_fkey FOREIGN KEY (inbound_message_id) REFERENCES whatsapp_inbound_messages(id);
alter table public.crm_whatsapp_menu_events add constraint crm_whatsapp_menu_events_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id);
alter table public.crm_whatsapp_menu_events add constraint crm_whatsapp_menu_events_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES crm_replies(id);
alter table public.crm_whatsapp_menu_events add constraint crm_whatsapp_menu_events_outbox_id_fkey FOREIGN KEY (outbox_id) REFERENCES whatsapp_outbox(id);
alter table public.crm_whatsapp_processing_decisions add constraint crm_whatsapp_processing_decisions_inbound_message_id_fkey FOREIGN KEY (inbound_message_id) REFERENCES whatsapp_inbound_messages(id);
alter table public.scoreboard_linked_suspend_candidate add constraint scoreboard_linked_suspend_candidate_scoreboard_id_fkey FOREIGN KEY (scoreboard_id) REFERENCES scoreboard_partidos(id) ON DELETE RESTRICT;
alter table public.scoreboard_linked_suspend_candidate add constraint scoreboard_linked_suspend_candidate_booking_id_fkey FOREIGN KEY (booking_id) REFERENCES reservas(id) ON DELETE RESTRICT;
alter table public.scoreboard_linked_suspend_candidate add constraint scoreboard_linked_suspend_candidate_open_id_fkey FOREIGN KEY (open_id) REFERENCES partidos_abiertos(id) ON DELETE RESTRICT;
alter table public.crm_commercial_cases add constraint crm_commercial_cases_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE RESTRICT;
alter table public.crm_commercial_case_inbound add constraint crm_commercial_case_inbound_inbound_event_id_fkey FOREIGN KEY (inbound_event_id) REFERENCES crm_inbound_events(id) ON DELETE RESTRICT;
alter table public.crm_commercial_case_inbound add constraint crm_commercial_case_inbound_case_id_conversation_id_fkey FOREIGN KEY (case_id, conversation_id) REFERENCES crm_commercial_cases(id, conversation_id) ON DELETE RESTRICT;
alter table public.crm_commercial_case_replies add constraint crm_commercial_case_replies_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES crm_replies(id) ON DELETE RESTRICT;
alter table public.crm_commercial_case_replies add constraint crm_commercial_case_replies_case_id_conversation_id_fkey FOREIGN KEY (case_id, conversation_id) REFERENCES crm_commercial_cases(id, conversation_id) ON DELETE RESTRICT;
alter table public.crm_commercial_case_send_attempts add constraint crm_commercial_case_send_attempts_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES crm_replies(id) ON DELETE RESTRICT;
alter table public.crm_commercial_case_send_attempts add constraint crm_commercial_case_send_attempts_case_id_fkey FOREIGN KEY (case_id) REFERENCES crm_commercial_cases(id) ON DELETE RESTRICT;
alter table public.crm_commercial_advisors add constraint crm_commercial_advisors_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.crm_commercial_form_cases add constraint crm_commercial_form_cases_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE RESTRICT;
alter table public.crm_commercial_team_calls add constraint crm_commercial_team_calls_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE RESTRICT;
alter table public.crm_commercial_form_send_attempts add constraint crm_commercial_form_send_attempts_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES crm_replies(id) ON DELETE RESTRICT;
alter table public.crm_commercial_form_send_attempts add constraint crm_commercial_form_send_attempts_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_commercial_form_cases(conversation_id) ON DELETE RESTRICT;
alter table public.nations_activation_imports add constraint nations_activation_imports_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id);
alter table public.crm_commercial_advisor_requests add constraint crm_commercial_advisor_requests_advisor_id_fkey FOREIGN KEY (advisor_id) REFERENCES auth.users(id);
alter table public.content_workspace_history add constraint content_workspace_history_item_id_fkey FOREIGN KEY (item_id) REFERENCES content_workspace_items(id);
alter table public.content_workspace_files add constraint content_workspace_files_item_id_fkey FOREIGN KEY (item_id) REFERENCES content_workspace_items(id);
alter table public.content_meta_daily_sources add constraint content_meta_daily_sources_import_id_fkey FOREIGN KEY (import_id) REFERENCES content_meta_imports(id);
alter table public.crm_commercial_followup_dispatches add constraint crm_commercial_followup_dispatches_plan_id_fkey FOREIGN KEY (plan_id) REFERENCES crm_commercial_followups(id);
alter table public.crm_commercial_followup_dispatches add constraint crm_commercial_followup_dispatches_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id);
alter table public.content_workspace_coordinators add constraint content_workspace_coordinators_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.content_meta_rows add constraint content_meta_rows_import_id_fkey FOREIGN KEY (import_id) REFERENCES content_meta_imports(id);
alter table public.content_meta_sync_events add constraint content_meta_sync_events_account_id_until_day_fkey FOREIGN KEY (account_id, until_day) REFERENCES content_meta_sync_runs(account_id, until_day);
alter table public.crm_email_provider_receipts add constraint crm_email_provider_receipts_reply_id_fkey FOREIGN KEY (reply_id) REFERENCES crm_replies(id) ON DELETE CASCADE;
alter table public.crm_conversations add constraint crm_conversations_email_return_linked_to_fkey FOREIGN KEY (email_return_linked_to) REFERENCES crm_conversations(id);
alter table public.crm_email_return_pending add constraint crm_email_return_pending_linked_conversation_id_fkey FOREIGN KEY (linked_conversation_id) REFERENCES crm_conversations(id);
alter table public.crm_email_return_pending add constraint crm_email_return_pending_fallback_conversation_id_fkey FOREIGN KEY (fallback_conversation_id) REFERENCES crm_conversations(id);
alter table public.crm_form_welcome_dispatches add constraint crm_form_welcome_dispatches_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id);
alter table public.crm_email_return_queue_audit add constraint crm_email_return_queue_audit_queue_id_fkey FOREIGN KEY (queue_id) REFERENCES crm_email_return_pending(id);
alter table public.crm_commercial_email_triage add constraint crm_commercial_email_triage_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id) ON DELETE RESTRICT;
alter table public.crm_commercial_email_triage add constraint crm_commercial_email_triage_classified_by_fkey FOREIGN KEY (classified_by) REFERENCES auth.users(id);
alter table public.crm_commercial_email_triage add constraint crm_commercial_email_triage_initial_assigned_user_id_fkey FOREIGN KEY (initial_assigned_user_id) REFERENCES auth.users(id);
alter table public.crm_commercial_email_triage_audit add constraint crm_commercial_email_triage_audit_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_commercial_email_triage(conversation_id) ON DELETE RESTRICT;
alter table public.crm_commercial_email_triage_audit add constraint crm_commercial_email_triage_audit_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id);
alter table public.whatsapp_delivery_receipts add constraint whatsapp_delivery_receipts_tenant_id_channel_id_fkey FOREIGN KEY (tenant_id, channel_id) REFERENCES whatsapp_tenant_channels(tenant_id, id);
alter table public.crm_prospect_campaign_steps add constraint crm_prospect_campaign_steps_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES crm_prospect_campaigns(id) ON DELETE CASCADE;
alter table public.crm_prospect_messages add constraint crm_prospect_messages_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES crm_prospect_campaigns(id) ON DELETE CASCADE;
alter table public.crm_prospect_messages add constraint crm_prospect_messages_prospect_id_fkey FOREIGN KEY (prospect_id) REFERENCES crm_prospects(id) ON DELETE CASCADE;
alter table public.crm_prospect_events add constraint crm_prospect_events_prospect_id_fkey FOREIGN KEY (prospect_id) REFERENCES crm_prospects(id) ON DELETE CASCADE;
alter table public.crm_prospect_events add constraint crm_prospect_events_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES crm_prospect_campaigns(id) ON DELETE CASCADE;
alter table public.crm_prospect_events add constraint crm_prospect_events_message_id_fkey FOREIGN KEY (message_id) REFERENCES crm_prospect_messages(id) ON DELETE SET NULL;
alter table public.crm_space_requests add constraint crm_space_requests_conversation_id_fkey FOREIGN KEY (conversation_id) REFERENCES crm_conversations(id);
alter table public.crm_space_requests add constraint crm_space_requests_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES crm_contacts(id);
alter table public.crm_ab_assignments add constraint crm_ab_assignments_campaign_id_fkey FOREIGN KEY (campaign_id) REFERENCES crm_ab_campaigns(id);
alter table public.crm_ab_assignments add constraint crm_ab_assignments_contact_id_fkey FOREIGN KEY (contact_id) REFERENCES crm_contacts(id);
alter table public.academy_payment_grants add constraint academy_payment_grants_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
alter table public.nations_activation_events add constraint nations_activation_events_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES torneos(id) ON DELETE RESTRICT;
alter table public.nations_activation_delegates add constraint nations_activation_delegates_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES nations_activation_events(torneo_id);
alter table public.nations_activation_delegates add constraint nations_activation_delegates_user_id_fkey FOREIGN KEY (user_id) REFERENCES auth.users(id);
alter table public.nations_activation_participants add constraint nations_activation_participants_participante_id_fkey FOREIGN KEY (participante_id) REFERENCES torneo_participantes(id);
alter table public.nations_activation_participants add constraint nations_activation_participants_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES nations_activation_events(torneo_id);
alter table public.nations_activation_participants add constraint nations_activation_participants_guardian_reviewed_by_fkey FOREIGN KEY (guardian_reviewed_by) REFERENCES auth.users(id);
alter table public.nations_activation_participants add constraint nations_activation_participants_torneo_id_participante_id_fkey FOREIGN KEY (torneo_id, participante_id) REFERENCES torneo_participantes(torneo_id, id);
alter table public.nations_activation_invites add constraint nations_activation_invites_participante_id_fkey FOREIGN KEY (participante_id) REFERENCES nations_activation_participants(participante_id);
alter table public.nations_activation_invites add constraint nations_activation_invites_created_by_fkey FOREIGN KEY (created_by) REFERENCES auth.users(id);
alter table public.nations_activation_invites add constraint nations_activation_invites_used_by_fkey FOREIGN KEY (used_by) REFERENCES auth.users(id);
alter table public.nations_activation_audit add constraint nations_activation_audit_torneo_id_fkey FOREIGN KEY (torneo_id) REFERENCES nations_activation_events(torneo_id);
alter table public.nations_activation_audit add constraint nations_activation_audit_participante_id_fkey FOREIGN KEY (participante_id) REFERENCES torneo_participantes(id);
alter table public.nations_activation_audit add constraint nations_activation_audit_actor_id_fkey FOREIGN KEY (actor_id) REFERENCES auth.users(id);
