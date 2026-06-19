import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveArenaLogrosTargetUserId } from './arenaLogrosAuth.js';

test('uses JWT subject and ignores body.user_id', () => {
  const jwtUser = { id: 'jwt-user-uuid' };
  assert.equal(
    resolveArenaLogrosTargetUserId(jwtUser, { user_id: 'victim-uuid', context: {} }),
    'jwt-user-uuid',
  );
});

test('returns null without authenticated user', () => {
  assert.equal(resolveArenaLogrosTargetUserId(null, { user_id: 'any' }), null);
});
