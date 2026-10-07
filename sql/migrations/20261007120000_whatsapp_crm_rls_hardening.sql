-- Close direct public API access to WhatsApp CRM data in QA.
-- These tables contain contact details and operational history and are only
-- consumed by trusted backend processes using the service_role/Postgres role.

begin;

revoke all on table
  public.whatsapp_crm_contacts,
  public.whatsapp_crm_contact_origins,
  public.whatsapp_crm_timeline
from public, anon, authenticated;

alter table public.whatsapp_crm_contacts enable row level security;
alter table public.whatsapp_crm_contact_origins enable row level security;
alter table public.whatsapp_crm_timeline enable row level security;

-- Keep the trusted server-side path explicit. service_role bypasses RLS, but
-- retaining its table grants documents and preserves the intended contract.
grant all on table
  public.whatsapp_crm_contacts,
  public.whatsapp_crm_contact_origins,
  public.whatsapp_crm_timeline
to service_role;

-- The origin helper mutates whatsapp_crm_contact_origins. Keep its RPC surface
-- private as well; it previously inherited PostgreSQL's default PUBLIC EXECUTE.
revoke execute on function public.whatsapp_crm_note_origin(uuid, text, text)
from public, anon, authenticated;
grant execute on function public.whatsapp_crm_note_origin(uuid, text, text)
to service_role;

commit;
