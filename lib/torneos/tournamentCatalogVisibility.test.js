import test from 'node:test';
import assert from 'node:assert/strict';
import { canReadPublicTournamentCatalogRow } from './tournamentCatalogVisibility.js';

const now = new Date('2026-10-24T12:00:00.000Z');

test('public tournament catalogue hides expired events but retains current and future events', () => {
  assert.equal(canReadPublicTournamentCatalogRow({ fecha_fin: '2026-10-23' }, null, now), false);
  assert.equal(canReadPublicTournamentCatalogRow({ fecha_fin: '2026-10-24' }, null, now), true);
  assert.equal(canReadPublicTournamentCatalogRow({ fecha_fin: '2026-11-01' }, null, now), true);
  assert.equal(canReadPublicTournamentCatalogRow({ fecha_fin: null }, null, now), true);
});

test('authenticated administrators retain the operational catalogue', () => {
  assert.equal(canReadPublicTournamentCatalogRow({ fecha_fin: '2026-01-01' }, { user: { id: 'admin' } }, now), true);
});
