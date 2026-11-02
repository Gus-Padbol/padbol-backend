import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {PGlite} from '/Users/padbol2022/PADBOL-LAB-DEEPSEEK/padbol-backend-canonical/node_modules/@electric-sql/pglite/dist/index.js';
import {createWebPushService, buildLeadNotification} from './webPushNotifications.js';

const migration = await fs.readFile(new URL('../sql/candidates/20261102200000_web_push_subscriptions.sql', import.meta.url), 'utf8');
const USER = '11111111-1111-4111-8111-111111111111';
const SUB = { endpoint: 'https://push.example.invalid/abc', keys: { p256dh: 'pk', auth: 'au' } };

async function db() {
  const pg = new PGlite();
  await pg.exec('create role anon; create role authenticated; create role service_role;');
  await pg.exec(migration);
  return { pg, pool: { query: (...a) => pg.query(...a) } };
}

test('registra, actualiza y revoca una suscripcion', async () => {
  const { pg, pool } = await db();
  const svc = createWebPushService({ pool });
  const a = await svc.subscribe({ userId: USER, subscription: SUB, userAgent: 'iPhone' });
  assert.ok(a.id);
  await svc.subscribe({ userId: USER, subscription: SUB });
  assert.equal((await pg.query('select count(*)::int n from public.push_web_subscriptions')).rows[0].n, 1);
  await svc.unsubscribe({ userId: USER, endpoint: SUB.endpoint });
  assert.equal((await pg.query('select count(*)::int n from public.push_web_subscriptions where revoked_at is not null')).rows[0].n, 1);
});

test('rechaza suscripciones invalidas', async () => {
  const { pool } = await db();
  const svc = createWebPushService({ pool });
  await assert.rejects(svc.subscribe({ userId: USER, subscription: { endpoint: 'http://inseguro', keys: { p256dh: 'a', auth: 'b' } } }), (e) => e.status === 400);
  await assert.rejects(svc.subscribe({ userId: USER, subscription: { endpoint: 'https://ok', keys: {} } }), (e) => e.status === 400);
});

test('envia a todos los dispositivos del usuario y revoca los caidos', async () => {
  const { pg, pool } = await db();
  const sent = [];
  let fail = false;
  const svc = createWebPushService({
    pool,
    send: async ({ payload }) => { if (fail) throw Object.assign(new Error('gone'), { statusCode: 410 }); sent.push(payload); },
  });
  await svc.subscribe({ userId: USER, subscription: SUB });
  await svc.subscribe({ userId: USER, subscription: { endpoint: 'https://push.example.invalid/def', keys: { p256dh: 'p2', auth: 'a2' } } });
  const ok = await svc.notify({ userId: USER, payload: { title: 'x' } });
  assert.equal(ok.sent, 2);
  fail = true;
  const gone = await svc.notify({ userId: USER, payload: { title: 'y' } });
  assert.equal(gone.sent, 0);
  assert.equal((await pg.query('select count(*)::int n from public.push_web_subscriptions where revoked_at is not null')).rows[0].n, 2);
});

test('los textos incluyen nombre, pais, origen y enlace', () => {
  const n = buildLeadNotification({ name: 'Juan Pérez', country: 'Italia', origin: 'formulario web', caseUrl: '/admin/crm/caso/9' });
  assert.match(n.title, /NUEVO LEAD/);
  assert.match(n.body, /Juan Pérez/);
  assert.match(n.body, /Italia/);
  assert.match(n.body, /formulario web/);
  assert.equal(n.url, '/admin/crm/caso/9');
  const r = buildLeadNotification({ name: 'Ana', country: 'Chile', kind: 'reminder', caseUrl: '/c/1' });
  assert.match(r.title, /RECORDATORIO/);
  const c = buildLeadNotification({ name: 'Ana', kind: 'critical', caseUrl: '/c/1' });
  assert.match(c.title, /CRÍTICA/);
});
