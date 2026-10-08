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

test('send-admin resolves default inbox destination before delivery', async () => {
  const { mountPushRoutes } = await import('../routes/push.js');
  const { default: express } = await import('express');
  const app = express();
  app.use(express.json());
  const writes = [];
  const supabaseAdmin = {
    from(table) {
      if (table === 'admin_push_notifications') return { insert: async (row) => { writes.push(row); return { error: null }; } };
      if (table === 'jugadores_perfil') return {
        select() { return this; }, not() { return this; }, limit() { return Promise.resolve({ data: [], error: null }); },
      };
      throw new Error(`unexpected table ${table}`);
    },
  };
  mountPushRoutes(app, {
    supabaseAdmin,
    getAuthenticatedUser: async () => ({ user: { id: 'super-1', email: 'admin@example.test' } }),
    fetchUserRoleRowForAuthUser: async () => ({ role: 'super_admin' }),
  });
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const invalid = await fetch(`${base}/api/push/send-admin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Title', body: 'Message', segment: { type: 'todos_usuarios' }, destination: { type: 'external', url: 'javascript:alert(1)' } }) });
    assert.equal(invalid.status, 400);
    assert.equal(writes.length, 0);
    const response = await fetch(`${base}/api/push/send-admin`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ title: 'Title', body: 'Message', segment: { type: 'todos_usuarios' } }) });
    assert.equal(response.status, 200);
    assert.equal(writes.length, 1);
  } finally { await new Promise((resolve) => server.close(resolve)); }
});
