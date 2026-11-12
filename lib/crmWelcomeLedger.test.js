// Contract tests for the bounded CRM welcome ledger (contract 20261111 §5).
// Real SQL semantics on an in-memory PGlite database; fake provider only.
// No network, no real pool, no send, no env file, no secrets.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCrmWelcomeLedger as createLedger, welcomeReceipt } from './crmWelcomeLedger.js';

const here = dirname(fileURLToPath(import.meta.url));

const ACTIVATION = '2026-11-01T00:00:00Z';
const createCrmWelcomeLedger = options => createLedger({ activationAt: ACTIVATION, ...options });

const CONTACT = '11111111-1111-4111-8111-111111111111';
const CONTACT_2 = '22222222-2222-4222-8222-222222222222';

async function fresh() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = new PGlite();
  await db.exec(`
    create role anon; create role authenticated; create role service_role;
    create table public.crm_contacts(id uuid primary key, created_at timestamptz default '2026-11-10T00:00:00Z');
    insert into public.crm_contacts(id) values ('${CONTACT}'),('${CONTACT_2}');
  `);
  await db.exec(await readFile(join(here, '../sql/migrations/20261111200000_crm_welcome_ledger.sql'), 'utf8'));
  const pool = { query: (sql, params) => db.query(sql, params) };
  return { db, pool, close: () => db.close() };
}

// Sender facade: claim -> provider only when claimed (the production ordering).
function sender(ledger, counter, enabled = true) {
  return async ({ contactId, sourceId, conversationId, providerKey }) => {
    const claim = await ledger.claim({ contactId, providerKey, enabled });
    if (!claim.claimed) return { sent: false, status: claim.status, sourceId, conversationId };
    counter.calls += 1;
    const providerMessageId = `wamid.${sourceId}`;
    await ledger.markAccepted({ attemptId: claim.attemptId, providerMessageId });
    return { sent: true, status: 'accepted', sourceId, conversationId, contactId: claim.receipt.contactId };
  };
}

test('same contact across different sourceIds and conversations yields at most one welcome', async () => {
  const { db, pool, close } = await fresh();
  try {
    const ledger = createCrmWelcomeLedger({ pool });
    const counter = { calls: 0 };
    const send = sender(ledger, counter);
    const results = [
      await send({ contactId: CONTACT, sourceId: 'imap:aaa', conversationId: 'conv-1', providerKey: 'welcome:imap:aaa' }),
      await send({ contactId: CONTACT, sourceId: 'imap:bbb', conversationId: 'conv-2', providerKey: 'welcome:imap:bbb' }),
      await send({ contactId: CONTACT, sourceId: 'form:ccc', conversationId: 'conv-3', providerKey: 'welcome:form:ccc' }),
    ];
    assert.equal(counter.calls, 1, 'provider called exactly once');
    assert.deepEqual(results.map(r => r.sent), [true, false, false]);
    assert.equal((await db.query('select count(*)::int n from public.crm_welcome_ledger')).rows[0].n, 1);
    assert.equal((await ledger.read(CONTACT)).status, 'accepted');
  } finally { await close(); }
});

test('concurrent claims on the same contact admit exactly one attempt', async () => {
  const { db, pool, close } = await fresh();
  try {
    const ledger = createCrmWelcomeLedger({ pool });
    const attempts = await Promise.all(
      ['k1', 'k2', 'k3', 'k4'].map(k => ledger.claim({ contactId: CONTACT, providerKey: `welcome:${k}`, enabled: true })),
    );
    assert.equal(attempts.filter(a => a.claimed).length, 1, 'exactly one claim wins');
    assert.equal((await db.query('select count(*)::int n from public.crm_welcome_ledger')).rows[0].n, 1);
  } finally { await close(); }
});

test('cold restart sees the existing claim and never re-sends', async () => {
  const { db, pool, close } = await fresh();
  try {
    const counter = { calls: 0 };
    const before = createCrmWelcomeLedger({ pool });
    await sender(before, counter)({ contactId: CONTACT, sourceId: 'imap:first', conversationId: 'c1', providerKey: 'welcome:first' });

    // Cold restart: brand-new ledger instance, same durable database.
    const after = createCrmWelcomeLedger({ pool });
    const restarted = await sender(after, counter)({ contactId: CONTACT, sourceId: 'imap:after-restart', conversationId: 'c2', providerKey: 'welcome:after' });
    assert.equal(restarted.sent, false);
    assert.equal(restarted.status, 'accepted');
    assert.equal(counter.calls, 1);
  } finally { await close(); }
});

test('elapsed 25h (provider dedup window expired) still cannot re-send', async () => {
  const { db, pool, close } = await fresh();
  try {
    const t0 = Date.parse('2026-11-11T00:00:00Z');
    const counter = { calls: 0 };
    const first = createCrmWelcomeLedger({ pool, now: () => t0 });
    await sender(first, counter)({ contactId: CONTACT, sourceId: 'imap:t0', conversationId: 'c1', providerKey: 'welcome:t0' });
    await first.markAccepted({ attemptId: (await first.read(CONTACT)).attempt_id, providerMessageId: 'wamid.t0' });

    const later = createCrmWelcomeLedger({ pool, now: () => t0 + 25 * 3600 * 1000 });
    const retry = await sender(later, counter)({ contactId: CONTACT, sourceId: 'imap:t25', conversationId: 'c2', providerKey: 'welcome:t25' });
    assert.equal(retry.sent, false);
    assert.equal(counter.calls, 1);
    assert.equal((await db.query('select count(*)::int n from public.crm_welcome_ledger')).rows[0].n, 1);
  } finally { await close(); }
});

test('network accepted but response lost stays suppressed as uncertain and is not retried', async () => {
  const { db, pool, close } = await fresh();
  try {
    const ledger = createCrmWelcomeLedger({ pool });
    const claim = await ledger.claim({ contactId: CONTACT, providerKey: 'welcome:lost', enabled: true });
    assert.equal(claim.claimed, true);
    // Provider accepted but the ack never reached us.
    await ledger.markUncertain({ attemptId: claim.attemptId });
    assert.equal((await ledger.read(CONTACT)).status, 'uncertain');

    const counter = { calls: 0 };
    const retry = await sender(ledger, counter)({ contactId: CONTACT, sourceId: 'imap:retry', conversationId: 'c9', providerKey: 'welcome:retry' });
    assert.equal(retry.sent, false);
    assert.equal(counter.calls, 0, 'no blind retry after loss');
  } finally { await close(); }
});

test('receipt write failure leaves the claim in place (blocks any second send)', async () => {
  const { db, pool, close } = await fresh();
  try {
    const failing = {
      query: async (sql, params) => {
        if (/provider_message_id=\$4/.test(sql) && params?.[1] === 'accepted') {
          throw Object.assign(new Error('receipt write failed'), { code: 'RECEIPT_WRITE_FAILED' });
        }
        return pool.query(sql, params);
      },
    };
    const ledger = createCrmWelcomeLedger({ pool: failing, logger: { error() {} } });
    const claim = await ledger.claim({ contactId: CONTACT, providerKey: 'welcome:receipt', enabled: true });
    assert.equal(claim.claimed, true);
    await assert.rejects(ledger.markAccepted({ attemptId: claim.attemptId, providerMessageId: 'wamid.x' }), /receipt write failed/);

    const healthy = createCrmWelcomeLedger({ pool });
    const row = await healthy.read(CONTACT);
    assert.equal(row.status, 'claimed', 'claim survives a failed receipt write');
    const counter = { calls: 0 };
    const second = await sender(healthy, counter)({ contactId: CONTACT, sourceId: 'imap:again', conversationId: 'c2', providerKey: 'welcome:again' });
    assert.equal(second.sent, false);
    assert.equal(counter.calls, 0);
  } finally { await close(); }
});

test('no provider call can happen without a claim (disabled OFF gate is evaluated first)', async () => {
  const { db, pool, close } = await fresh();
  try {
    let queries = 0;
    const counted = { query: (sql, params) => { queries += 1; return pool.query(sql, params); } };
    const ledger = createCrmWelcomeLedger({ pool: counted });
    const counter = { calls: 0 };
    const off = await sender(ledger, counter, false)({ contactId: CONTACT, sourceId: 'imap:off', conversationId: 'c1', providerKey: 'welcome:off' });
    assert.equal(off.sent, false);
    assert.equal(off.status, 'disabled');
    assert.equal(counter.calls, 0);
    assert.equal(queries, 0, 'OFF performs zero ledger/provider work');
    assert.equal((await db.query('select count(*)::int n from public.crm_welcome_ledger')).rows[0].n, 0);
  } finally { await close(); }
});

test('definitive rejection is terminal (no identity rotation) and purpose cannot collide', async () => {
  const { db, pool, close } = await fresh();
  try {
    const ledger = createCrmWelcomeLedger({ pool });
    const claim = await ledger.claim({ contactId: CONTACT, providerKey: 'welcome:reject', enabled: true });
    await ledger.markRejected({ attemptId: claim.attemptId, code: 'INVALID_RECIPIENT' });
    assert.equal((await ledger.read(CONTACT)).status, 'rejected');
    const again = await ledger.claim({ contactId: CONTACT, providerKey: 'welcome:reject2', enabled: true });
    assert.equal(again.claimed, false);
    assert.equal(again.status, 'rejected');

    // Different contact is independent.
    const other = await ledger.claim({ contactId: CONTACT_2, providerKey: 'welcome:other', enabled: true });
    assert.equal(other.claimed, true);
  } finally { await close(); }
});

test('ledger stores no raw recipient, email, body or token columns', async () => {
  const { db, close } = await fresh();
  try {
    const { rows } = await db.query(
      `select column_name from information_schema.columns where table_schema='public' and table_name='crm_welcome_ledger'`,
    );
    const names = rows.map(r => r.column_name);
    for (const forbidden of ['email', 'recipient', 'recipient_wa_id', 'body', 'token', 'access_token', 'conversation_id', 'source_id']) {
      assert.equal(names.includes(forbidden), false, `no ${forbidden} column`);
    }
    for (const required of ['attempt_id', 'contact_id', 'purpose', 'status', 'provider_key', 'claimed_at', 'provider_message_id']) {
      assert.equal(names.includes(required), true, `has ${required}`);
    }
  } finally { await close(); }
});

test('welcomeReceipt exposes an opaque contact identity without PII', () => {
  const receipt = welcomeReceipt(CONTACT, { salt: 'test-salt', attemptId: randomUUID() });
  assert.equal(receipt.contactId, CONTACT);
  assert.equal(receipt.purpose, 'welcome');
  assert.match(receipt.contactRef, /^w_[A-Za-z0-9_-]{1,32}$/);
  assert.equal(JSON.stringify(receipt).includes('@'), false, 'receipt contains no email');
});


test('opaque log reference incorporates full contact identity and salt instead of reversible UUID prefix', () => {
 const first=welcomeReceipt(CONTACT,{salt:'fixture-salt-a'}).contactRef;
 const samePrefix='11111111-1111-4111-8111-111111111112';
 assert.notEqual(first,welcomeReceipt(samePrefix,{salt:'fixture-salt-a'}).contactRef);
 assert.notEqual(first,welcomeReceipt(CONTACT,{salt:'fixture-salt-b'}).contactRef);
 assert.equal(first,welcomeReceipt(CONTACT,{salt:'fixture-salt-a'}).contactRef);
});

test('activation uses authoritative contact creation: old, missing, null, future and new boundary', async () => {
  const {db,pool,close}=await fresh();
  try {
    const now='2026-11-12T12:00:00Z',cutoff='2026-11-12T10:00:00Z';
    const ledger=createCrmWelcomeLedger({pool,now:()=>now,activationAt:cutoff});
    for (const createdAt of ['2026-11-12T09:59:59.999Z',null,'2026-11-12T12:00:00.001Z']) {
      await db.query('update public.crm_contacts set created_at=$2 where id=$1',[CONTACT,createdAt]);
      const result=await ledger.claim({contactId:CONTACT,providerKey:'welcome:blocked',enabled:true,createdAt:now,conversationCreatedAt:now});
      assert.equal(result.claimed,false);assert.equal(result.status,'rejected');
      assert.equal((await ledger.read(CONTACT)),null,'historical or invalid contact does not reserve/send');
    }
    const absent=await ledger.claim({contactId:'33333333-3333-4333-8333-333333333333',providerKey:'welcome:absent',enabled:true});
    assert.equal(absent.status,'rejected');assert.equal(absent.claimed,false);
    await db.query('update public.crm_contacts set created_at=$2 where id=$1',[CONTACT,cutoff]);
    assert.equal((await ledger.claim({contactId:CONTACT,providerKey:'welcome:boundary',enabled:true})).claimed,true,'equal cutoff is eligible');
    await db.query('update public.crm_contacts set created_at=$2 where id=$1',[CONTACT_2,'2026-11-12T10:00:00.001Z']);
    assert.equal((await ledger.claim({contactId:CONTACT_2,providerKey:'welcome:after',enabled:true})).claimed,true,'new contact after cutoff is eligible');
  } finally {await close();}
});

test('missing or invalid activation cutoff fails closed; completed receipts survive cutoff changes', async () => {
  const {db,pool,close}=await fresh();
  try {
    for(const activationAt of [undefined,'','not-a-date','2026-11-12','2026-99-99T00:00:00Z','2026-02-30T00:00:00Z','2026-11-12T24:00:00Z']) {
      const ledger=createCrmWelcomeLedger({pool,activationAt:()=>activationAt});
      const result=await ledger.claim({contactId:CONTACT,providerKey:'welcome:noconfig',enabled:true});
      assert.equal(result.status,'rejected');assert.equal(result.claimed,false);
      assert.equal((await db.query('select count(*)::int n from public.crm_welcome_ledger')).rows[0].n,0);
    }
    const before=createCrmWelcomeLedger({pool});
    const claim=await before.claim({contactId:CONTACT,providerKey:'welcome:once',enabled:true});
    const after=createCrmWelcomeLedger({pool,activationAt:()=>undefined});
    await after.markAccepted({attemptId:claim.attemptId,providerMessageId:'email.saved'});
    const retry=await after.claim({contactId:CONTACT,providerKey:'welcome:retry',enabled:true});
    assert.equal(retry.claimed,false);assert.equal(retry.status,'accepted');
    assert.equal((await after.read(CONTACT)).provider_message_id,'email.saved');
  } finally {await close();}
});
