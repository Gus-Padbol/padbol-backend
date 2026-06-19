import test from 'node:test';
import assert from 'node:assert/strict';
import { mapRankingsLeaderboardPublicRow } from './rankingsLeaderboardPublic.js';

test('public ranking row excludes email and user_id', () => {
  const row = mapRankingsLeaderboardPublicRow(
    { user_id: 'uuid-1', puntos: 120 },
    {
      user_id: 'uuid-1',
      nombre: 'Ana',
      email: 'ana@example.com',
      telefono: '+54911',
      foto_url: 'https://cdn/f.jpg',
      pais: 'AR',
      username: 'ana_padbol',
    },
    0,
    'uuid-1',
  );

  assert.equal(row.posicion, 1);
  assert.equal(row.display_name, 'Ana');
  assert.equal(row.username, 'ana_padbol');
  assert.equal(row.foto_url, 'https://cdn/f.jpg');
  assert.equal(row.pais, 'AR');
  assert.equal(row.puntos, 120);
  assert.equal(row.is_current_user, true);
  assert.equal('email' in row, false);
  assert.equal('user_id' in row, false);
  assert.equal('telefono' in row, false);
});

test('other players are not marked as current user', () => {
  const row = mapRankingsLeaderboardPublicRow(
    { user_id: 'uuid-other', puntos: 50 },
    { nombre: 'Bob', email: 'bob@example.com' },
    2,
    'uuid-me',
  );

  assert.equal(row.posicion, 3);
  assert.equal(row.is_current_user, false);
  assert.equal('email' in row, false);
});
