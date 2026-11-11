begin;
-- Cierra la carrera guard/DROP: bloquea AMBAS tablas nuevas antes de mirar filas.
do $lock$ begin
  if to_regclass('public.crm_lead_alert_deliveries') is not null then
    execute 'lock table public.crm_lead_alert_deliveries in access exclusive mode';
  end if;
  if to_regclass('public.crm_agenda_reminders') is not null then
    execute 'lock table public.crm_agenda_reminders in access exclusive mode';
  end if;
end $lock$;
do $guard$ begin
  if exists (select 1 from public.crm_lead_alert_deliveries limit 1)
     or exists (select 1 from public.crm_agenda_reminders limit 1) then
    raise exception 'P09_HAS_DATA: hay recibos/recordatorios. Detenido: conservar esquema compatible si JS vuelve atras.';
  end if;
end $guard$;
drop function if exists public.crm_agenda_reminders_reconcile();
drop function if exists public.crm_agenda_reminders_sweep(timestamptz);
drop table if exists public.crm_agenda_reminders;
drop table if exists public.crm_lead_alert_deliveries;
-- Restaura la funcion real anterior (snapshot de produccion), sin tocar tabla ni filas.
CREATE OR REPLACE FUNCTION public.crm_lead_alerts_sweep(p_now timestamp with time zone DEFAULT now())
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'pg_catalog', 'public'
AS $function$
declare v_opened int := 0; v_reminded int := 0; v_escalated int := 0; v_resolved int := 0;
        v_nuevas_vencidas int := 0; v_nuevas_escaladas int := 0;
begin
  -- 1. Resolver alertas cuyo caso se cerro o perdio asignacion.
  with cerradas as (
    update public.crm_lead_alerts a set state='resuelta', resolved_at=p_now, updated_at=p_now,
      resolution=coalesce(a.resolution,'caso cerrado')
    where a.resolved_at is null and (
      (a.case_type='whatsapp' and not exists (
        select 1 from public.crm_commercial_cases c where c.id=a.case_id and c.status in ('open','suspended') and c.assigned_user_id is not null))
      or (a.case_type='form' and not exists (
        select 1 from public.crm_commercial_form_cases f where f.conversation_id=a.case_id and f.assigned_user_id is not null))
    ) returning 1)
  select count(*) into v_resolved from cerradas;

  -- 2. Abrir alertas para casos asignados y abiertos sin alerta vigente.
  with base as (
    select 'whatsapp'::text as case_type, c.id as case_id, c.assigned_user_id as advisor_id,
           coalesce((select max(t.created_at) from public.crm_commercial_team_activities t
                     where t.case_id=c.id and t.case_type='whatsapp'), c.created_at) as last_activity
    from public.crm_commercial_cases c
    where c.status in ('open','suspended') and c.assigned_user_id is not null
    union all
    select 'form'::text, f.conversation_id, f.assigned_user_id,
           coalesce((select max(t.created_at) from public.crm_commercial_team_activities t
                     where t.case_id=f.conversation_id and t.case_type='form'), f.created_at)
    from public.crm_commercial_form_cases f
    where f.assigned_user_id is not null
  ), nuevos as (
    insert into public.crm_lead_alerts (case_type,case_id,advisor_id,state,opened_at,due_reminder_at,due_escalation_at,reminded_at,escalated_at,updated_at)
    select b.case_type,b.case_id,b.advisor_id,
           case when p_now>=b.last_activity+interval '48 hours' then 'escalada'
                when p_now>=b.last_activity+interval '24 hours' then 'recordatorio'
                else 'pendiente' end,
           b.last_activity, b.last_activity+interval '24 hours', b.last_activity+interval '48 hours',
           case when p_now>=b.last_activity+interval '24 hours' then p_now end,
           case when p_now>=b.last_activity+interval '48 hours' then p_now end,
           p_now
    from base b
    where not exists (select 1 from public.crm_lead_alerts a
                      where a.case_type=b.case_type and a.case_id=b.case_id and a.resolved_at is null)
    on conflict do nothing
    returning state)
  select count(*),
         count(*) filter (where state in ('recordatorio','escalada')),
         count(*) filter (where state='escalada')
    into v_opened, v_nuevas_vencidas, v_nuevas_escaladas
    from nuevos;

  -- 3. Avanzar etapas por tiempo transcurrido.
  with r as (
    update public.crm_lead_alerts set state='recordatorio', reminded_at=p_now, updated_at=p_now
    where resolved_at is null and state='pendiente' and p_now>=due_reminder_at returning 1)
  select count(*) into v_reminded from r;

  with e as (
    update public.crm_lead_alerts set state='escalada', escalated_at=p_now, updated_at=p_now
    where resolved_at is null and state in ('pendiente','recordatorio') and p_now>=due_escalation_at returning 1)
  select count(*) into v_escalated from e;

  return jsonb_build_object('opened',v_opened,'reminded',v_reminded+v_nuevas_vencidas,'escalated',v_escalated+v_nuevas_escaladas,'resolved',v_resolved);
end $function$;

REVOKE ALL ON FUNCTION public.crm_lead_alerts_sweep(timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.crm_lead_alerts_sweep(timestamptz) TO service_role;

-- Restaura ACL/RLS observados: solo service_role sobre tabla y funcion.
alter table public.crm_lead_alerts enable row level security;
revoke all on public.crm_lead_alerts from public, anon, authenticated;
grant all on public.crm_lead_alerts to service_role;
revoke all on function public.crm_lead_alerts_sweep(timestamptz) from public, anon, authenticated;
grant execute on function public.crm_lead_alerts_sweep(timestamptz) to service_role;
commit;
