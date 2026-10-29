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


commit;
