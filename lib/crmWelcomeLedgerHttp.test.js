// HTTP contract tests for the server-only welcome ledger adapters.
// Real HTTP (ephemeral port) + real SQL on in-memory PGlite. No provider, no mail,
// no external network, no env file, no secrets committed.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { PGlite } from '@electric-sql/pglite';
import { registerCrmInboundRoutes } from './crmInboundRoutes.js';

const here = dirname(fileURLToPath(import.meta.url));
const SECRET = 'synthetic-ledger-secret-not-real';
const FORM_SECRET = 'synthetic-form-secret-not-real';
const CONTACT = '11111111-1111-4111-8111-111111111111';
const CONTACT_2 = '22222222-2222-4222-8222-222222222222';

async function boot() {
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.crm_contacts(id uuid primary key, created_at timestamptz default '2026-11-10T00:00:00Z');
    insert into public.crm_contacts(id) values ('${CONTACT}'),('${CONTACT_2}');
  `);
  await db.exec(await readFile(join(here, '../sql/migrations/20261111200000_crm_welcome_ledger.sql'), 'utf8'));

  let queries = 0;
  const pool = { query: (sql, params) => { queries += 1; return db.query(sql, params); } };
  const contacts = [];
  const crmService = {
    async ingestInbound(ingest) {
      // Real persist of the authoritative contact identity, as ingestInbound does.
      const id = randomUUID();
      await db.query('insert into public.crm_contacts(id) values($1)', [id]);
      contacts.push(id);
      return { status: 'accepted', contact: { id }, conversation: { id: randomUUID() } };
    },
  };

  const app = express();
  app.use(express.json({ limit: '1mb' }));
  registerCrmInboundRoutes(app, {
    crmService,
    pool,
    emailInboundSecret: FORM_SECRET,
    formInboundSecret: FORM_SECRET,
    experienceRepository: { createActivity: async () => {} },
    logger: { warn() {}, error() {} },
  });
  const server = await new Promise(resolve => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  return { db, pool, contacts, base, queries: () => queries, close: async () => { await new Promise(r => server.close(r)); await db.close(); } };
}

const post = (base, path, body, token) => fetch(base + path, {
  method: 'POST',
  headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
  body: JSON.stringify(body),
});

function withEnv(enabled, secret, fn) {
  const before = { e: process.env.CRM_WELCOME_LEDGER_ENABLED, s: process.env.CRM_WELCOME_LEDGER_SECRET, a: process.env.CRM_WELCOME_LEDGER_ACTIVATION_AT };
  process.env.CRM_WELCOME_LEDGER_ACTIVATION_AT = '2026-11-01T00:00:00Z';
  if (enabled === undefined) delete process.env.CRM_WELCOME_LEDGER_ENABLED; else process.env.CRM_WELCOME_LEDGER_ENABLED = enabled;
  if (secret === undefined) delete process.env.CRM_WELCOME_LEDGER_SECRET; else process.env.CRM_WELCOME_LEDGER_SECRET = secret;
  const restore = () => {
    if (before.a === undefined) delete process.env.CRM_WELCOME_LEDGER_ACTIVATION_AT; else process.env.CRM_WELCOME_LEDGER_ACTIVATION_AT = before.a;
    if (before.e === undefined) delete process.env.CRM_WELCOME_LEDGER_ENABLED; else process.env.CRM_WELCOME_LEDGER_ENABLED = before.e;
    if (before.s === undefined) delete process.env.CRM_WELCOME_LEDGER_SECRET; else process.env.CRM_WELCOME_LEDGER_SECRET = before.s;
  };
  return Promise.resolve().then(fn).finally(restore);
}

test('default OFF: 503 WELCOME_LEDGER_DISABLED with zero database queries', async () => {
  const f = await boot();
  try {
    await withEnv(undefined, SECRET, async () => {
      const r = await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'welcome' }, SECRET);
      assert.equal(r.status, 503);
      assert.equal((await r.json()).code, 'WELCOME_LEDGER_DISABLED');
      assert.equal(f.queries(), 0, 'OFF must not touch the ledger');
    });
  } finally { await f.close(); }
});

test('wrong or missing server secret is rejected before any ledger work', async () => {
  const f = await boot();
  try {
    await withEnv('true', SECRET, async () => {
      const bad = await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'welcome' }, 'wrong-secret');
      assert.equal(bad.status, 401);
      assert.equal((await bad.json()).code, 'WELCOME_LEDGER_UNAUTHENTICATED');
      const none = await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'welcome' });
      assert.equal(none.status, 401);
      assert.equal(f.queries(), 0);
    });
  } finally { await f.close(); }
});

test('claim returns opaque receipt, and a second claim cannot re-acquire', async () => {
  const f = await boot();
  try {
    await withEnv('true', SECRET, async () => {
      const first = await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'welcome' }, SECRET);
      assert.equal(first.status, 201);
      const a = await first.json();
      assert.equal(a.status, 'claimed');
      assert.equal(a.acquired, true);
      assert.match(a.contactRef, /^w_[A-Za-z0-9_-]+$/);
      assert.equal(a.purpose, 'welcome');
      assert.equal(JSON.stringify(a).includes(CONTACT), false, 'no raw contact uuid in response');
      assert.equal('contactId' in a, false);

      const second = await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'welcome' }, SECRET);
      assert.equal(second.status, 200);
      const b = await second.json();
      assert.equal(b.acquired, false);
      assert.equal(b.status, 'claimed');
    });
  } finally { await f.close(); }
});

test('concurrent claims on the same contact acquire exactly once', async () => {
  const f = await boot();
  try {
    await withEnv('true', SECRET, async () => {
      const results = await Promise.all([1, 2, 3, 4].map(() =>
        post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'welcome' }, SECRET).then(r => r.json())));
      assert.equal(results.filter(r => r.acquired === true).length, 1);
      assert.equal((await f.db.query('select count(*)::int n from public.crm_welcome_ledger')).rows[0].n, 1);
    });
  } finally { await f.close(); }
});

test('complete transitions from claimed and rejects a second completion', async () => {
  const f = await boot();
  try {
    await withEnv('true', SECRET, async () => {
      await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'welcome' }, SECRET);
      const ok = await post(f.base, '/api/internal/crm/welcome/complete', { contactId: CONTACT, purpose: 'welcome', status: 'accepted', receipt: {id: 'wamid.synthetic'} }, SECRET);
      assert.equal(ok.status, 200);
      assert.equal((await ok.json()).status, 'accepted');
      assert.equal((await f.db.query('select status, provider_message_id from public.crm_welcome_ledger')).rows[0].status, 'accepted');

      const again = await post(f.base, '/api/internal/crm/welcome/complete', { contactId: CONTACT, purpose: 'welcome', status: 'uncertain' }, SECRET);
      assert.equal(again.status, 409);
      assert.equal((await again.json()).code, 'WELCOME_NOT_CLAIMED');
    });
  } finally { await f.close(); }
});

test('complete without a prior claim is 409; accepted requires a provider receipt', async () => {
  const f = await boot();
  try {
    await withEnv('true', SECRET, async () => {
      const none = await post(f.base, '/api/internal/crm/welcome/complete', { contactId: CONTACT, purpose: 'welcome', status: 'accepted', receipt: {id: 'wamid.x'} }, SECRET);
      assert.equal(none.status, 409);
      assert.equal((await none.json()).code, 'WELCOME_NOT_CLAIMED');

      await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'welcome' }, SECRET);
      const missing = await post(f.base, '/api/internal/crm/welcome/complete', { contactId: CONTACT, purpose: 'welcome', status: 'accepted' }, SECRET);
      assert.equal(missing.status, 400);
      assert.equal((await missing.json()).code, 'WELCOME_PROVIDER_ID_REQUIRED');
    });
  } finally { await f.close(); }
});

test('uncertain and rejected are terminal: elapsed time never re-acquires', async () => {
  const f = await boot();
  try {
    await withEnv('true', SECRET, async () => {
      await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'welcome' }, SECRET);
      await post(f.base, '/api/internal/crm/welcome/complete', { contactId: CONTACT, purpose: 'welcome', status: 'uncertain' }, SECRET);
      // Simulate 25h elapsed and a cold process restart: the durable row is what matters.
      await f.db.query("update public.crm_welcome_ledger set claimed_at=now()-interval '25 hours', updated_at=now()-interval '25 hours'");
      const retry = await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'welcome' }, SECRET);
      const body = await retry.json();
      assert.equal(body.acquired, false);
      assert.equal(body.status, 'uncertain');

      await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT_2, purpose: 'welcome' }, SECRET);
      await post(f.base, '/api/internal/crm/welcome/complete', { contactId: CONTACT_2, purpose: 'welcome', status: 'rejected', rejectionCode: 'INVALID_RECIPIENT' }, SECRET);
      const rejected = await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT_2, purpose: 'welcome' }, SECRET);
      const rb = await rejected.json();
      assert.equal(rb.acquired, false);
      assert.equal(rb.status, 'rejected');
      assert.equal((await f.db.query('select count(*)::int n from public.crm_welcome_ledger')).rows[0].n, 2);
    });
  } finally { await f.close(); }
});

test('form intake returns an opaque welcome receipt derived from the persisted contact id', async () => {
  const f = await boot();
  try {
    await withEnv('true', SECRET, async () => {
      const r = await post(f.base, '/api/inbound/crm/form', {
        id: randomUUID(), form: 'Consulta Padbol · Quiero una cancha Padbol',
        name: 'Synthetic Contact', email: 'synthetic.form@example.invalid', phone: '5491100000001',
      }, FORM_SECRET);
      assert.equal(r.status, 201);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.equal(typeof body.conversationId, 'string', 'existing contract preserved');
      assert.ok(body.welcome, 'server-only receipt present');
      assert.match(body.welcome.contactRef, /^w_[A-Za-z0-9_-]+$/);
      assert.equal(body.welcome.purpose, 'welcome');
      assert.equal(JSON.stringify(body.welcome).includes('@'), false, 'receipt carries no email');
      assert.equal('contactId' in body.welcome, false, 'receipt carries no raw contact id');
      assert.equal(f.contacts.length, 1);
      assert.equal(body.contact.id, f.contacts[0], 'authoritative persisted contact identity for server-only c82 caller');
    });
  } finally { await f.close(); }
});

test('form intake omits the receipt while the ledger stays OFF and preserves its response', async () => {
  const f = await boot();
  try {
    await withEnv(undefined, undefined, async () => {
      const r = await post(f.base, '/api/inbound/crm/form', {
        id: randomUUID(), form: 'Consulta Padbol · Quiero una cancha Padbol',
        name: 'Synthetic Contact', email: 'synthetic.off@example.invalid', phone: '5491100000002',
      }, FORM_SECRET);
      assert.equal(r.status, 201);
      const body = await r.json();
      assert.equal(body.ok, true);
      assert.equal('welcome' in body, false);
      assert.equal((await f.db.query('select count(*)::int n from public.crm_welcome_ledger')).rows[0].n, 0);
    });
  } finally { await f.close(); }
});

test('invalid purpose or state never touches the ledger', async () => {
  const f = await boot();
  try {
    await withEnv('true', SECRET, async () => {
      const p = await post(f.base, '/api/internal/crm/welcome/claim', { contactId: CONTACT, purpose: 'ack' }, SECRET);
      assert.equal(p.status, 400);
      assert.equal((await p.json()).code, 'WELCOME_PURPOSE_INVALID');
      const before = f.queries();
      const s = await post(f.base, '/api/internal/crm/welcome/complete', { contactId: CONTACT, purpose: 'welcome', status: 'sent' }, SECRET);
      assert.equal(s.status, 400);
      assert.equal((await s.json()).code, 'WELCOME_STATE_INVALID');
      assert.equal(f.queries(), before, 'invalid input performs no ledger query');
    });
  } finally { await f.close(); }
});

test('HTTP claim rejects historical contact despite new client/source timestamps; fresh contact admitted once', async () => {
  const f=await boot();
  try {
    await withEnv('true',SECRET,async()=>{
      process.env.CRM_WELCOME_LEDGER_ACTIVATION_AT='2026-11-12T10:00:00Z';
      await f.db.query('update public.crm_contacts set created_at=$2 where id=$1',[CONTACT_2,'2026-11-12T10:00:00Z']);
      const old=await post(f.base,'/api/internal/crm/welcome/claim',{contactId:CONTACT,purpose:'welcome',sourceId:'new-submission',createdAt:'2099-01-01T00:00:00Z',conversationCreatedAt:'2099-01-01T00:00:00Z'},SECRET);
      assert.equal(old.status,200);const blocked=await old.json();assert.equal(blocked.status,'rejected');assert.equal(blocked.acquired,false);
      assert.equal((await f.db.query('select count(*)::int n from public.crm_welcome_ledger')).rows[0].n,0);
      const fresh=await post(f.base,'/api/internal/crm/welcome/claim',{contactId:CONTACT_2,purpose:'welcome'},SECRET);
      assert.equal(fresh.status,201);assert.equal((await fresh.json()).acquired,true);
      await post(f.base,'/api/internal/crm/welcome/complete',{contactId:CONTACT_2,purpose:'welcome',status:'accepted',receipt:{id:'email.once'}},SECRET);
      delete process.env.CRM_WELCOME_LEDGER_ACTIVATION_AT;
      const again=await post(f.base,'/api/internal/crm/welcome/claim',{contactId:CONTACT_2,purpose:'welcome',sourceId:'second-submission',language:'en'},SECRET);
      const receipt=await again.json();assert.equal(receipt.status,'accepted');assert.equal(receipt.acquired,false);assert.equal(receipt.receipt.id,'email.once');
    });
  } finally {await f.close();}
});

test('HTTP enabled without activation date cannot acquire a new contact', async () => {
  const f=await boot();
  try {
    await withEnv('true',SECRET,async()=>{
      delete process.env.CRM_WELCOME_LEDGER_ACTIVATION_AT;
      const r=await post(f.base,'/api/internal/crm/welcome/claim',{contactId:CONTACT,purpose:'welcome'},SECRET);
      assert.equal(r.status,200);const body=await r.json();assert.equal(body.status,'rejected');assert.equal(body.acquired,false);
      assert.equal((await f.db.query('select count(*)::int n from public.crm_welcome_ledger')).rows[0].n,0);
    });
  } finally {await f.close();}
});
