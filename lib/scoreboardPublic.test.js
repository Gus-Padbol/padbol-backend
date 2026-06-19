import test from 'node:test';
import assert from 'node:assert/strict';
import { mapScoreboardJugadorTempPublicRow } from './scoreboardPublic.js';

test('scoreboard temp player public row excludes user_id', () => {
  const row = mapScoreboardJugadorTempPublicRow({
    id: 1,
    partido_id: 'p1',
    equipo: 'a',
    slot: 2,
    nombre: 'Juan',
    numero: 7,
    foto_url: 'https://cdn/f.jpg',
    user_id: 'secret-uuid',
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
  });

  assert.equal(row.nombre, 'Juan');
  assert.equal(row.numero, 7);
  assert.equal(row.equipo, 'a');
  assert.equal('user_id' in row, false);
});
