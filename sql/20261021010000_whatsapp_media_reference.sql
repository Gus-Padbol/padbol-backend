-- References only: files are not downloaded or exposed to operators by this migration.
begin;
alter table public.whatsapp_inbound_messages
  add column if not exists meta_media_id text,
  add column if not exists meta_media_type text;
commit;
