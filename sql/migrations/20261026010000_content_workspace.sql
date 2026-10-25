begin;
create table if not exists public.content_workspace_items(
 id uuid primary key default gen_random_uuid(),version bigint not null default 1,
 payload jsonb not null,created_by uuid not null,updated_by uuid not null,
 created_at timestamptz not null default now(),updated_at timestamptz not null default now()
);
create table if not exists public.content_workspace_history(
 id bigint generated always as identity primary key,item_id uuid not null references public.content_workspace_items(id),
 actor_id uuid not null,action text not null,version bigint not null,snapshot jsonb not null,created_at timestamptz not null default now()
);
alter table public.content_workspace_items enable row level security;
alter table public.content_workspace_history enable row level security;
revoke all on public.content_workspace_items,public.content_workspace_history from public,anon,authenticated;
grant select,insert,update on public.content_workspace_items to service_role;
grant select,insert on public.content_workspace_history to service_role;
grant usage,select on sequence public.content_workspace_history_id_seq to service_role;
create or replace function public.content_workspace_immutable() returns trigger language plpgsql set search_path=pg_catalog as $$begin raise exception 'IMMUTABLE_HISTORY';end$$;
create trigger content_workspace_no_history_changes before update or delete on public.content_workspace_history for each row execute function public.content_workspace_immutable();
create trigger content_workspace_no_item_deletes before delete on public.content_workspace_items for each row execute function public.content_workspace_immutable();
create or replace function public.content_workspace_json(r public.content_workspace_items) returns jsonb language sql stable set search_path=pg_catalog as $$select r.payload||jsonb_build_object('id',r.id,'version',r.version,'createdBy',r.created_by,'updatedBy',r.updated_by,'createdAt',r.created_at,'updatedAt',r.updated_at)$$;
create table if not exists public.content_workspace_files(id uuid primary key,item_id uuid not null references public.content_workspace_items(id),name text not null,mime_type text not null,size bigint not null,storage_path text not null unique,created_by uuid not null,created_at timestamptz not null default now());
alter table public.content_workspace_files enable row level security;
revoke all on public.content_workspace_files from public,anon,authenticated;
grant select,insert on public.content_workspace_files to service_role;
create trigger content_workspace_files_immutable before update or delete on public.content_workspace_files for each row execute function public.content_workspace_immutable();
create or replace function public.content_workspace_command(p_actor uuid,p_can_approve boolean,p_operation text,p_id uuid default null,p_version bigint default null,p_patch jsonb default '{}'::jsonb) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare r public.content_workspace_items; d jsonb; s text; oldstatus text;
begin
 if p_actor is null then raise exception 'FORBIDDEN';end if;
 if p_operation='list' then return jsonb_build_object('items',coalesce((select jsonb_agg(public.content_workspace_json(x) order by x.updated_at desc) from (select * from public.content_workspace_items where coalesce(p_can_approve,false) or created_by=p_actor or payload->>'assignedUserId'=p_actor::text order by updated_at desc limit 1000)x),'[]'::jsonb));end if;
 if p_operation='read' then
  select * into r from public.content_workspace_items where id=p_id and (coalesce(p_can_approve,false) or created_by=p_actor or payload->>'assignedUserId'=p_actor::text);if not found then raise exception 'NOT_FOUND';end if;
  return jsonb_build_object('item',public.content_workspace_json(r),'files',coalesce((select jsonb_agg(jsonb_build_object('id',f.id,'name',f.name,'mimeType',f.mime_type,'size',f.size,'createdAt',f.created_at,'createdBy',f.created_by) order by f.created_at desc) from public.content_workspace_files f where f.item_id=p_id),'[]'::jsonb),'history',coalesce((select jsonb_agg(jsonb_build_object('id',h.id,'actorId',h.actor_id,'action',h.action,'version',h.version,'snapshot',h.snapshot,'createdAt',h.created_at) order by h.id desc) from public.content_workspace_history h where h.item_id=p_id),'[]'::jsonb));
 end if;
 if p_operation not in ('create','update','publication') or jsonb_typeof(p_patch)<>'object' then raise exception 'INVALID';end if;
 if p_operation in ('update','publication') then
  select * into r from public.content_workspace_items where id=p_id and (coalesce(p_can_approve,false) or created_by=p_actor or payload->>'assignedUserId'=p_actor::text) for update;if not found then raise exception 'NOT_FOUND';end if;
  if p_version is null or r.version<>p_version then raise exception 'VERSION_CONFLICT';end if;
  oldstatus:=r.payload->>'status';d:=r.payload||p_patch;
  if p_operation='publication' then
   if oldstatus not in ('aprobado','publicado') then raise exception 'INVALID';end if;
   d:=r.payload||jsonb_build_object('status','publicado','publications',coalesce(r.payload->'publications','[]'::jsonb)||jsonb_build_array(jsonb_build_object('channel',p_patch->>'channel','profile',p_patch->>'profile','publicationUrl',p_patch->>'publicationUrl','publishedAt',p_patch->>'publishedAt','actorId',p_actor,'registeredAt',now())),'channel',p_patch->>'channel','profile',p_patch->>'profile','publicationUrl',p_patch->>'publicationUrl','publishedAt',p_patch->>'publishedAt');
  end if;
 else d:=jsonb_build_object('status','propuesto','assetKind','original')||p_patch;end if;
 if coalesce(p_patch->>'assignedUserId','')<>'' and not exists(select 1 from public.user_roles where user_id::text=p_patch->>'assignedUserId' and role='editor_contenido') then raise exception 'INVALID';end if;
 if p_patch ? 'assignedUserId' and not coalesce(p_can_approve,false) and coalesce(p_patch->>'assignedUserId','')<>coalesce(r.payload->>'assignedUserId','') then raise exception 'FORBIDDEN';end if;
 if p_patch ? 'reviewNote' and not coalesce(p_can_approve,false) and coalesce(p_patch->>'reviewNote','')<>coalesce(r.payload->>'reviewNote','') then raise exception 'FORBIDDEN';end if;
 s:=d->>'status';
 if coalesce(length(trim(d->>'title')),0) not between 1 and 180 or s not in ('propuesto','preparando','revision','cambios','aprobado','publicado') or d->>'assetKind' not in ('original','editable','textless','final') then raise exception 'INVALID';end if;
 if s in ('aprobado','cambios') and (not p_can_approve or p_can_approve is null) and (p_operation='create' or s is distinct from oldstatus) then raise exception 'FORBIDDEN';end if;
 -- Editing approved content invalidates that approval; only direction can reapprove it.
 if p_operation='update' and oldstatus in ('aprobado','publicado') and s in ('aprobado','publicado') and (d-'status'-'publishedAt'-'channel'-'profile'-'publicationUrl') is distinct from (r.payload-'status'-'publishedAt'-'channel'-'profile'-'publicationUrl') and not coalesce(p_can_approve,false) then raise exception 'FORBIDDEN';end if;
 if s='revision' and coalesce(d->>'assetUrl','')='' and not exists(select 1 from public.content_workspace_files where item_id=p_id) then raise exception 'INVALID';end if;
 if s='aprobado' and coalesce(d->>'assetUrl','')='' and not exists(select 1 from public.content_workspace_files where item_id=p_id) then raise exception 'INVALID';end if;
 if s='publicado' then
  if p_operation='create' or oldstatus not in ('aprobado','publicado') then raise exception 'INVALID';end if;
  if coalesce(d->>'publicationUrl','')='' or coalesce(d->>'publishedAt','')='' or coalesce(d->>'profile','')='' or coalesce(d->>'channel','')='' then raise exception 'INVALID';end if;
 end if;
 if p_operation='create' then insert into public.content_workspace_items(payload,created_by,updated_by)values(d,p_actor,p_actor)returning * into r;
 else update public.content_workspace_items set payload=d,version=version+1,updated_by=p_actor,updated_at=now()where id=p_id returning * into r;end if;
 insert into public.content_workspace_history(item_id,actor_id,action,version,snapshot)values(r.id,p_actor,p_operation,r.version,public.content_workspace_json(r));
 return jsonb_build_object('item',public.content_workspace_json(r));
end$$;
create or replace function public.content_workspace_file_add(p_actor uuid,p_can_approve boolean,p_item uuid,p_id uuid,p_name text,p_mime text,p_size bigint,p_path text) returns jsonb language plpgsql set search_path=pg_catalog,public as $$
declare r public.content_workspace_items;f public.content_workspace_files;
begin
 select * into r from public.content_workspace_items where id=p_item and (coalesce(p_can_approve,false) or created_by=p_actor or payload->>'assignedUserId'=p_actor::text) for update;
 if not found then raise exception 'FORBIDDEN';end if;
 if p_actor is null or p_size not between 1 and 52428800 or p_path<>p_item::text||'/'||p_id::text then raise exception 'INVALID';end if;
 insert into public.content_workspace_files(id,item_id,name,mime_type,size,storage_path,created_by)values(p_id,p_item,p_name,p_mime,p_size,p_path,p_actor)returning * into f;
 update public.content_workspace_items set version=version+1,updated_at=now(),updated_by=p_actor,payload=payload||jsonb_build_object('status',case when payload->>'status' in ('aprobado','publicado') then 'revision' else payload->>'status' end)where id=p_item returning * into r;
 insert into public.content_workspace_history(item_id,actor_id,action,version,snapshot)values(p_item,p_actor,'file_uploaded',r.version,public.content_workspace_json(r)||jsonb_build_object('fileId',p_id,'fileName',p_name));
 return jsonb_build_object('id',f.id,'name',f.name,'mimeType',f.mime_type,'size',f.size,'createdAt',f.created_at,'createdBy',f.created_by);
end$$;
revoke all on function public.content_workspace_file_add(uuid,boolean,uuid,uuid,text,text,bigint,text) from public,anon,authenticated;
grant execute on function public.content_workspace_file_add(uuid,boolean,uuid,uuid,text,text,bigint,text) to service_role;
revoke all on function public.content_workspace_command(uuid,boolean,text,uuid,bigint,jsonb) from public,anon,authenticated;
grant execute on function public.content_workspace_command(uuid,boolean,text,uuid,bigint,jsonb) to service_role;
revoke all on function public.content_workspace_json(public.content_workspace_items),public.content_workspace_immutable() from public,anon,authenticated;
grant execute on function public.content_workspace_json(public.content_workspace_items),public.content_workspace_immutable() to service_role;
-- Private company originals; browser roles have no object policies for this bucket.
insert into storage.buckets(id,name,public,file_size_limit,allowed_mime_types) values('content-workspace-private','content-workspace-private',false,52428800,array['image/png','image/jpeg','image/webp','image/gif','video/mp4','video/webm','video/quicktime','application/pdf']) on conflict(id) do update set public=false,file_size_limit=excluded.file_size_limit,allowed_mime_types=excluded.allowed_mime_types;
create policy content_workspace_private_browser_deny on storage.objects as restrictive for all to anon,authenticated using(bucket_id<>'content-workspace-private') with check(bucket_id<>'content-workspace-private');
commit;
