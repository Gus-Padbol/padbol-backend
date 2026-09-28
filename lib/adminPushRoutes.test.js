import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertSegmentAllowed,
  buildAdminPushData,
  buildAdminPushNavigationData,
  buildAdminInboxNotification,
  buildPushPreferencesRow,
  normalizeAdminPushSegment,
  normalizeAdminPushDestination,
  normalizePushPreferences,
  readAdminPushQuota,
  startOfCurrentWeekIso,
} from '../routes/push.js';

test('super admin has no weekly push quota', async () => {
  const supabaseAdmin = { from: () => { throw new Error('should not query'); } };
  assert.deepEqual(await readAdminPushQuota(supabaseAdmin, {
    role: 'super_admin',
    user: { id: 'super-1' },
  }), {
    limit: null,
    used: null,
    remaining: null,
    unlimited: true,
    unlimitedTargeted: true,
  });
});

test('admin push opens the in-app notification inbox', () => {
  assert.deepEqual(buildAdminPushData('jugador'), {
    type: 'admin_message',
    route: 'Notificaciones',
    segment: 'jugador',
  });
});

test('admin push validates and maps destinations', () => {
  const torneo = normalizeAdminPushDestination({ type: 'torneo', torneoId: '42' });
  assert.deepEqual(torneo, { type: 'torneo', route: 'TorneoDetalle', params: { torneoId: 42 } });
  assert.deepEqual(buildAdminPushNavigationData('jugador', torneo), {
    type: 'admin_message',
    route: 'TorneoDetalle',
    params: { torneoId: 42 },
    segment: 'jugador',
  });
  assert.deepEqual(buildAdminInboxNotification(torneo), {
    tipo: 'torneo',
    data: { torneo_id: 42 },
    link: null,
  });

  const external = normalizeAdminPushDestination({ type: 'external', url: 'https://padbol.com/form' });
  assert.equal(external.route, 'ExternalUrl');
  assert.equal(buildAdminInboxNotification(external).link, 'https://padbol.com/form');
  assert.equal(normalizeAdminPushDestination({ type: 'external', url: 'javascript:alert(1)' }), null);
});

test('push preferences keep safe defaults and expose the mobile contract', () => {
  assert.deepEqual(normalizePushPreferences(null), {
    transactionalEnabled: true,
    marketingEnabled: false,
    updatedAt: null,
  });
  assert.deepEqual(normalizePushPreferences({
    transactional_enabled: false,
    marketing_enabled: true,
    updated_at: '2026-09-27T10:00:00.000Z',
  }), {
    transactionalEnabled: false,
    marketingEnabled: true,
    updatedAt: '2026-09-27T10:00:00.000Z',
  });
});

test('push preference patches preserve the preference not being changed', () => {
  assert.deepEqual(buildPushPreferencesRow({
    transactional_enabled: true,
    marketing_enabled: false,
  }, { marketingEnabled: true }), {
    transactional_enabled: true,
    marketing_enabled: true,
  });
  assert.deepEqual(buildPushPreferencesRow(null, { transactionalEnabled: false }), {
    transactional_enabled: false,
    marketing_enabled: false,
  });
});

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
