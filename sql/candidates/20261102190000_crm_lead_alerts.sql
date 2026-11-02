-- Seguimiento obligatorio de leads: alertas por vencimiento y escalamiento.
-- No duplica el modulo comercial existente: se apoya en crm_commercial_cases,
-- crm_commercial_form_cases y crm_commercial_team_activities.
begin;

create table if not exists public.crm_lead_alerts (
  id uuid primary key default gen_random_uuid(),
  case_type text not null check (case_type in ('whatsapp','form')),
  case_id uuid not null,
  advisor_id uuid not null,
  cycle integer not null default 1 check (cycle > 0),
  state text not null default 'pendiente' check (state in ('pendiente','recordatorio','escalada','resuelta')),
  opened_at timestamptz not null default now(),
  due_reminder_at timestamptz not null,
  due_escalation_at timestamptz not null,
  reminded_at timestamptz,
  escalated_at timestamptz,
  resolved_at timestamptz,
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (case_type, case_id, cycle)
);

-- Una sola alerta abierta por caso: evita duplicados aunque el barrido corra en paralelo.
create unique index if not exists crm_lead_alerts_one_open
  on public.crm_lead_alerts (case_type, case_id) where resolved_at is null;

create index if not exists crm_lead_alerts_open_due
  on public.crm_lead_alerts (state, due_reminder_at) where resolved_at is null;

-- Barrido: abre alertas faltantes, avanza etapas y resuelve las que ya tienen
-- registro completo. Devuelve las transiciones para que el worker notifique una sola vez.
create or replace function public.crm_lead_alerts_sweep(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
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
        select 1 from public.crm_commercial_form_cases f where f.id=a.case_id and f.assigned_user_id is not null))
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
    select 'form'::text, f.id, f.assigned_user_id,
           coalesce((select max(t.created_at) from public.crm_commercial_team_activities t
                     where t.case_id=f.id and t.case_type='form'), f.created_at)
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
end $$;

revoke all on function public.crm_lead_alerts_sweep(timestamptz) from public,anon,authenticated;
revoke all on table public.crm_lead_alerts from anon,authenticated;

commit;
