-- Existing Academy schema only; no users, enrollments or historical data are migrated.
-- An enrollment row is a server-verified paid/manual grant, never a client signup.
begin;

do $compatibility$
declare missing text;
begin
  select string_agg(expected.tbl || '.' || expected.col, ', ' order by expected.tbl,expected.col)
  into missing
  from (values
    ('academy_profiles','id','uuid'),('academy_profiles','full_name','text'),('academy_profiles','created_at','timestamp with time zone'),
    ('academy_enrollments','id','uuid'),('academy_enrollments','user_id','uuid'),('academy_enrollments','course_id','integer'),('academy_enrollments','product_id','integer'),('academy_enrollments','created_at','timestamp with time zone'),
    ('academy_progress','id','uuid'),('academy_progress','user_id','uuid'),('academy_progress','course_id','integer'),('academy_progress','lesson_id','integer'),('academy_progress','completed_at','timestamp with time zone'),
    ('academy_quiz_attempts','id','uuid'),('academy_quiz_attempts','user_id','uuid'),('academy_quiz_attempts','course_id','integer'),('academy_quiz_attempts','quiz_id','integer'),('academy_quiz_attempts','score','integer'),('academy_quiz_attempts','total','integer'),('academy_quiz_attempts','passed','boolean'),('academy_quiz_attempts','created_at','timestamp with time zone'),
    ('academy_certificates','id','uuid'),('academy_certificates','user_id','uuid'),('academy_certificates','course_id','integer'),('academy_certificates','course_title','text'),('academy_certificates','student_name','text'),('academy_certificates','certificate_type','text'),('academy_certificates','issued_at','timestamp with time zone')
  ) expected(tbl,col,typ)
  where not exists (
    select 1 from information_schema.columns c
    join pg_namespace n on n.nspname=c.table_schema
    join pg_class r on r.relnamespace=n.oid and r.relname=c.table_name and r.relkind='r'
    where c.table_schema='public' and c.table_name=expected.tbl and c.column_name=expected.col and c.data_type=expected.typ
  );
  if missing is not null then raise exception 'ACADEMY_SCHEMA_INCOMPATIBLE: %',missing; end if;
end $compatibility$;

do $boundary$
declare tbl text; policy_name text; columns_sql text; owner_column text;
begin
  foreach tbl in array array['academy_profiles','academy_enrollments','academy_progress','academy_quiz_attempts','academy_certificates'] loop
    execute format('alter table public.%I enable row level security',tbl);
    -- Remove all old permissive ALL policies, including unexpected policy names.
    for policy_name in select policyname from pg_policies where schemaname='public' and tablename=tbl loop
      execute format('drop policy %I on public.%I',policy_name,tbl);
    end loop;
    execute format('revoke all privileges on table public.%I from public,anon,authenticated',tbl);
    -- Table-level REVOKE does not remove previous column-level privileges.
    select string_agg(quote_ident(column_name),', ' order by ordinal_position) into columns_sql
      from information_schema.columns where table_schema='public' and table_name=tbl;
    execute format('revoke all privileges (%s) on table public.%I from public,anon,authenticated',columns_sql,tbl);
    execute format('grant select on table public.%I to authenticated',tbl);
    execute format('grant select,insert,update,delete on table public.%I to service_role',tbl);
    owner_column := case when tbl='academy_profiles' then 'id' else 'user_id' end;
    execute format('create policy %I on public.%I for select to authenticated using ((select auth.uid())=%I)',tbl || '_own_select',tbl,owner_column);
  end loop;
end $boundary$;

-- Display name is editable personal data; no user/role/course authorization fields.
grant update (full_name) on table public.academy_profiles to authenticated;
create policy academy_profiles_own_update on public.academy_profiles
  for update to authenticated
  using ((select auth.uid())=id) with check ((select auth.uid())=id);

commit;
