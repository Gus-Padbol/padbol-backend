create or replace function public._fx(t text, d jsonb) returns void language plpgsql as $$
declare cols text[] := '{}'; vals text[] := '{}'; k text; v text; r record;
begin
  for r in select a.attname, format_type(a.atttypid,a.atttypmod) tp from pg_attribute a join pg_class c on c.oid=a.attrelid
    where c.relnamespace='public'::regnamespace and c.relname=t and a.attnum>0 and not a.attisdropped and a.attnotnull
      and not exists(select 1 from pg_attrdef x where x.adrelid=a.attrelid and x.adnum=a.attnum)
  loop
    if d ? r.attname then v := d->>r.attname;
    else v := case when r.tp like 'uuid%' then '00000000-0000-4000-8000-00000000ffff'
              when r.tp like 'bool%' then 'false' when r.tp ~ 'int|numeric' then '0'
              when r.tp like 'date%' then '2026-01-01' when r.tp like 'timestamp%' then '2026-01-01T00:00:00Z'
              when r.tp like 'json%' then '{}' else 'X' end;
    end if;
    cols := cols || r.attname; vals := vals || quote_literal(v);
  end loop;
  for k in select jsonb_object_keys(d) loop
    if not (k = any(cols)) then cols := cols || k; vals := vals || quote_literal(d->>k); end if;
  end loop;
  execute format('insert into public.%I (%s) values (%s) on conflict do nothing', t, array_to_string(cols,','), array_to_string(vals,','));
end $$;
select public._fx('sedes','{"id":"7","pais":"Italia","ciudad":"Napoli","zona_horaria":"Europe/Rome","timezone":"Europe/Rome","tipo_sede":"torneo"}'::jsonb);
select public._fx('torneos','{"id":"1","sede_id":"7","deporte":"padbol","modalidad_plantel":"selecciones","estado":"inscripcion","fecha_inicio":"2020-01-01","fecha_fin":"2099-12-31","horas_revelar_equipos":"48"}'::jsonb);
select public._fx('torneo_nations_planes','{"torneo_id":"1","plan":"{\"config\":{\"timezone\":\"Europe/Rome\",\"reveal_at\":\"2020-01-01T00:00:00Z\"}}"}'::jsonb);
insert into public.nations_activation_events(torneo_id,slug,title,enabled,roster_publication_approved) values (1,'fixture-nations','Fixture',true,false) on conflict (slug) do update set roster_publication_approved=false;
insert into auth.users(id,email) values ('00000000-0000-4000-8000-0000000000cc','a@t.invalid'),('00000000-0000-4000-8000-0000000000bb','adm@t.invalid'),('00000000-0000-4000-8000-0000000000dd','b@t.invalid') on conflict do nothing;
select public._fx('user_roles','{"user_id":"00000000-0000-4000-8000-0000000000bb","role":"super_admin"}'::jsonb);
insert into public.torneo_participantes(id,torneo_id,sede_id,nombre,tipo_identidad,origen,creado_por,linked_user_id,estado_vinculacion) values
 ('11111111-1111-4111-8111-111111111111',1,7,'Jugador A','cuenta','cuenta','00000000-0000-4000-8000-0000000000cc','00000000-0000-4000-8000-0000000000cc','vinculado'),
 ('22222222-2222-4222-8222-222222222222',1,7,'Jugador B','cuenta','cuenta','00000000-0000-4000-8000-0000000000dd','00000000-0000-4000-8000-0000000000dd','vinculado') on conflict do nothing;
insert into public.equipos(id,torneo_id,sede_id,nombre,creador_id,jugadores,cupo_maximo,inscripcion_estado) values
 (20,1,7,'Equipo A','00000000-0000-4000-8000-0000000000cc',jsonb_build_array(jsonb_build_object('participante_id','11111111-1111-4111-8111-111111111111','nombre','Jugador A','user_id','00000000-0000-4000-8000-0000000000cc')),8,'confirmado'),
 (21,1,7,'Equipo B','00000000-0000-4000-8000-0000000000dd',jsonb_build_array(jsonb_build_object('participante_id','22222222-2222-4222-8222-222222222222','nombre','Jugador B','user_id','00000000-0000-4000-8000-0000000000dd')),8,'confirmado') on conflict do nothing;
insert into public.torneo_participante_equipos(torneo_id,participante_id,equipo_id,cuenta_user_id) values (1,'11111111-1111-4111-8111-111111111111',20,'00000000-0000-4000-8000-0000000000cc'),(1,'22222222-2222-4222-8222-222222222222',21,'00000000-0000-4000-8000-0000000000dd') on conflict do nothing;
