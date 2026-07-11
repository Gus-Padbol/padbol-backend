import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computePorcentajeVictorias,
  mapRankingsLeaderboardPublicRow,
  normalizeRankingsStatsRow,
} from './rankingsLeaderboardPublic.js';

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

test('public ranking row exposes stats and porcentaje_victorias', () => {
  const row = mapRankingsLeaderboardPublicRow(
    {
      user_id: 'uuid-1',
      puntos: 50,
      partidos_jugados: 10,
      ganados: 7,
      perdidos: 2,
      empatados: 1,
      racha_actual: 3,
      mejor_racha: 5,
    },
    { nombre: 'Ana' },
    0,
    null,
  );

  assert.equal(row.partidos_jugados, 10);
  assert.equal(row.ganados, 7);
  assert.equal(row.perdidos, 2);
  assert.equal(row.empatados, 0);
  assert.equal(row.racha_actual, 3);
  assert.equal(row.mejor_racha, 5);
  assert.equal(row.porcentaje_victorias, 70);
});

test('porcentaje_victorias es 0 sin partidos jugados', () => {
  assert.equal(computePorcentajeVictorias(0, 0), 0);
  assert.equal(computePorcentajeVictorias(5, 0), 0);

  const row = mapRankingsLeaderboardPublicRow(
    { user_id: 'uuid-1', puntos: 10 },
    { nombre: 'Ana' },
    0,
    null,
  );
  assert.equal(row.partidos_jugados, 0);
  assert.equal(row.porcentaje_victorias, 0);
});

test('porcentaje_victorias redondea a dos decimales', () => {
  assert.equal(computePorcentajeVictorias(1, 3), 33.33);
  assert.equal(normalizeRankingsStatsRow({}).partidos_jugados, 0);
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
