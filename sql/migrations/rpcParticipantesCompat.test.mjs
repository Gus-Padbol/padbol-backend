/**
 * Compatibilidad REAL: la migración 20261016140000 crea el esquema y la RPC reales.
 * Solo se stubea auth (schema/usuarios) y se crean las tablas preexistentes que la RPC
 * referencia (torneos, user_roles, equipos, partidos, ...). Luego se aplica la forward
 * de privacidad y se prueban los 5 casos del catálogo.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const SCHEMA = fs.readFileSync(new URL('./rpc_schema_real.sql', import.meta.url), 'utf8');
const GENERIC = fs.readFileSync(new URL('./20261016140000_tournament_generic_participants.sql', import.meta.url), 'utf8');
const FORWARD = fs.readFileSync(new URL('./20261107010000_nations_roster_privacy.sql', import.meta.url), 'utf8');

const PREEXISTING = `
create role anon; create role authenticated; create role service_role;
create schema if not exists auth;
create table auth.users(id uuid primary key, email text, raw_app_meta_data jsonb default '{}'::jsonb);
create or replace function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('test.actor',true),'')::uuid $$;
create or replace function public.uuid_generate_v4() returns uuid language sql volatile as $$ select gen_random_uuid() $$;
create or replace function public.tgenabled() returns text language sql immutable as $$ select 'O'::text $$;
create or replace function public.gen_random_bytes(n integer) returns bytea language sql volatile as $$ select decode(substr(repeat(md5(random()::text), 8), 1, n*2), 'hex') $$;
`;

async function db({modalidad='selecciones', plan=null, approved=false, actor=null, admin=false, revealPast=true}={}) {
  const d = new PGlite();
  await d.exec(PREEXISTING);
  await d.exec(SCHEMA);

  await d.exec(GENERIC);
  await d.exec(`create or replace function public.participante_plantel_congelado(uuid) returns boolean language sql stable as $$ select false $$;`);
  await d.exec(`insert into auth.users(id,email) values
    ('00000000-0000-4000-8000-0000000000cc','outsider@test.invalid'),
    ('00000000-0000-4000-8000-0000000000bb','admin@test.invalid'),
    ('00000000-0000-4000-8000-0000000000aa','capitan@test.invalid')`);
  await insertRow(d,'sedes',{id:7,timezone:'Europe/Rome',pais:'Italia',ciudad:'Napoli'});
  await insertRow(d,'torneos',{id:1,sede_id:7,deporte:'padbol',modalidad_plantel:modalidad,formato_equipo:'dobles',estado:'inscripcion',
    plan_nations: plan===null ? null : JSON.stringify(plan), fecha_inicio: revealPast?'2020-01-01':'2099-01-01', fecha_fin:'2099-12-31',
    horas_revelar_equipos:48, costo_inscripcion:0, inscripcion_monto:null, es_prueba:false});
  await insertRow(d,'nations_activation_events',{torneo_id:1,roster_publication_approved:approved===true,title:'Fixture Event',slug:'fixture-event'});
  if (admin) await insertRow(d,'user_roles',{user_id:'00000000-0000-4000-8000-0000000000bb',role:'super_admin'});
  await d.exec(`insert into public.torneo_participantes(torneo_id,sede_id,nombre,tipo_identidad,origen) values (1,7,'Jugador Uno','generico','club')`);
  await d.exec(`insert into public.equipos(id,torneo_id,sede_id,nombre,creador_id,jugadores,cupo_maximo,inscripcion_estado,modalidad_plantel)
    values (20,1,7,'Equipo A','00000000-0000-4000-8000-0000000000aa','[]'::jsonb,8,'confirmado','${modalidad}')`);
  await d.exec(FORWARD);
  await d.exec(`select set_config('test.actor', ${actor?`'${actor}'`:'null'}, false)`);
  return d;
}


async function insertRow(d, table, obj) {
  const {rows} = await d.query(`select column_name, udt_name from information_schema.columns
    where table_schema='public' and table_name=$1 and is_nullable='NO' and column_default is null`, [table]);
  const fill = (u) => u==='uuid' ? '00000000-0000-4000-8000-00000000ffff'
    : u==='boolean' ? false
    : ['int8','int4','int2','numeric','float8','float4'].includes(u) ? 0
    : u==='date' ? '2026-01-01'
    : ['timestamptz','timestamp'].includes(u) ? '2026-01-01T00:00:00Z'
    : (u==='jsonb'||u==='json') ? {}
    : 'X';
  const data = {...obj};
  for (const c of rows) if (!(c.column_name in data)) data[c.column_name] = fill(c.udt_name);
  const keys = Object.keys(data);
  await d.query(`insert into public.${table} (${keys.join(',')}) values (${keys.map((_,i)=>'$'+(i+1)).join(',')})`, keys.map((k)=>data[k]));
}

const listar = (d, actor) => d.query("select public.gestionar_participantes_torneo(1, $1::uuid, 'listar', '{}'::jsonb) as r", [actor]);
const OUT = '00000000-0000-4000-8000-0000000000cc';
const ADM = '00000000-0000-4000-8000-0000000000bb';

test('1) Nations approval false: outsider sin catalogo', async () => {
  const d = await db({approved:false, actor:OUT});
  const {rows} = await listar(d, OUT);
  assert.equal(rows[0].r.shared_visible, false); assert.deepEqual(rows[0].r.teams ?? [], []);
  await d.close();
});
test('2) Nations approval true + fecha pasada: catalogo visible', async () => {
  const d = await db({approved:true, revealPast:true, actor:OUT});
  const {rows} = await listar(d, OUT);
  assert.equal(rows[0].r.shared_visible, true);
  await d.close();
});
test('3) torneo NORMAL conserva el catalogo previo', async () => {
  const d = await db({modalidad:'equipos', approved:false, actor:OUT});
  const {rows} = await listar(d, OUT);
  assert.equal(rows[0].r.shared_visible, true);
  await d.close();
});
test('4) admin ve el catalogo aunque este sellado', async () => {
  const d = await db({approved:false, actor:ADM, admin:true});
  const {rows} = await listar(d, ADM);
  assert.equal(rows[0].r.shared_visible, true);
  await d.close();
});
test('5) la forward es idempotente sobre la RPC real', async () => {
  const d = await db({approved:true});
  await d.exec(FORWARD);
  const {rows} = await d.query("select pg_get_functiondef(oid) def from pg_proc where proname='gestionar_participantes_torneo'");
  assert.match(rows[0].def, /roster_publication_approved/);
  await d.close();
});
