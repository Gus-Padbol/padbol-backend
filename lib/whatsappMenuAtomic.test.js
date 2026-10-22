import test from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsappMenuAtomicStore } from './whatsappMenuAtomic.js';

test('atomic store delegates transition and refuses uncertain writes', async () => {
  const calls = [];
  const client = { from() { return { select() { return this; }, eq() { return this; }, async maybeSingle() { return { data: null }; } }; },
    async rpc(name, args) { calls.push({name,args}); return { data: {created:true, outbox_id:'o'} }; } };
  const store = createWhatsappMenuAtomicStore(client);
  const result = await store.commit({inboundId:'i', conversationId:'c', expectedUpdatedAt:'date', state:{}, response:'hello',idempotencyKey:'key'});
  assert.equal(result.outbox_id, 'o'); assert.equal(calls[0].args.p_response,'hello');
  client.rpc = async () => ({error:{message:'failure'}});
  await assert.rejects(store.commit({}), /WHATSAPP_MENU_COMMIT_FAILED/);
  await assert.rejects(store.confirmSent({}), /WHATSAPP_MENU_CONFIRM_FAILED/);
});
