import test from 'node:test';
import assert from 'node:assert/strict';
import { createSupabaseCrmRepository } from './crmService.js';

test('email claim uses insert uniqueness, loads prior reply on conflict and fails closed on storage errors', async () => {
  let stored = null;
  const client = { from(table) {
    assert.equal(table, 'crm_replies');
    return {
      insert(row) { return { select() { return { async single() {
        if (stored) return { error: { code: '23505' } };
        stored = row; return { data: row };
      } }; } }; },
      select() { return { eq() { return { async single() { return { data: stored }; } }; } }; },
    };
  } };
  const repo = createSupabaseCrmRepository(client);
  const args = { id: 'stable-reference', conversationId: 'c1', body: 'reply', operador: 'operator' };
  const results = await Promise.all([repo.claimEmailReply(args), repo.claimEmailReply(args)]);
  assert.deepEqual(results.map(r => r.created), [true, false]);
  assert.equal(stored.status, 'pending');
  const failing = createSupabaseCrmRepository({ from() { return { insert() { return { select() { return { async single() { return { error: { code: 'XX000' } }; } }; } }; } }; } });
  await assert.rejects(failing.claimEmailReply(args));
});

test('email audit cannot silently lose provider identity while WhatsApp compatibility remains available', async () => {
  const writes = [];
  const client = { from() { return { update(payload) { writes.push(payload); return { async eq() { return writes.length === 1 ? { error: { message: 'column provider_message_id does not exist' } } : {}; } }; } }; } };
  const repo = createSupabaseCrmRepository(client);
  await assert.rejects(repo.updateReplyStatus('r1', 'sent', 'accepted-id', { strictProviderId: true }));
  assert.equal(writes.length, 1);
  writes.length = 0;
  await repo.updateReplyStatus('r1', 'sent', 'wa-id');
  assert.equal(writes.length, 2);
});
