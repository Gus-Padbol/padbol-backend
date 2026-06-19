import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEmailPublicIdentifier,
  parsePerfilPublicoIdentifier,
} from '../routes/jugadorPerfilPublico.js';

test('parsePerfilPublicoIdentifier detects email', () => {
  const parsed = parsePerfilPublicoIdentifier('test@example.com');
  assert.equal(parsed.kind, 'email');
  assert.equal(parsed.value, 'test@example.com');
});

test('isEmailPublicIdentifier blocks email lookups', () => {
  assert.equal(isEmailPublicIdentifier('someone@padbol.com'), true);
  assert.equal(isEmailPublicIdentifier('not-an-email'), false);
});

test('parsePerfilPublicoIdentifier accepts uuid', () => {
  const uuid = '8beebdbe-e1d7-4607-9bb0-9a7d64701408';
  const parsed = parsePerfilPublicoIdentifier(uuid);
  assert.equal(parsed.kind, 'user_id');
  assert.equal(parsed.value, uuid);
});

test('parsePerfilPublicoIdentifier accepts username', () => {
  const parsed = parsePerfilPublicoIdentifier('gus_padbol');
  assert.equal(parsed.kind, 'username');
  assert.equal(parsed.value, 'gus_padbol');
});
