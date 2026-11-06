import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';

const forward = fs.readFileSync(new URL('../sql/migrations/20261106200000_reservas_sede_reservable.sql', import.meta.url), 'utf8');
const rollback = fs.readFileSync(new URL('../sql/migrations/20261106200000_reservas_sede_reservable.rollback.sql', import.meta.url), 'utf8');

async function db() {
  const d = new PGlite();
  await d.exec(`create table public.sedes(id bigserial primary key, nombre text not null, tipo_sede text not null default 'reservable');
    create table public.reservas(id bigserial primary key, sede text, sede_id bigint, estado text default 'pendiente');
    insert into public.sedes(id,nombre,tipo_sede) values (1,'Reservable ficticia','reservable'),(2,'Torneo ficticia','torneo'),(3,'Duplicada','reservable'),(4,'Duplicada','reservable');`);
  return d;
}

test('INSERT en sede de torneo por sede_id se rechaza', async () => {
  const d = await db(); await d.exec(forward);
  await assert.rejects(() => d.query("insert into public.reservas(sede_id,estado) values(2,'pendiente')"), /SEDE_NO_RESERVABLE/);
});

test('INSERT por nombre de sede de torneo se rechaza', async () => {
  const d = await db(); await d.exec(forward);
  await assert.rejects(() => d.query("insert into public.reservas(sede,estado) values('Torneo ficticia','pendiente')"), /SEDE_NO_RESERVABLE/);
});

test('nombre ambiguo NO bloquea; reservable pasa', async () => {
  const d = await db(); await d.exec(forward);
  // Ambiguo: no se puede afirmar que sea de torneo, así que no se bloquea la reserva.
  await d.query("insert into public.reservas(sede,estado) values('Duplicada','pendiente')");
  await d.query("insert into public.reservas(sede_id,estado) values(1,'pendiente')");
  const {rows} = await d.query('select count(*)::int n from public.reservas');
  assert.equal(rows[0].n, 2);
});

test('UPDATE que mueve una reserva a sede de torneo se rechaza', async () => {
  const d = await db(); await d.exec(forward);
  await d.query("insert into public.reservas(sede_id,estado) values(1,'pendiente')");
  await assert.rejects(() => d.query('update public.reservas set sede_id=2'), /SEDE_NO_RESERVABLE/);
});

test('rol restringido sin SELECT en sedes: reservable pasa y torneo se rechaza', async () => {
  const d = await db(); await d.exec(forward);
  await d.exec(`create role app_user nologin; grant insert on public.reservas to app_user; grant usage on sequence public.reservas_id_seq to app_user;`);
  await d.exec('set role app_user');
  await d.query("insert into public.reservas(sede_id,estado) values(1,'pendiente')");
  await assert.rejects(() => d.query("insert into public.reservas(sede_id,estado) values(2,'pendiente')"), /SEDE_NO_RESERVABLE/);
  let denegado = false;
  try { await d.query('select count(*) from public.sedes'); } catch { denegado = true; }
  await d.exec('reset role');
  const {rows} = await d.query('select count(*)::int n from public.reservas');
  assert.equal(rows[0].n, 1);
  assert.equal(denegado, true, 'el rol no debe poder leer sedes');
});

test('nombre legacy/ambiguo no bloquea la reserva histórica', async () => {
  const d = await db(); await d.exec(forward);
  await d.query("insert into public.reservas(sede,estado) values('Sede historica inexistente','pendiente')");
  await d.query("insert into public.reservas(sede,estado) values('Duplicada','pendiente')");
  const {rows} = await d.query('select count(*)::int n from public.reservas');
  assert.equal(rows[0].n, 2);
});

test('rollback idempotente: dos veces sin error y libera el trigger', async () => {
  const d = await db(); await d.exec(forward);
  await d.exec(rollback); await d.exec(rollback);
  await d.query("insert into public.reservas(sede_id,estado) values(2,'pendiente')");
  const {rows} = await d.query('select count(*)::int n from public.reservas');
  assert.equal(rows[0].n, 1);
});
