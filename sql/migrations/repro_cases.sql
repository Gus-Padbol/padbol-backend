\set ON_ERROR_STOP on
do $$
declare r jsonb; a int; b int; n int; names text;
begin
  -- CASO 1: approval false => participants NO incluye a B; teams solo A
  perform set_config('test.actor','00000000-0000-4000-8000-0000000000cc',false);
  r := public.gestionar_participantes_torneo(1,'00000000-0000-4000-8000-0000000000cc','listar','{}'::jsonb);
  names := coalesce((select string_agg(p->>'nombre',',') from jsonb_array_elements(r->'participants') p),'');
  if names like '%Jugador B%' then raise exception 'CASO1: B visible con approval false (%)', names; end if;
  n := jsonb_array_length(r->'teams'); if n <> 1 then raise exception 'CASO1: teams esperaba 1, obtuve %', n; end if;
  raise notice 'CASO1 OK: approval false => B oculto; teams solo A';

  -- CASO 2: approval true + reveal pasado => participants SÍ incluye B; teams sigue solo A
  update public.nations_activation_events set roster_publication_approved=true where torneo_id=1;
  update public.torneos set plan_nations='{"config":{"timezone":"Europe/Rome","reveal_at":"2020-01-01T00:00:00Z"}}'::jsonb where id=1;
  r := public.gestionar_participantes_torneo(1,'00000000-0000-4000-8000-0000000000cc','listar','{}'::jsonb);
  names := coalesce((select string_agg(p->>'nombre',',') from jsonb_array_elements(r->'participants') p),'');
  if names not like '%Jugador B%' then raise exception 'CASO2: B no visible con approval+reveal (%)', names; end if;
  n := jsonb_array_length(r->'teams'); if n <> 1 then raise exception 'CASO2: teams esperaba 1, obtuve %', n; end if;
  raise notice 'CASO2 OK: approval+reveal => catalogo con B; teams solo A';

  -- CASO 3: reveal futuro => B oculto
  update public.torneo_nations_planes set plan = jsonb_set(plan,'{config,reveal_at}','"2099-01-01T00:00:00Z"') where torneo_id=1;
  r := public.gestionar_participantes_torneo(1,'00000000-0000-4000-8000-0000000000cc','listar','{}'::jsonb);
  names := coalesce((select string_agg(p->>'nombre',',') from jsonb_array_elements(r->'participants') p),'');
  if names like '%Jugador B%' then raise exception 'CASO3: B visible antes del reveal'; end if;
  raise notice 'CASO3 OK: reveal futuro => B oculto';

  -- CASO 4: torneo NORMAL (plan NULL, modalidad equipos) => catalogo con B
  update public.torneo_nations_planes set plan = jsonb_set(plan,'{config,reveal_at}','"2020-01-01T00:00:00Z"') where torneo_id=1;
  update public.nations_activation_events set roster_publication_approved=false where torneo_id=1;
  update public.torneos set modalidad_plantel='dobles', plan_nations=null where id=1;
  r := public.gestionar_participantes_torneo(1,'00000000-0000-4000-8000-0000000000cc','listar','{}'::jsonb);
  names := coalesce((select string_agg(p->>'nombre',',') from jsonb_array_elements(r->'participants') p),'');
  if names not like '%Jugador B%' then raise exception 'CASO4: torneo normal perdio el catalogo (%)', names; end if;
  raise notice 'CASO4 OK: torneo normal conserva catalogo con B';

  -- CASO 5: admin ve con B aunque este sellado
  update public.torneos set modalidad_plantel='selecciones', plan_nations='{"config":{"timezone":"Europe/Rome"}}'::jsonb where id=1;
  r := public.gestionar_participantes_torneo(1,'00000000-0000-4000-8000-0000000000bb','listar','{}'::jsonb);
  names := coalesce((select string_agg(p->>'nombre',',') from jsonb_array_elements(r->'participants') p),'');
  if names not like '%Jugador B%' then raise exception 'CASO5: admin no ve el catalogo (%)', names; end if;
  raise notice 'CASO5 OK: admin ve el catalogo aunque este sellado';
end $$;
select 'RESULTADO: 5/5 OK' as resultado;
