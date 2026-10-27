create role anon;create role authenticated;create role service_role;
create function public.crm_commercial_owner(uuid,boolean)returns boolean language sql as 'select $1=''aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa''::uuid and $2';
create function public.content_workspace_coordinator_access(uuid)returns boolean language sql as 'select $1=''bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb''::uuid';
