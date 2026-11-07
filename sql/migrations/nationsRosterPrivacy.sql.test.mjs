import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const FORWARD = fs.readFileSync(new URL('./20261107010000_nations_roster_privacy.sql', import.meta.url), 'utf8');

async function db({torneo, approved = false, actor = null}) {
  const d = new PGlite();
  await d.exec('create role anon; create role authenticated; create role service_role;');
  await d.exec(`create schema if not exists auth;
    create table auth.users(id uuid primary key);
    create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor', true),'')::uuid $$;
    create table public.torneos(id bigint primary key, sede_id bigint, modalidad_plantel text, plan_nations jsonb, fecha_inicio date, horas_revelar_equipos int);
    create table public.user_roles(user_id uuid, role text, sede_id bigint);
    create table public.equipos(id bigint primary key, torneo_id bigint, creador_id uuid, jugadores jsonb default '[]'::jsonb);
    create table public.partidos(id bigint primary key, torneo_id bigint, equipo_a_id bigint, equipo_b_id bigint);
    create table public.nations_activation_events(torneo_id bigint, roster_publication_approved boolean);
    create table public.gestionar_dummy(x int);
    insert into public.torneos(id,sede_id,modalidad_plantel,plan_nations,fecha_inicio,horas_revelar_equipos)
      values (1,7,'selecciones', '${JSON.stringify(torneo).replace(/'/g, "''")}'::jsonb, '2026-11-20', 48);
    insert into public.nations_activation_events values (1, ${approved === true});
    insert into public.equipos values (20,1,'00000000-0000-4000-8000-000000000001','[]'::jsonb);`);
  await d.exec(`create or replace function public.gestionar_participantes_torneo(p_torneo_id bigint,p_actor_id uuid,p_accion text,p_payload jsonb default '{}')
    returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $fn$
    declare t public.torneos; shared_visible boolean:=true; reveal_at timestamptz;
    begin
      select * into t from public.torneos where id=p_torneo_id;
      shared_visible:=coalesce(reveal_at<=now(),false);
      return jsonb_build_object('shared_visible',shared_visible);
    end $fn$;`);
  await d.exec(FORWARD);
  await d.exec(FORWARD); // idempotente: segunda pasada no falla
  await d.exec(`select set_config('test.actor', ${actor ? `'${actor}'` : 'null'}, false)`);
  return d;
}

const ROME_LATE = {config:{timezone:'Europe/Rome', reveal_at:'2000-01-01T00:00:00Z'}};
const ROME_FUTURE = {config:{timezone:'Europe/Rome', reveal_at:'2099-01-01T00:00:00Z'}};

test('approval false no revela aunque la fecha haya pasado', async () => {
  const d = await db({torneo: ROME_LATE, approved: false});
  const {rows} = await d.query('select public.puede_leer_nations(1,null,null) as v');
  assert.equal(rows[0].v, false); await d.close();
});

test('approval true + reveal_at pasado revela; futuro oculta', async () => {
  const a = await db({torneo: ROME_LATE, approved: true});
  assert.equal((await a.query('select public.puede_leer_nations(1,null,null) v')).rows[0].v, true); await a.close();
  const b = await db({torneo: ROME_FUTURE, approved: true});
  assert.equal((await b.query('select public.puede_leer_nations(1,null,null) v')).rows[0].v, false); await b.close();
});

test('sin timezone o reveal_at invalido permanece oculto', async () => {
  const a = await db({torneo: {config:{}}, approved: true});
  assert.equal((await a.query('select public.puede_leer_nations(1,null,null) v')).rows[0].v, false); await a.close();
  const b = await db({torneo: {config:{timezone:'Europe/Rome', reveal_at:'no-es-fecha'}}, approved: true});
  assert.equal((await b.query('select public.puede_leer_nations(1,null,null) v')).rows[0].v, false); await b.close();
});

test('fallback: fecha_inicio a mediodia en zona menos horas (Rome, DST invierno)', async () => {
  const d = await db({torneo: {config:{timezone:'Europe/Rome'}}, approved: true});
  const {rows} = await d.query("select (((fecha_inicio)::date + time '12:00') AT TIME ZONE 'Europe/Rome') - interval '48 hours' as esperado from public.torneos where id=1");
  const esperado = rows[0].esperado;
  const {rows:r2} = await d.query('select now() >= $1 as v', [esperado]);
  // La funcion debe coincidir con la formula (mediodia en zona - horas), sin desfase.
  const fn = (await d.query('select public.puede_leer_nations(1,null,null) v')).rows[0].v;
  assert.equal(fn, r2[0].v, 'la funcion debe coincidir con el instante calculado');
  await d.close();
});

test('torneo comun no se bloquea', async () => {
  const d = await db({torneo: null, approved: false});
  await d.exec("update public.torneos set modalidad_plantel='equipos', plan_nations=null where id=1");
  assert.equal((await d.query('select public.puede_leer_nations(1,null,null) v')).rows[0].v, true);
  await d.close();
});

test('capitan real ve su equipo; ajeno no', async () => {
  const cap = await db({torneo: ROME_LATE, approved: false, actor:'00000000-0000-4000-8000-000000000001'});
  assert.equal((await cap.query('select public.puede_leer_nations(1,20,null) v')).rows[0].v, true); await cap.close();
  const otro = await db({torneo: ROME_LATE, approved: false, actor:'00000000-0000-4000-8000-000000000009'});
  assert.equal((await otro.query('select public.puede_leer_nations(1,20,null) v')).rows[0].v, false); await otro.close();
});

test('la RPC queda parcheada de forma reproducible', async () => {
  const d = await db({torneo: ROME_LATE, approved: true});
  const {rows} = await d.query("select pg_get_functiondef(oid) def from pg_proc where proname='gestionar_participantes_torneo'");
  assert.match(rows[0].def, /shared_visible boolean:=false/);
  assert.match(rows[0].def, /roster_publication_approved/);
  await d.close();
});
