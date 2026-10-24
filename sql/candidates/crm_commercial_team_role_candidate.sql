begin;
create function public.crm_commercial_team_role(p_actor uuid,p_superadmin boolean) returns text language sql stable set search_path=pg_catalog,public as $$
 select case when p_actor is null then 'none' when public.crm_commercial_team_manage(p_actor,p_superadmin) then 'manager'
 when exists(select 1 from public.crm_commercial_advisors a join auth.users u on u.id=a.user_id where a.user_id=p_actor and a.active and u.email_confirmed_at is not null and lower(u.email)=a.email) then 'advisor' else 'none' end
$$;
revoke all on function public.crm_commercial_team_role(uuid,boolean) from public,anon,authenticated;
grant execute on function public.crm_commercial_team_role(uuid,boolean) to service_role;
commit;
