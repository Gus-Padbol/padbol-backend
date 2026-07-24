import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSegmentAllowed,
  normalizeAdminPushSegment,
  startOfCurrentWeekIso,
} from '../routes/push.js';

test('normalizeAdminPushSegment accepts frontend aliases and normalizes values', () => {
  assert.deepEqual(
    normalizeAdminPushSegment({
      type: ' SEDE ',
      sede_id: '12',
      deporte: ' PADBOL ',
      user_id: 'user-1',
      email: 'PLAYER@EXAMPLE.COM ',
    }),
    {
      type: 'sede',
      pais: null,
      sedeId: '12',
      deporte: 'padbol',
      userId: 'user-1',
      email: 'player@example.com',
    },
  );
});

test('assertSegmentAllowed enforces role scope', () => {
  const superAdmin = { role: 'super_admin' };
  const nationalAdmin = { role: 'admin_nacional' };
  const clubAdmin = { role: 'admin_club' };

  assert.equal(assertSegmentAllowed(superAdmin, { type: 'todos_usuarios' }), null);
  assert.equal(assertSegmentAllowed(nationalAdmin, { type: 'todos_pais' }), null);
  assert.equal(assertSegmentAllowed(clubAdmin, { type: 'sede_mia' }), null);
  assert.match(assertSegmentAllowed(clubAdmin, { type: 'todos_usuarios' }), /alcance/);
  assert.match(assertSegmentAllowed(nationalAdmin, { type: 'deporte' }), /alcance/);
});

test('startOfCurrentWeekIso starts on Monday UTC', () => {
  assert.equal(
    startOfCurrentWeekIso(new Date('2026-07-24T18:35:00.000Z')),
    '2026-07-20T00:00:00.000Z',
  );
  assert.equal(
    startOfCurrentWeekIso(new Date('2026-07-26T23:59:59.000Z')),
    '2026-07-20T00:00:00.000Z',
  );
});
