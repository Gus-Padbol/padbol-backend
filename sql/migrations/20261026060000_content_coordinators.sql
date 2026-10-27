begin;
create table public.content_workspace_coordinators(user_id uuid primary key references auth.users(id),email text not null unique,active boolean not null default true,granted_by uuid not null,granted_at timestamptz not null default now());
create table public.content_workspace_access_history(id bigint generated always as identity primary key,user_id uuid not null,actor_id uuid not null,active boolean not null,created_at timestamptz not null default now());
alter table public.content_workspace_coordinators enable row level security;
alter table public.content_workspace_access_history enable row level security;
revoke all on public.content_workspace_coordinators,public.content_workspace_access_history from public,anon,authenticated;
grant select,insert,update on public.content_workspace_coordinators to service_role;
grant select,insert on public.content_workspace_access_history to service_role;
grant usage,select on sequence public.content_workspace_access_history_id_seq to service_role;
create trigger content_workspace_access_history_immutable before update or delete on public.content_workspace_access_history for each row execute function public.content_workspace_immutable();
create function public.content_workspace_coordinator_access(p_actor uuid) returns boolean language sql stable security definer set search_path=pg_catalog,public as $$select exists(select 1 from public.content_workspace_coordinators c join auth.users u on u.id=c.user_id where c.user_id=p_actor and c.active and lower(u.email)=c.email and u.email_confirmed_at is not null)$$;
create function public.content_workspace_coordinator_grant(p_actor uuid,p_email text,p_active boolean) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare u auth.users%rowtype;e text:=lower(btrim(coalesce(p_email,'')));n bigint;
begin
 if not public.crm_commercial_owner(p_actor,true) then raise exception 'FORBIDDEN';end if;
 if p_active is null or length(e) not between 3 and 254 then raise exception 'INVALID';end if;
 perform pg_advisory_xact_lock(hashtextextended('content-coordinator:'||e,0));
 select count(*) into n from auth.users where lower(email)=e;
 if n<>1 then raise exception 'IDENTITY_UNVERIFIED';end if;
 select * into u from auth.users where lower(email)=e for update;
 if u.email_confirmed_at is null then raise exception 'IDENTITY_UNVERIFIED';end if;
 if exists(select 1 from public.content_workspace_coordinators where user_id=u.id and email=e and active=p_active) then return jsonb_build_object('userId',u.id,'email',e,'active',p_active,'scope','content_coordinator');end if;
 insert into public.content_workspace_coordinators(user_id,email,active,granted_by) values(u.id,e,p_active,p_actor) on conflict(user_id) do update set email=excluded.email,active=excluded.active,granted_by=excluded.granted_by,granted_at=now();
 insert into public.content_workspace_access_history(user_id,actor_id,active) values(u.id,p_actor,p_active);
 return jsonb_build_object('userId',u.id,'email',e,'active',p_active,'scope','content_coordinator');
end$$;
create function public.content_workspace_coordinators_list(p_actor uuid) returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$begin
 if not public.crm_commercial_owner(p_actor,true) then raise exception 'FORBIDDEN';end if;
 return coalesce((select jsonb_agg(jsonb_build_object('userId',c.user_id,'email',c.email,'name',coalesce((select nombre from public.user_roles where user_id=c.user_id limit 1),'Coordinación'),'active',c.active) order by c.email) from public.content_workspace_coordinators c),'[]'::jsonb);
end$$;
create function public.content_workspace_invalidate_review() returns trigger language plpgsql set search_path=pg_catalog,public as $$begin
 if old.payload->>'status' in ('aprobado','publicado') and (new.payload->>'status' not in ('aprobado','publicado') or ((new.payload->'assetUrl',new.payload->'assetKind',new.payload->'title',new.payload->'brief',new.payload->'topic',new.payload->'audience',new.payload->'language',new.payload->'format') is distinct from (old.payload->'assetUrl',old.payload->'assetKind',old.payload->'title',old.payload->'brief',old.payload->'topic',old.payload->'audience',old.payload->'language',old.payload->'format') and new.payload->'reviewedAt' is not distinct from old.payload->'reviewedAt')) then
  new.payload:=(new.payload-'reviewedBy'-'reviewedAt'-'promotionDecidedBy'-'promotionDecidedAt')||jsonb_build_object('status',case when new.payload->>'status' in ('aprobado','publicado') then 'revision' else new.payload->>'status' end,'promotionDecision','sin_decidir','promotionNote','');
 end if;
 return new;
end$$;
create trigger content_workspace_invalidate_review before update on public.content_workspace_items for each row execute function public.content_workspace_invalidate_review();
alter function public.content_workspace_command(uuid,boolean,text,uuid,bigint,jsonb) rename to content_workspace_command_base;
create function public.content_workspace_command(p_actor uuid,p_can_approve boolean,p_operation text,p_id uuid default null,p_version bigint default null,p_patch jsonb default '{}'::jsonb) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare r public.content_workspace_items;d jsonb;allowed boolean;result jsonb;
begin
 allowed:=coalesce(p_can_approve,false) and (exists(select 1 from public.user_roles where user_id=p_actor and role='super_admin') or public.content_workspace_coordinator_access(p_actor));
 if p_operation='promotion' then
  if not (public.crm_commercial_owner(p_actor,true) or public.content_workspace_coordinator_access(p_actor)) then raise exception 'FORBIDDEN';end if;
  select * into r from public.content_workspace_items where id=p_id for update;if not found then raise exception 'NOT_FOUND';end if;
  if p_version is null or r.version<>p_version then raise exception 'VERSION_CONFLICT';end if;
  if p_patch->>'decision' is null or p_patch->>'decision' not in ('sin_decidir','organico','promocionar','no_promocionar') or length(coalesce(p_patch->>'note',''))>3000 then raise exception 'INVALID';end if;
  if p_patch->>'decision'='promocionar' and r.payload->>'status' not in ('aprobado','publicado') then raise exception 'INVALID';end if;
  d:=r.payload||jsonb_build_object('promotionDecision',p_patch->>'decision','promotionNote',coalesce(p_patch->>'note',''),'promotionDecidedBy',p_actor,'promotionDecidedAt',now());
  update public.content_workspace_items set payload=d,version=version+1,updated_by=p_actor,updated_at=now() where id=p_id returning * into r;
  insert into public.content_workspace_history(item_id,actor_id,action,version,snapshot) values(r.id,p_actor,'promotion_decided',r.version,public.content_workspace_json(r));
  return jsonb_build_object('item',public.content_workspace_json(r));
 end if;
 if p_patch ?| array['promotionDecision','promotionNote','promotionDecidedBy','promotionDecidedAt','reviewedBy','reviewedAt'] then raise exception 'FORBIDDEN';end if;
 if p_operation in ('create','update') and p_patch->>'status' in ('aprobado','cambios') and allowed then p_patch:=p_patch||jsonb_build_object('reviewedBy',p_actor,'reviewedAt',now());end if;
 result:=public.content_workspace_command_base(p_actor,allowed,p_operation,p_id,p_version,p_patch);
 return result;
end$$;
revoke all on function public.content_workspace_invalidate_review(),public.content_workspace_coordinators_list(uuid),public.content_workspace_coordinator_access(uuid),public.content_workspace_coordinator_grant(uuid,text,boolean),public.content_workspace_command(uuid,boolean,text,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.content_workspace_invalidate_review(),public.content_workspace_coordinators_list(uuid),public.content_workspace_coordinator_access(uuid),public.content_workspace_coordinator_grant(uuid,text,boolean),public.content_workspace_command(uuid,boolean,text,uuid,bigint,jsonb) to service_role;
commit;
