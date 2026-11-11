-- Manual commercial follow-up records phone calls, emails, meetings and other actions.
begin;
alter table public.crm_activities drop constraint if exists crm_activities_type_check;
alter table public.crm_activities add constraint crm_activities_type_check
  check (activity_type in ('note','phone_call','zoom_meeting','in_person_meeting','email','other'));
commit;
