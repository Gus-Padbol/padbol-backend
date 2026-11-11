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

// Display filtering must not grant or revoke the separate scoped QA access.
test('normal tournament catalogue excludes explicit QA fixtures for every audience', () => {
  for (const audience of [null, { role: { rol: 'jugador' } }, { role: { rol: 'super_admin' } }, { role: { rol: 'admin_club', sede_id: 8 } }]) {
    for (const fecha_fin of [null, '2026-01-01', '2026-11-20']) {
      assert.equal(canReadPublicTournamentCatalogRow({ es_prueba: true, fecha_fin }, audience, now), false);
    }
  }
});

test('normal catalogue does not guess QA from names or alter genuine event visibility', () => {
  for (const es_prueba of [false, null, undefined]) {
    assert.equal(canReadPublicTournamentCatalogRow({ nombre: 'Demo Padbol Pro Cup Completo', es_prueba, fecha_fin: '2026-11-20' }, null, now), true);
    assert.equal(canReadPublicTournamentCatalogRow({ nombre: 'V Padbol Nations Cup', es_prueba, fecha_fin: '2026-11-22' }, null, now), true);
    assert.equal(canReadPublicTournamentCatalogRow({ nombre: 'FIPA historical event', es_prueba, fecha_fin: '2025-01-01' }, { role: { rol: 'super_admin' } }, now), true);
  }
});
