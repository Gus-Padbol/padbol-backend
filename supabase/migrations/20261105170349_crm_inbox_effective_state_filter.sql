-- Service-only inbox projection. Authorization is performed by the CRM HTTP service;
-- commercial_only narrows the result and never derives rights from user metadata.
create or replace function public.crm_inbox_effective_state_list(
 p_state text, p_commercial_only boolean default false,
 p_hidden_only boolean default false, p_source_channel text default null,
 p_origins text[] default null, p_conversation_id uuid default null,
 p_ticket_number text default null, p_email_triage_enabled boolean default false
) returns setof jsonb language sql stable security invoker
set search_path = pg_catalog, public
as $function$
 with scoped as (
  select c.*, f.assigned_user_id as commercial_assigned_user_id,
    f.progress_state as commercial_progress_state,
    f.commercial_next_step,
    (c.source_channel='email' and c.origin='institutional_email'
      and c.test_hidden_at is null and c.email_return_linked_to is null
      and t.conversation_id is not null) as verified_triage,
    co.id as projected_contact_id, co.nombre as projected_contact_name,
    co.email_normalized as projected_contact_email,
    co.phone_normalized as projected_contact_phone,
    co.review_needed as projected_contact_review
  from public.crm_conversations c
  left join public.crm_contacts co on co.id=c.contact_id
  left join public.crm_commercial_email_triage t on t.conversation_id=c.id
  left join public.crm_commercial_form_cases f on f.conversation_id=c.id
    and c.source_channel='email'
    and (
      (c.origin=any(array[
       'manual','manual_contact',
       'web_form:Consulta Padbol · Quiero una cancha Padbol',
       'web_form:Consulta Padbol · Quiero sumar Padbol a mi club',
       'web_form:Consulta Padbol · Quiero abrir un Punto Padbol exclusivo',
       'web_form:Consulta Padbol · Quiero representar Padbol en mi ciudad o región',
       'web_form:Consulta Padbol · Quiero representar Padbol en mi país',
       'web_form:Consulta Padbol · Otra consulta',
       'web_form:solicitud_licencia','web_form:dev_padbol_contacto_business'])
       and coalesce(c.qualification_data#>>'{routing,workflow}','commercial_lead')='commercial_lead'
       and coalesce(c.qualification_data#>>'{form_submission,fields,workflow}','commercial_lead')='commercial_lead')
      or (c.origin='institutional_email' and c.email_return_linked_to is null
          and t.conversation_id is not null)
    )
  where (case when p_hidden_only then c.test_hidden_at is not null else c.test_hidden_at is null end)
   and (p_source_channel is null or c.source_channel=p_source_channel)
   and (p_origins is null or c.origin=any(p_origins))
   and (p_conversation_id is null or c.id=p_conversation_id)
   and (p_ticket_number is null or c.ticket_number::text=p_ticket_number)
   and (not p_commercial_only or (
      (c.source_channel='email' and c.origin=any(array[
       'web_form:Consulta Padbol · Quiero una cancha Padbol',
       'web_form:Consulta Padbol · Quiero sumar Padbol a mi club',
       'web_form:Consulta Padbol · Quiero abrir un Punto Padbol exclusivo',
       'web_form:Consulta Padbol · Quiero representar Padbol en mi ciudad o región',
       'web_form:Consulta Padbol · Quiero representar Padbol en mi país',
       'web_form:Consulta Padbol · Otra consulta',
       'web_form:solicitud_licencia','web_form:dev_padbol_contacto_business'])
       and coalesce(c.qualification_data#>>'{routing,workflow}','commercial_lead')='commercial_lead'
       and coalesce(c.qualification_data#>>'{form_submission,fields,workflow}','commercial_lead')='commercial_lead')
      or (c.source_channel='whatsapp' and c.origin='whatsapp:1376102838911694'
          and c.qualification_data#>>'{whatsapp_menu,topic}'='sede')
      or (p_email_triage_enabled and c.source_channel='email' and c.origin='institutional_email'
          and c.test_hidden_at is null and c.email_return_linked_to is null and t.conversation_id is not null)
   ))
 ), filtered as (
  select s.* from scoped s
  where coalesce(s.commercial_progress_state,s.estado)=p_state
  order by s.updated_at desc, s.id desc limit 200
 )
 select (to_jsonb(s) - array['commercial_assigned_user_id','commercial_progress_state',
   'commercial_next_step','verified_triage','projected_contact_id','projected_contact_name',
   'projected_contact_email','projected_contact_phone','projected_contact_review'])
   || jsonb_build_object('contact',case when s.projected_contact_id is null then null else
      jsonb_build_object('id',s.projected_contact_id,'nombre',s.projected_contact_name,
       'email_normalized',s.projected_contact_email,'phone_normalized',s.projected_contact_phone,
       'review_needed',s.projected_contact_review) end)
   || case when s.commercial_progress_state is null then '{}'::jsonb else
     jsonb_build_object('commercial_management',jsonb_build_object(
       'assigned_user_id',s.commercial_assigned_user_id,'progress_state',s.commercial_progress_state,
       'next_step',s.commercial_next_step)) end
   || case when p_email_triage_enabled and s.verified_triage then
      jsonb_build_object('commercial_email_triage_verified',true) else '{}'::jsonb end
 from filtered s order by s.updated_at desc,s.id desc;
$function$;
revoke all on function public.crm_inbox_effective_state_list(text,boolean,boolean,text,text[],uuid,text,boolean) from public, anon, authenticated;
grant execute on function public.crm_inbox_effective_state_list(text,boolean,boolean,text,text[],uuid,text,boolean) to service_role;
