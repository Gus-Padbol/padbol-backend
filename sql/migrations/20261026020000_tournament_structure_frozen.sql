begin;
-- Serialize fixture insertion with tournament structure edits, including legacy writers.
create or replace function public.tournament_fixture_parent_lock() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if new.torneo_id is not null then perform id from public.torneos where id=new.torneo_id for update;end if;
 return new;
end$$;
create trigger tournament_fixture_parent_lock before insert or update of torneo_id on public.partidos for each row execute function public.tournament_fixture_parent_lock();
create or replace function public.tournament_structure_frozen_guard() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if (new.tipo_torneo is distinct from old.tipo_torneo or new.cupos_maximos is distinct from old.cupos_maximos) and exists(select 1 from public.partidos where torneo_id=old.id) then
  raise exception using errcode='55000',message='TORNEO_STRUCTURE_FROZEN';
 end if;
 return new;
end$$;
create trigger tournament_structure_frozen_guard before update of tipo_torneo,cupos_maximos on public.torneos for each row execute function public.tournament_structure_frozen_guard();
revoke all on function public.tournament_fixture_parent_lock(),public.tournament_structure_frozen_guard() from public,anon,authenticated;
commit;
