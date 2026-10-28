import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createCrmImapInboxSync,
  parsedEmailToCanonicalEvent,
  readCrmImapConfig,
} from './crmImapInbound.js';

test('IMAP queda apagado y fail-closed sin credenciales', () => {
  assert.deepEqual(readCrmImapConfig({}), {
    enabled: false,
    commercialRepliesOnly: false,
    host: '',
    port: 993,
    secure: true,
    user: '',
    password: '',
    mailbox: 'INBOX',
    expectedRecipient: 'info@padbol.com',
    intervalMs: 300000,
    lookbackDays: 7,
    maxMessages: 100,
    maxMessageBytes: 5242880,
    maxSyncBytes: 20971520,
    ready: false,
  });
});

test('keeps RFC reply references and routes a matched reply without creating another lead', async()=>{
 const raw={messageId:'<incoming@example.test>',inReplyTo:'<outbound@example.test>',references:['<older@example.test>','<outbound@example.test>'],from:{value:[{address:'client@example.test'}]},to:{value:[{address:'info@padbol.com'}]},text:'Respuesta',date:new Date()};
 const event=parsedEmailToCanonicalEvent(raw,{expectedRecipient:'info@padbol.com'});
 assert.equal(event.inReplyTo,'outbound@example.test');assert.deepEqual(event.references,['older@example.test','outbound@example.test']);
 let threaded=0;
 const client={mailbox:{uidValidity:1},async connect(){},async logout(){},async getMailboxLock(){return{release(){}}},async search(){return[1]},async *fetch(){yield{uid:1,source:Buffer.from('raw')}}};
 const sync=createCrmImapInboxSync({crmService:{ingestInbound(){throw Error('must not duplicate lead')}},config:{enabled:true,ready:true,lookbackDays:7},createClient:()=>client,parseMessage:async()=>raw,emailReturn:{async ingestReply(e){threaded++;assert.equal(e.inReplyTo,'outbound@example.test');return{matched:true}}}});
 assert.deepEqual(await sync.syncOnce(),{status:'ok',processed:1});assert.equal(threaded,1);
});

test('limita la configuración de tamaño a un rango seguro', () => {
  assert.equal(readCrmImapConfig({ CRM_INBOUND_IMAP_MAX_MESSAGE_BYTES: '1048576' }).maxMessageBytes, 1048576);
  assert.equal(readCrmImapConfig({ CRM_INBOUND_IMAP_MAX_MESSAGE_BYTES: '999999999' }).maxMessageBytes, 5242880);
  assert.equal(readCrmImapConfig({ CRM_INBOUND_IMAP_MAX_MESSAGE_BYTES: 'invalid' }).maxMessageBytes, 5242880);
  assert.equal(readCrmImapConfig({ CRM_INBOUND_IMAP_MAX_SYNC_BYTES: '10485760' }).maxSyncBytes, 10485760);
  assert.equal(readCrmImapConfig({ CRM_INBOUND_IMAP_MAX_SYNC_BYTES: '999999999' }).maxSyncBytes, 20971520);
});

test('normaliza sólo correo realmente dirigido a info@padbol.com', () => {
  const event = parsedEmailToCanonicalEvent({
    messageId: '<abc@example.com>',
    from: { value: [{ address: 'Persona@Example.com' }] },
    to: { value: [{ address: 'info@padbol.com' }] },
    subject: 'Consulta',
    text: 'Quiero representar un país.',
    date: new Date('2026-09-16T20:00:00Z'),
  }, { uidValidity: 7, uid: 42, expectedRecipient: 'info@padbol.com' });
  assert.deepEqual(event, {
    externalId: 'abc@example.com',
    from: 'persona@example.com',
    to: 'info@padbol.com',
    subject: 'Consulta',
    body: 'Quiero representar un país.',
    receivedAt: '2026-09-16T20:00:00.000Z',
  });
  assert.equal(parsedEmailToCanonicalEvent({
    from: { value: [{ address: 'persona@example.com' }] },
    to: { value: [{ address: 'otra@padbol.com' }] },
    text: 'No corresponde.',
  }, { uidValidity: 7, uid: 43, expectedRecipient: 'info@padbol.com' }), null);
});

test('sincroniza mensajes entrantes de manera idempotente a través del CRM', async () => {
  const ingested = [];
  const fetchQueries = [];
  const client = {
    mailbox: { uidValidity: 9 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [88]; },
    async *fetch(_selected, query) {
      fetchQueries.push(query);
      yield { uid: 88, source: Buffer.from('raw') };
    },
  };
  const sync = createCrmImapInboxSync({
    crmService: { async ingestInbound(payload) { ingested.push(payload); return { status: 'accepted' }; } },
    config: {
      enabled: true, ready: true, host: 'mail.padbol.com', port: 993, secure: true,
      user: 'info@padbol.com', password: 'secret', mailbox: 'INBOX', expectedRecipient: 'info@padbol.com',
      intervalMs: 300000, lookbackDays: 7, maxMessages: 100,
    },
    createClient: () => client,
    parseMessage: async () => ({
      from: { value: [{ address: 'persona@example.com' }] },
      to: { value: [{ address: 'info@padbol.com' }] },
      subject: 'Cancha', text: 'Quiero instalar una cancha.',
      date: new Date('2026-09-16T21:00:00Z'),
    }),
    now: () => new Date('2026-09-16T22:00:00Z'),
  });
  assert.deepEqual(await sync.syncOnce(), { status: 'ok', processed: 1 });
  assert.equal(ingested.length, 1);
  assert.equal(ingested[0].source, 'email');
  assert.equal(ingested[0].sourceId, '9:88');
  assert.equal(ingested[0].email, 'persona@example.com');
  assert.equal(ingested[0].origin, 'institutional_email');
  assert.deepEqual(fetchQueries, [{
    uid: true,
    source: { start: 0, maxLength: 5242881 },
  }]);
});

test('descarta un correo sobredimensionado antes del parser y continúa con el siguiente', async () => {
  const ingested = [];
  const parsedSources = [];
  const warnings = [];
  const clientOptions = [];
  const client = {
    mailbox: { uidValidity: 11 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [90, 91]; },
    async *fetch(_selected, query) {
      assert.deepEqual(query, { uid: true, source: { start: 0, maxLength: 9 } });
      yield { uid: 90, source: Buffer.alloc(9, 0x61) };
      yield { uid: 91, source: Buffer.alloc(8, 0x62) };
    },
  };
  const sync = createCrmImapInboxSync({
    crmService: { async ingestInbound(payload) { ingested.push(payload); return { status: 'accepted' }; } },
    config: {
      enabled: true, ready: true, host: 'mail.padbol.com', port: 993, secure: true,
      user: 'info@padbol.com', password: 'secret', mailbox: 'INBOX', expectedRecipient: 'info@padbol.com',
      intervalMs: 300000, lookbackDays: 7, maxMessages: 100, maxMessageBytes: 8,
    },
    createClient: (options) => { clientOptions.push(options); return client; },
    parseMessage: async (source) => {
      parsedSources.push(source);
      return {
        from: { value: [{ address: 'persona@example.com' }] },
        to: { value: [{ address: 'info@padbol.com' }] },
        subject: 'Consulta', text: 'Mensaje válido.',
      };
    },
    logger: { warn(message, detail) { warnings.push({ message, detail }); }, error() {} },
  });

  assert.deepEqual(await sync.syncOnce(), { status: 'ok', processed: 1 });
  assert.equal(parsedSources.length, 1);
  assert.equal(parsedSources[0].length, 8);
  assert.equal(ingested.length, 1);
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].detail.reason, 'message_too_large_or_invalid');
  assert.equal(clientOptions[0].maxLiteralSize, 9);
  assert.equal(clientOptions[0].maxResponseSize, 65544);
  assert.deepEqual(await sync.syncOnce(), { status: 'ok', processed: 0 });
  assert.equal(parsedSources.length, 1);
});

test('acota cada ronda, procesa en orden y no relee UIDs ya descartados', async () => {
  const selectedBatches = [];
  let fetchCall = 0;
  const client = {
    mailbox: { uidValidity: 12 },
    async connect() {},
    async logout() {},
    async getMailboxLock() { return { release() {} }; },
    async search() { return [3, 1, 2]; },
    async *fetch(selected, query) {
      selectedBatches.push([...selected]);
      assert.deepEqual(query, { uid: true, source: { start: 0, maxLength: 9 } });
      fetchCall += 1;
      for (const uid of selected) yield { uid, source: Buffer.alloc(9, fetchCall) };
    },
  };
  const sync = createCrmImapInboxSync({
    crmService: { async ingestInbound() { throw new Error('oversized mail must not reach CRM'); } },
    config: {
      enabled: true, ready: true, host: 'mail.padbol.com', port: 993, secure: true,
      user: 'info@padbol.com', password: 'secret', mailbox: 'INBOX', expectedRecipient: 'info@padbol.com',
      intervalMs: 300000, lookbackDays: 7, maxMessages: 500, maxMessageBytes: 8, maxSyncBytes: 18,
    },
    createClient: () => client,
    parseMessage: async () => { throw new Error('oversized mail must not reach parser'); },
    logger: { warn() {}, error() {} },
  });

  assert.deepEqual(await sync.syncOnce(), { status: 'ok', processed: 0 });
  assert.deepEqual(await sync.syncOnce(), { status: 'ok', processed: 0 });
  assert.deepEqual(await sync.syncOnce(), { status: 'ok', processed: 0 });
  assert.deepEqual(selectedBatches, [[1, 2], [3]]);
});

test('commercial replies-only mode fails closed without eligible identities before mailbox connect',async()=>{
 for(const readCommercialSenders of [null,async()=>[],async()=>{throw Error('storage unavailable')}]){
 let connects=0,ingests=0;const sync=createCrmImapInboxSync({crmService:{ingestInbound(){ingests++}},config:{enabled:true,ready:true,commercialRepliesOnly:true},readCommercialSenders,createClient:()=>({connect(){connects++},async logout(){}}),logger:{error(){}}});
 assert.equal((await sync.syncOnce()).processed,0);assert.equal(connects,0);assert.equal(ingests,0);
 }
});
test('commercial IMAP prefilters known senders so unrelated backlog cannot starve new reply, then rejects spoofed FROM matches',async()=>{
 const searches=[],queued=[],ingested=[];let fetched;
 const parsed=from=>({messageId:'<new@example.test>',from:{value:[{address:from}]},to:{value:[{address:'info@padbol.com'}]},subject:'Re: Project',text:'Hello',date:new Date(),inReplyTo:'<known@example.test>'});
 const client={mailbox:{uidValidity:1},async connect(){},async logout(){},async getMailboxLock(){return {release(){}}},async search(q){searches.push(q);return [5000,5001]},async *fetch(ids){fetched=ids;for(const uid of ids)yield {uid,source:Buffer.from(String(uid))}}};
 const sync=createCrmImapInboxSync({crmService:{async ingestInbound(e){ingested.push(e)}},config:{enabled:true,ready:true,commercialRepliesOnly:true,lookbackDays:7},readCommercialSenders:async()=>['firstlast@gmail.com','first.last@gmail.com'],createClient:()=>client,parseMessage:async b=>parsed(String(b)==='5000'?'First.Last@gmail.com':'attacker@other.test'),emailReturn:{async ingestReply(e){queued.push(e);return {matched:true}}}});
 assert.deepEqual(await sync.syncOnce(),{status:'ok',processed:1});assert.deepEqual(fetched,[5000,5001]);assert.deepEqual(searches[0].or,[{from:'firstlast@gmail.com'},{from:'first.last@gmail.com'}]);assert.equal(queued.length,1);assert.equal(queued[0].from,'first.last@gmail.com');assert.equal(ingested.length,0);
});
test('invalid reader identities and excessive scope do not issue unconstrained IMAP search',async()=>{
 for(const addresses of [['wrong string'],Array(1001).fill('a@example.test')]){
 let calls=0;const sync=createCrmImapInboxSync({crmService:{},config:{enabled:true,ready:true,commercialRepliesOnly:true},readCommercialSenders:async()=>addresses,createClient:()=>({async connect(){calls++},async logout(){}}),logger:{error(){}}});
 assert.equal((await sync.syncOnce()).status,'error');assert.equal(calls,0);
 }
});
