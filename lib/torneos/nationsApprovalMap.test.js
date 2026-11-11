import test from 'node:test';
import assert from 'node:assert/strict';
import {fetchNationsApprovalMap} from './nationsApprovalMap.js';
import {isNationsPublicRevealed} from './nationsPublicAccess.js';

const fakeDb = (rows) => ({from: () => ({select: () => ({in: async () => ({data: rows, error: null}), then: (r) => r({data: rows, error: null})})})});

test('el mapa sale del activation event, no del plan', async () => {
  const map = await fetchNationsApprovalMap(fakeDb([{torneo_id: 57, roster_publication_approved: true}, {torneo_id: 58, roster_publication_approved: false}]), [57, 58]);
  assert.equal(map.get(57), true); assert.equal(map.get(58), false);
});

test('sin aprobacion, un Nations con fecha pasada sigue oculto', () => {
  const torneo = {id: 1, modalidad_plantel: 'selecciones', fecha_inicio: '2020-01-01', horas_revelar_equipos: 48};
  assert.equal(isNationsPublicRevealed(torneo, new Date('2026-01-01T00:00:00Z'), false), false);
});

test('aprobado + fecha pasada revela; torneo normal no se toca', () => {
  const nations = {id: 1, modalidad_plantel: 'selecciones', plan_nations: {config: {timezone: 'Europe/Rome', reveal_at: '2020-01-01T00:00:00Z'}}, fecha_inicio: '2020-01-01', horas_revelar_equipos: 48};
  assert.equal(isNationsPublicRevealed(nations, new Date('2026-01-01T00:00:00Z'), true), true);
  const normal = {id: 2, modalidad_plantel: 'dobles', plan_nations: null};
  assert.equal(isNationsPublicRevealed(normal, new Date('2026-01-01T00:00:00Z'), false), true);
});
