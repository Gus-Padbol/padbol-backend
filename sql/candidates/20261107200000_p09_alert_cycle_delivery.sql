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
        select 1 from public.crm_commercial_cases c where c.id=a.case_id and c.status in ('open','suspended')
          and c.assigned_user_id = a.advisor_id))
      or (a.case_type='form' and not exists (
        select 1 from public.crm_commercial_form_cases f where f.conversation_id=a.case_id
          and f.assigned_user_id = a.advisor_id
          and coalesce(f.progress_state,'') not in ('cerrado','closed')))
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
    insert into public.crm_lead_alerts (case_type,case_id,advisor_id,cycle,state,opened_at,due_reminder_at,due_escalation_at,reminded_at,escalated_at,updated_at)
    select b.case_type,b.case_id,b.advisor_id,
           coalesce((select max(a2.cycle) from public.crm_lead_alerts a2
                      where a2.case_type=b.case_type and a2.case_id=b.case_id),0)+1,
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
grant execute on function public.crm_lead_alerts_sweep(timestamptz) to service_role;
alter table public.crm_lead_alerts enable row level security;
revoke all on table public.crm_lead_alerts from public,anon,authenticated;
grant all on table public.crm_lead_alerts to service_role;

commit;


-- Recibo durable de notificaciones: una fila por alerta+etapa+destinatario.
begin;
create table if not exists public.crm_lead_alert_deliveries (
  alert_id uuid not null,
  stage text not null check (stage ~ '^[a-z0-9_]{1,40}$'),
  recipient_id uuid not null,
  state text not null default 'claimed' check (state in ('claimed','sent','failed','ambiguous','unconfirmed')),
  claimed_at timestamptz not null default now(),
  sent_at timestamptz,
  attempts integer not null default 1 check (attempts > 0),
  error_code text,
  primary key (alert_id, stage, recipient_id)
);
create index if not exists crm_lead_alert_deliveries_retry
  on public.crm_lead_alert_deliveries (state, claimed_at) where state='failed';
alter table public.crm_lead_alert_deliveries enable row level security;
revoke all on public.crm_lead_alert_deliveries from public, anon, authenticated;
grant select, insert, update, delete on public.crm_lead_alert_deliveries to service_role;

create table if not exists public.crm_agenda_reminders (
  id uuid primary key default gen_random_uuid(),
  case_type text not null check (case_type in ('whatsapp','form')),
  case_id uuid not null,
  advisor_id uuid not null,
  scheduled_at timestamptz not null,
  anticipation_hours integer not null check (anticipation_hours > 0),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (case_type, case_id, scheduled_at, anticipation_hours)
);
create or replace function public.crm_agenda_reminders_sweep(p_now timestamptz default now())
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_inserted int := 0;
begin
  with base as (
    select 'whatsapp'::text case_type, c.id case_id, c.assigned_user_id advisor_id,
           c.next_contact_at scheduled_at, c.reminder_hours
      from public.crm_commercial_cases c
     where c.status in ('open','suspended') and c.assigned_user_id is not null
       and c.next_contact_at is not null
    union all
    select 'form', f.conversation_id, f.assigned_user_id, f.next_contact_at, f.reminder_hours
      from public.crm_commercial_form_cases f
     where f.assigned_user_id is not null and f.next_contact_at is not null
       and coalesce(f.progress_state,'') not in ('cerrado','closed')
  ), hours as (
    select b.*, h.anticipation
      from base b cross join lateral unnest(coalesce(b.reminder_hours, array[24,8])) h(anticipation)
     where h.anticipation > 0 and p_now >= b.scheduled_at - make_interval(hours => h.anticipation)
  ), inserted as (
    insert into public.crm_agenda_reminders (case_type,case_id,advisor_id,scheduled_at,anticipation_hours,active)
    select case_type,case_id,advisor_id,scheduled_at,anticipation,true from hours
    on conflict (case_type,case_id,scheduled_at,anticipation_hours) do update
      set active=true, advisor_id=excluded.advisor_id
    returning 1)
  select count(*) into v_inserted from inserted;
  return jsonb_build_object('inserted', v_inserted, 'at', p_now);
end $$;
create or replace function public.crm_agenda_reminders_reconcile()
returns void language sql security definer set search_path=pg_catalog,public as $$
  update public.crm_agenda_reminders r set active=false
   where r.active and not exists (
     select 1 from public.crm_commercial_cases c
      where r.case_type='whatsapp' and c.id=r.case_id and c.status in ('open','suspended')
        and c.assigned_user_id=r.advisor_id and c.next_contact_at=r.scheduled_at
        and r.anticipation_hours = any(coalesce(c.reminder_hours,array[24,8])))
     and not exists (
     select 1 from public.crm_commercial_form_cases f
      where r.case_type='form' and f.conversation_id=r.case_id
        and f.assigned_user_id=r.advisor_id and f.next_contact_at=r.scheduled_at
        and coalesce(f.progress_state,'') not in ('cerrado','closed')
        and r.anticipation_hours = any(coalesce(f.reminder_hours,array[24,8])));
$$;
alter table public.crm_agenda_reminders enable row level security;
revoke all on public.crm_agenda_reminders from public, anon, authenticated;
grant select, insert, update, delete on public.crm_agenda_reminders to service_role;
revoke all on function public.crm_agenda_reminders_sweep(timestamptz) from public, anon, authenticated;
revoke all on function public.crm_agenda_reminders_reconcile() from public, anon, authenticated;
grant execute on function public.crm_agenda_reminders_sweep(timestamptz) to service_role;
grant execute on function public.crm_agenda_reminders_reconcile() to service_role;
commit;
