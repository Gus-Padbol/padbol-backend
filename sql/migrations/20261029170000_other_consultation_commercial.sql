-- Owner authorized Other consultation in the commercial inbox; preserve original messages and routing conflicts.
begin;
create or replace function public.crm_commercial_form_is_allowed(p_conversation uuid) returns boolean
language sql stable set search_path=pg_catalog,public as $$
 select exists(select 1 from public.crm_conversations c
 where c.id=p_conversation and c.source_channel='email' and c.test_hidden_at is null and c.email_return_linked_to is null
 and (
  (c.origin=any(array[
   'web_form:Consulta Padbol · Quiero una cancha Padbol',
   'web_form:Consulta Padbol · Quiero sumar Padbol a mi club',
   'web_form:Consulta Padbol · Quiero abrir un Punto Padbol exclusivo',
   'web_form:Consulta Padbol · Quiero representar Padbol en mi ciudad o región',
   'web_form:Consulta Padbol · Quiero representar Padbol en mi país',
   'web_form:Consulta Padbol · Otra consulta',
   'web_form:solicitud_licencia','web_form:dev_padbol_contacto_business'])
   and coalesce(c.qualification_data#>>'{routing,workflow}','commercial_lead')='commercial_lead'
   and coalesce(c.qualification_data#>>'{form_submission,fields,workflow}','commercial_lead')='commercial_lead')
  or (c.origin='institutional_email' and exists(select 1 from public.crm_commercial_email_triage t where t.conversation_id=c.id))
 ))
$$;
revoke all on function public.crm_commercial_form_is_allowed(uuid) from public,anon,authenticated;
grant execute on function public.crm_commercial_form_is_allowed(uuid) to service_role;


with added as (
 insert into public.crm_commercial_form_cases(conversation_id,assigned_user_id)
 select id,'7225442b-defd-42c1-a5a2-b9c1c339fa69'::uuid from public.crm_conversations
 where origin='web_form:Consulta Padbol · Otra consulta' and public.crm_commercial_form_is_allowed(id)
 on conflict do nothing returning conversation_id
)
insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details)
select '8beebdbe-e1d7-4607-9bb0-9a7d64701408'::uuid,'form_registered',conversation_id,
 jsonb_build_object('reason','Owner authorized Other consultation in commercial inbox','migration','20261029170000') from added;
commit;
