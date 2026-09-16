-- Consentimiento opcional y específico para seguimiento por WhatsApp.
-- No habilita envíos ni incluye marketing.
begin;

alter table public.solicitudes_licencia
  add column if not exists whatsapp_followup_consent boolean not null default false,
  add column if not exists whatsapp_followup_consent_source text,
  add column if not exists whatsapp_followup_consent_version text,
  add column if not exists whatsapp_followup_consent_text text,
  add column if not exists whatsapp_followup_consent_at timestamptz;

alter table public.solicitudes_licencia
  add constraint solicitudes_licencia_whatsapp_followup_consent_check check (
    (not whatsapp_followup_consent
      and whatsapp_followup_consent_source is null
      and whatsapp_followup_consent_version is null
      and whatsapp_followup_consent_text is null
      and whatsapp_followup_consent_at is null)
    or
    (whatsapp_followup_consent
      and length(trim(whatsapp_followup_consent_source)) between 1 and 120
      and whatsapp_followup_consent_version = 'whatsapp-followup-v1'
      and length(whatsapp_followup_consent_text) between 1 and 1000
      and whatsapp_followup_consent_at is not null)
  );

create index if not exists idx_solicitudes_licencia_whatsapp_followup_consent
  on public.solicitudes_licencia (whatsapp_followup_consent_at desc)
  where whatsapp_followup_consent;

commit;
