begin;
alter table public.crm_commercial_advisor_requests add column agreed_conditions text not null default '' check(length(agreed_conditions)<=2000);
alter table public.crm_commercial_advisor_requests drop constraint crm_commercial_advisor_requests_status_check;
alter table public.crm_commercial_advisor_requests add constraint crm_commercial_advisor_requests_status_check check(status in ('pending','pending_verification','approved','rejected'));
drop index public.crm_commercial_advisor_one_pending_email;
create unique index crm_commercial_advisor_one_pending_email on public.crm_commercial_advisor_requests(email) where status in ('pending','pending_verification');
create or replace function public.crm_commercial_advisor_request_json(p_row public.crm_commercial_advisor_requests) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',p_row.id,'email',p_row.email,'name',p_row.name,'territory',p_row.territory,'agreedConditions',p_row.agreed_conditions,'status',p_row.status,'requestedAt',p_row.requested_at,'requestedBy',p_row.requested_by,'reviewedAt',p_row.reviewed_at,'reviewedBy',p_row.reviewed_by,'reviewNote',p_row.review_note,'advisorId',p_row.advisor_id)
$$;
create or replace function public.crm_commercial_advisor_request_decide(p_actor uuid,p_superadmin boolean,p_request uuid,p_decision text,p_note text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.crm_commercial_advisor_requests%rowtype; v_user auth.users%rowtype;
begin
 if not public.crm_commercial_owner(p_actor,p_superadmin) then raise exception 'not authorized'; end if;
 if p_decision is null or p_decision not in ('approved','rejected') or length(coalesce(p_note,''))>1000 then raise exception 'request unavailable'; end if;
 select * into v_row from public.crm_commercial_advisor_requests where id=p_request for update;
 if not found then raise exception 'request unavailable'; end if;
 if v_row.status=p_decision then return public.crm_commercial_advisor_request_json(v_row); end if;
 if v_row.status not in ('pending','pending_verification') then raise exception 'request already reviewed'; end if;
 if p_decision='approved' then
  select * into v_user from auth.users where lower(email)=v_row.email and email_confirmed_at is not null for update;
  if not found then
   update public.crm_commercial_advisor_requests set status='pending_verification',reviewed_by=p_actor,reviewed_at=now(),review_note=btrim(coalesce(p_note,'')) where id=p_request returning * into v_row;
   insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details) values(p_actor,'advisor_verification_pending',p_request,jsonb_build_object('email',v_row.email,'agreedConditions',v_row.agreed_conditions));
   return public.crm_commercial_advisor_request_json(v_row);
  end if;
  if v_user.id in ('7225442b-defd-42c1-a5a2-b9c1c339fa69'::uuid,'8beebdbe-e1d7-4607-9bb0-9a7d64701408'::uuid) then raise exception 'advisor unavailable'; end if;
  insert into public.crm_commercial_advisors(user_id,email) values(v_user.id,v_row.email) on conflict(user_id) do update set email=excluded.email,active=true;
 end if;
 update public.crm_commercial_advisor_requests set status=p_decision,reviewed_by=p_actor,reviewed_at=now(),review_note=btrim(coalesce(p_note,'')),advisor_id=case when p_decision='approved' then v_user.id else null end where id=p_request returning * into v_row;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details) values(p_actor,'advisor_'||p_decision,p_request,jsonb_build_object('advisorId',v_row.advisor_id,'email',v_row.email,'note',v_row.review_note,'agreedConditions',v_row.agreed_conditions));
 return public.crm_commercial_advisor_request_json(v_row);
end $$;
create function public.crm_commercial_advisor_request(p_actor uuid,p_superadmin boolean,p_email text,p_name text,p_territory text,p_agreed_conditions text) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_email text:=lower(btrim(coalesce(p_email,'')));v_row public.crm_commercial_advisor_requests%rowtype;v_owner boolean;
begin
 if p_actor is null or not public.crm_commercial_team_manage(p_actor,p_superadmin) then raise exception 'not authorized'; end if;
 v_owner:=public.crm_commercial_owner(p_actor,p_superadmin);
 if length(v_email) not between 3 and 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(coalesce(p_name,''))>120 or length(coalesce(p_territory,''))>240 or length(coalesce(p_agreed_conditions,''))>2000 then raise exception 'advisor unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended('commercial-advisor:'||v_email,0));
 select * into v_row from public.crm_commercial_advisor_requests where email=v_email and status in ('pending','pending_verification') for update;
 if not found then
  insert into public.crm_commercial_advisor_requests(email,name,territory,agreed_conditions,requested_by) values(v_email,btrim(coalesce(p_name,'')),btrim(coalesce(p_territory,'')),btrim(coalesce(p_agreed_conditions,'')),p_actor) returning * into v_row;
  insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details) values(p_actor,case when v_owner then 'advisor_owner_enrollment' else 'advisor_requested' end,v_row.id,jsonb_build_object('email',v_email,'name',v_row.name,'territory',v_row.territory,'agreedConditions',v_row.agreed_conditions));
 end if;
 if v_owner then return public.crm_commercial_advisor_request_decide(p_actor,p_superadmin,v_row.id,'approved','Alta autorizada por Dirección'); end if;
 return public.crm_commercial_advisor_request_json(v_row);
end $$;
create or replace function public.crm_commercial_advisor_request(p_actor uuid,p_superadmin boolean,p_email text,p_name text default '',p_territory text default '') returns jsonb
language sql security definer set search_path=pg_catalog,public as $$select public.crm_commercial_advisor_request(p_actor,p_superadmin,p_email,p_name,p_territory,'')$$;
alter function public.crm_commercial_advisor_request(uuid,boolean,text,text,text,text) owner to postgres;
revoke all on function public.crm_commercial_advisor_request(uuid,boolean,text,text,text,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_advisor_request(uuid,boolean,text,text,text,text) to service_role;
commit;
