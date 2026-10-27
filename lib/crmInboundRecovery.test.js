import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseCrmRepository } from './crmService.js';

function repository(results) {
  return createSupabaseCrmRepository({ from() {
    const result = results.shift();
    return { select() { return this; }, insert() { return this; }, eq() { return this; },
      maybeSingle() { return Promise.resolve(result); }, single() { return Promise.resolve(result); } };
  } });
}

test('inbound lookups reject database failures rather than treating unavailable data as absent', async () => {
  for (const [method, args] of [['findAttempt', ['attempt']], ['findConversation', ['attempt','email','source']], ['findInboundEvent', ['email','origin','source']]]) {
    await assert.rejects(repository([{data:null,error:{code:'XX000'}}])[method](...args));
  }
});

test('concurrent attempt and conversation uniqueness conflicts reread the same contact record', async () => {
  const conflict = {data:null,error:{code:'23505'}};
  const attempt = {attempt_id:'same',channel:'email',contact_id:'contact'};
  assert.deepEqual(await repository([conflict,{data:attempt}]).createAttempt(attempt),attempt);
  const conversation = {id:'conversation',contact_id:'contact',attempt_id:'same',source_channel:'email',source_ref:'source'};
  assert.deepEqual(await repository([conflict,{data:conversation}]).createConversation(conversation),conversation);
  await assert.rejects(repository([conflict,{data:{...attempt,contact_id:'other'}}]).createAttempt(attempt));
  await assert.rejects(repository([conflict,{data:{...conversation,contact_id:'other'}}]).createConversation(conversation));
});

test('failed or empty insertion never produces a false inbound receipt', async () => {
  for(const method of ['createAttempt','createConversation','createInboundEvent']) {
    await assert.rejects(repository([{data:null,error:{code:'XX000'}}])[method]({contact_id:'contact'}));
    await assert.rejects(repository([{data:null,error:null}])[method]({contact_id:'contact'}));
  }
});
