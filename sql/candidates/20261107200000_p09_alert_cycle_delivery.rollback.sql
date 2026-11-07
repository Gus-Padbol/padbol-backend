begin;
do $guard$ begin
  if exists (select 1 from public.crm_lead_alert_deliveries limit 1)
     or exists (select 1 from public.crm_agenda_reminders limit 1) then
    raise exception 'P09_HAS_DATA: hay recibos/recordatorios. Detenido: conservar esquema si JS vuelve atras.';
  end if;
end $guard$;
drop function if exists public.crm_agenda_reminders_reconcile();
drop function if exists public.crm_agenda_reminders_sweep(timestamptz);
drop table if exists public.crm_agenda_reminders;
drop table if exists public.crm_lead_alert_deliveries;
commit;
