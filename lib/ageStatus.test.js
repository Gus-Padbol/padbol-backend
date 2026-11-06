import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {normalizeActivationRows} from './nationsActivation.js';

const forward = fs.readFileSync(new URL('../sql/migrations/20261106210000_nations_age_status.sql', import.meta.url), 'utf8');
const rollback = fs.readFileSync(new URL('../sql/migrations/20261106210000_nations_age_status.rollback.sql', import.meta.url), 'utf8');

async function db(rows = '') {
  const d = new PGlite();
  await d.exec(`create table public.nations_activation_participants(
    participante_id uuid primary key, torneo_id bigint not null, country text not null, row_key text not null,
    minor boolean not null default false, guardian_reviewed_by uuid, guardian_reviewed_at timestamptz);`);
  if (rows) await d.exec(rows);
  return d;
}

test('normalización: sin edad explícita queda desconocido, nunca adulto', () => {
  const [r] = normalizeActivationRows([{rowKey: 'k1', name: 'Jugador de prueba', country: 'XX'}]);
  assert.equal(r.ageStatus, 'desconocido');
  assert.equal(r.minor, false);
});

test('normalización: age_status explícito se respeta', () => {
  const [adulto] = normalizeActivationRows([{rowKey: 'k2', name: 'Jugador adulto', country: 'XX', age_status: 'adulto'}]);
  const [menor] = normalizeActivationRows([{rowKey: 'k3', name: 'Jugador menor', country: 'XX', age_status: 'menor'}]);
  assert.equal(adulto.ageStatus, 'adulto');
  assert.equal(menor.minor, true);
});

test('normalización: valor de edad inválido se rechaza', () => {
  assert.throws(() => normalizeActivationRows([{rowKey: 'k4', name: 'Jugador X', country: 'XX', age_status: 'quizas'}]), /INVALID_ROW|inválid/i);
});

test('backfill honesto: minor=false queda desconocido y minor=true queda menor', async () => {
  const d = await db("insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor) values (gen_random_uuid(),1,'XX','a',false),(gen_random_uuid(),1,'YY','b',true)");
  await d.exec(forward);
  const {rows} = await d.query('select row_key, age_status from public.nations_activation_participants order by row_key');
  assert.deepEqual(rows.map((r) => r.age_status), ['desconocido', 'menor']);
});

test('CHECK impide inconsistencias', async () => {
  const d = await db(); await d.exec(forward);
  await assert.rejects(() => d.query("insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status) values (gen_random_uuid(),1,'XX','c',true,'adulto')"), /age_status_consistente/);
});

test('rollback se niega si hay edad desconocida (no degrada datos)', async () => {
  const d = await db(); await d.exec(forward);
  await d.query("insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status) values (gen_random_uuid(),1,'XX','d',false,'desconocido')");
  await assert.rejects(() => d.exec(rollback), /edad desconocida|aborted/i);
  await d.exec('ROLLBACK;');
  const {rows} = await d.query("select count(*)::int n from information_schema.columns where table_name='nations_activation_participants' and column_name='age_status'");
  assert.equal(rows[0].n, 1);
});

test('rollback funciona cuando solo hay edades resueltas', async () => {
  const d = await db(); await d.exec(forward);
  await d.query("insert into public.nations_activation_participants(participante_id,torneo_id,country,row_key,minor,age_status) values (gen_random_uuid(),1,'XX','e',true,'menor')");
  await d.exec(rollback);
  const {rows} = await d.query("select count(*)::int n from information_schema.columns where table_name='nations_activation_participants' and column_name='age_status'");
  assert.equal(rows[0].n, 0);
});
