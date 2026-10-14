import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readPublicReservationOccupancy } from './reservasDisponibilidadPublica.js';

function client({ venues = [{ id: 13, nombre: 'QA' }], rows = [], failure = null } = {}) {
  const calls = [];
  return { calls, from(table) {
    const filters = [];
    const query = {
      select(value) { calls.push({ table, select: value, filters }); return this; },
      eq(key, value) { filters.push([key, value]); return this; },
      is(key, value) { filters.push([key, value]); return this; },
      limit() { return this; },
      then(resolve, reject) {
        return Promise.resolve(table === 'sedes' ? { data: venues } : failure ? { error: failure } : {
          data: rows.filter(row => filters.every(([key, value]) => row[key] === value)),
        }).then(resolve, reject);
      },
    };
    return query;
  } };
}

test('public occupancy includes blocked reservations across users but strips personal/payment data', async () => {
  const db = client({ rows: [{ id: 1, sede_id: 13, sede: 'QA', fecha: '2026-11-20', hora: '17:00:00', estado: 'confirmada', user_id: 'private', email: 'private', precio: 30000 }] });
  const result = await readPublicReservationOccupancy(db, { sede: 'QA', sedeId: 13, fecha: '2026-11-20' });
  assert.equal(result.length, 1);
  assert.equal(result[0].hora, '17:00:00');
  for (const key of ['user_id', 'email', 'precio', 'fecha']) assert.equal(Object.hasOwn(result[0], key), false);
});

test('canonical ID excludes a different venue with the same name and includes unassigned legacy rows', async () => {
  const db = client({ rows: [
    { id: 1, sede_id: 13, sede: 'QA', fecha: '2026-11-20', estado: 'confirmada' },
    { id: 2, sede_id: 99, sede: 'QA', fecha: '2026-11-20', estado: 'confirmada' },
    { id: 3, sede_id: null, sede: 'QA', fecha: '2026-11-20', estado: 'confirmada' },
    { id: 4, sede_id: 13, sede: 'QA', fecha: '2026-11-20', estado: 'cancelada' },
  ] });
  assert.deepEqual((await readPublicReservationOccupancy(db, { sedeId: 13, fecha: '2026-11-20' })).map(row => row.id), [1, 3]);
});

test('ambiguous names and database errors cannot appear as free courts', async () => {
  await assert.rejects(readPublicReservationOccupancy(client({ venues: [{ id: 1 }, { id: 2 }] }), { sede: 'QA', fecha: '2026-11-20' }), { status: 400 });
  const error = new Error('unavailable');
  await assert.rejects(readPublicReservationOccupancy(client({ failure: error }), { sedeId: 13, fecha: '2026-11-20' }), error);
  await assert.rejects(readPublicReservationOccupancy(client(), { sedeId: 13, fecha: 'bad' }), { status: 400 });
});
