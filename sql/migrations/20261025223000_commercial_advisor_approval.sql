begin;
-- No existing advisor is changed. New access always requires the exact owner's approval.
create table public.crm_commercial_advisor_requests (
 id uuid primary key default gen_random_uuid(), email text not null,
 name text not null default '', territory text not null default '',
 status text not null default 'pending' check(status in ('pending','approved','rejected')),
 requested_by uuid not null, requested_at timestamptz not null default now(),
 reviewed_by uuid, reviewed_at timestamptz, review_note text not null default '', advisor_id uuid references auth.users(id),
 check(email=lower(btrim(email)) and length(email) between 3 and 254),
 check(length(name)<=120 and length(territory)<=240 and length(review_note)<=1000)
);
create unique index crm_commercial_advisor_one_pending_email on public.crm_commercial_advisor_requests(email) where status='pending';
alter table public.crm_commercial_advisor_requests enable row level security;
revoke all on public.crm_commercial_advisor_requests from public,anon,authenticated;
grant all on public.crm_commercial_advisor_requests to service_role;
create function public.crm_commercial_owner(p_actor uuid,p_superadmin boolean) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
 select coalesce(p_superadmin,false) and p_actor='8beebdbe-e1d7-4607-9bb0-9a7d64701408'::uuid
 and exists(select 1 from auth.users u join public.user_roles r on r.user_id=u.id
 where u.id=p_actor and lower(u.email)='padbolinternacional@gmail.com' and u.email_confirmed_at is not null
 and lower(r.email)='padbolinternacional@gmail.com' and r.role='super_admin')
$$;
create function public.crm_commercial_advisor_request_json(p_row public.crm_commercial_advisor_requests) returns jsonb
language sql immutable set search_path=pg_catalog,public as $$
 select jsonb_build_object('id',p_row.id,'email',p_row.email,'name',p_row.name,'territory',p_row.territory,'status',p_row.status,'requestedAt',p_row.requested_at,'requestedBy',p_row.requested_by,'reviewedAt',p_row.reviewed_at,'reviewedBy',p_row.reviewed_by,'reviewNote',p_row.review_note,'advisorId',p_row.advisor_id)
$$;
create function public.crm_commercial_advisor_request(p_actor uuid,p_superadmin boolean,p_email text,p_name text default '',p_territory text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_email text:=lower(btrim(coalesce(p_email,''))); v_row public.crm_commercial_advisor_requests%rowtype;
begin
 if p_actor is null or not public.crm_commercial_team_manage(p_actor,p_superadmin) then raise exception 'not authorized'; end if;
 if length(v_email) not between 3 and 254 or v_email !~ '^[^[:space:]@]+@[^[:space:]@]+\.[^[:space:]@]+$' or length(coalesce(p_name,''))>120 or length(coalesce(p_territory,''))>240 then raise exception 'advisor unavailable'; end if;
 perform pg_advisory_xact_lock(hashtextextended('commercial-advisor:'||v_email,0));
 select * into v_row from public.crm_commercial_advisor_requests where email=v_email and status='pending';
 if found then return public.crm_commercial_advisor_request_json(v_row); end if;
 insert into public.crm_commercial_advisor_requests(email,name,territory,requested_by) values(v_email,btrim(coalesce(p_name,'')),btrim(coalesce(p_territory,'')),p_actor) returning * into v_row;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details) values(p_actor,'advisor_requested',v_row.id,jsonb_build_object('email',v_email,'name',v_row.name,'territory',v_row.territory));
 return public.crm_commercial_advisor_request_json(v_row);
end $$;
-- Close the legacy direct-enable bypass at database level too.
create or replace function public.crm_commercial_advisor_add(p_actor uuid,p_superadmin boolean,p_email text) returns jsonb
language sql security definer set search_path=pg_catalog,public as $$
 select public.crm_commercial_advisor_request(p_actor,p_superadmin,p_email,'','')
$$;
create function public.crm_commercial_advisor_requests_list(p_actor uuid,p_superadmin boolean) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if p_actor is null or not public.crm_commercial_team_manage(p_actor,p_superadmin) then raise exception 'not authorized'; end if;
 return coalesce((select jsonb_agg(public.crm_commercial_advisor_request_json(r) order by r.requested_at desc) from public.crm_commercial_advisor_requests r),'[]'::jsonb);
end $$;
create function public.crm_commercial_advisor_request_decide(p_actor uuid,p_superadmin boolean,p_request uuid,p_decision text,p_note text default '') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row public.crm_commercial_advisor_requests%rowtype; v_user auth.users%rowtype;
begin
 if not public.crm_commercial_owner(p_actor,p_superadmin) then raise exception 'not authorized'; end if;
 if p_decision is null or p_decision not in ('approved','rejected') or length(coalesce(p_note,''))>1000 then raise exception 'request unavailable'; end if;
 select * into v_row from public.crm_commercial_advisor_requests where id=p_request for update;
 if not found then raise exception 'request unavailable'; end if;
 if v_row.status=p_decision then return public.crm_commercial_advisor_request_json(v_row); end if;
 if v_row.status<>'pending' then raise exception 'request already reviewed'; end if;
 if p_decision='approved' then
  select * into v_user from auth.users where lower(email)=v_row.email and email_confirmed_at is not null for update;
  if not found then raise exception 'account not confirmed'; end if;
  if v_user.id in ('7225442b-defd-42c1-a5a2-b9c1c339fa69'::uuid,'8beebdbe-e1d7-4607-9bb0-9a7d64701408'::uuid) then raise exception 'advisor unavailable'; end if;
  insert into public.crm_commercial_advisors(user_id,email) values(v_user.id,v_row.email) on conflict(user_id) do update set email=excluded.email,active=true;
 end if;
 update public.crm_commercial_advisor_requests set status=p_decision,reviewed_by=p_actor,reviewed_at=now(),review_note=btrim(coalesce(p_note,'')),advisor_id=case when p_decision='approved' then v_user.id else null end where id=p_request returning * into v_row;
 insert into public.crm_commercial_team_audit(actor_id,action,subject_id,details) values(p_actor,'advisor_'||p_decision,p_request,jsonb_build_object('advisorId',v_row.advisor_id,'email',v_row.email,'note',v_row.review_note));
 return public.crm_commercial_advisor_request_json(v_row);
end $$;
alter function public.crm_commercial_owner(uuid,boolean) owner to postgres;
alter function public.crm_commercial_advisor_request(uuid,boolean,text,text,text) owner to postgres;
alter function public.crm_commercial_advisor_add(uuid,boolean,text) owner to postgres;
alter function public.crm_commercial_advisor_requests_list(uuid,boolean) owner to postgres;
alter function public.crm_commercial_advisor_request_decide(uuid,boolean,uuid,text,text) owner to postgres;
revoke all on function public.crm_commercial_owner(uuid,boolean),public.crm_commercial_advisor_request_json(public.crm_commercial_advisor_requests),public.crm_commercial_advisor_request(uuid,boolean,text,text,text),public.crm_commercial_advisor_add(uuid,boolean,text),public.crm_commercial_advisor_requests_list(uuid,boolean),public.crm_commercial_advisor_request_decide(uuid,boolean,uuid,text,text) from public,anon,authenticated;
grant execute on function public.crm_commercial_owner(uuid,boolean),public.crm_commercial_advisor_request_json(public.crm_commercial_advisor_requests),public.crm_commercial_advisor_request(uuid,boolean,text,text,text),public.crm_commercial_advisor_add(uuid,boolean,text),public.crm_commercial_advisor_requests_list(uuid,boolean),public.crm_commercial_advisor_request_decide(uuid,boolean,uuid,text,text) to service_role;
commit;
