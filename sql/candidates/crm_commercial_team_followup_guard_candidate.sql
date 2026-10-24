-- Candidate only: requires commercial calls and followup migrations.
begin;
create or replace function public.crm_claim_whatsapp_followup(p_cycle uuid, p_step integer, p_now timestamptz)
returns boolean language plpgsql security invoker set search_path = public as $$
declare c public.crm_whatsapp_followup_cycles%rowtype; v_count integer; v_due timestamptz;
begin
  -- Serialize with call open and actual dispatch: conversation first, then cycle.
  perform 1 from public.crm_conversations cv join public.crm_whatsapp_followup_cycles cy on cy.conversation_id=cv.id where cy.id=p_cycle for update of cv;
  select * into c from public.crm_whatsapp_followup_cycles where id = p_cycle for update;
  if exists(select 1 from public.crm_commercial_team_calls where conversation_id=c.conversation_id and status='pending') then return false; end if;
  if not found or c.status <> 'waiting' or not c.consent or not c.template_approved or p_step is null or p_step not between 1 and 3 or p_now is null then return false; end if;
  if not exists (select 1 from public.crm_conversations cv where cv.id=c.conversation_id and cv.source_channel='whatsapp' and cv.estado <> 'cerrado') or exists (select 1 from public.crm_inbound_events e where e.conversation_id=c.conversation_id and e.created_at >= c.waiting_since) then
    update public.crm_whatsapp_followup_cycles set status='cancelled' where id=p_cycle;
    return false;
  end if;
  v_due := c.waiting_since + case p_step when 1 then interval '48 hours' when 2 then interval '120 hours' else interval '192 hours' end;
  if p_now < v_due then return false; end if;
  select count(*) into v_count from public.crm_whatsapp_followup_attempts where cycle_id=p_cycle and status='accepted' and step < p_step;
  if v_count <> p_step - 1 then return false; end if;
  -- Do not burst old overdue steps when a worker restarts.
  if p_step > 1 and exists (select 1 from public.crm_whatsapp_followup_attempts where cycle_id=p_cycle and step=p_step-1 and status='accepted' and updated_at + interval '72 hours' > p_now) then return false; end if;
  insert into public.crm_whatsapp_followup_attempts(cycle_id, step, status) values(p_cycle,p_step,'claimed') on conflict do nothing;
  return found;
end $$;

revoke all on function public.crm_claim_whatsapp_followup(uuid,integer,timestamptz) from public,anon,authenticated;
grant execute on function public.crm_claim_whatsapp_followup(uuid,integer,timestamptz) to service_role;
-- A new human call ends the prior waiting period. A later explicit decision
-- to wait must create a fresh cycle and separately check consent and templates.
create function public.crm_commercial_call_cancel_previous_followup() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 update public.crm_whatsapp_followup_cycles set status='cancelled' where conversation_id=new.conversation_id and status='waiting';
 return new;
end $$;
create trigger crm_commercial_call_cancel_previous_followup after insert on public.crm_commercial_team_calls for each row execute function public.crm_commercial_call_cancel_previous_followup();
revoke all on function public.crm_commercial_call_cancel_previous_followup() from public,anon,authenticated;
commit;
