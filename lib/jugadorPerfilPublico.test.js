import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isEmailPublicIdentifier,
  parsePerfilPublicoIdentifier,
  buildPublicPerfilPayloadPg,
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

for (const scenario of [
  { name: 'keeps declared profile sports', deportes: ['padbol'], available: false, expected: ['padbol'], legacyQueries: 0 },
  { name: 'supports the deployed schema without optional legacy table', deportes: null, available: false, expected: [], legacyQueries: 0 },
  { name: 'reads sports from an existing legacy table', deportes: null, available: true, legacy: [{ deporte: 'padbol' }], expected: ['padbol'], legacyQueries: 1 },
  { name: 'does not invent a sport for an empty legacy table', deportes: null, available: true, legacy: [], expected: [], legacyQueries: 1 },
]) {
  test(`public profile ${scenario.name}`, async () => {
    let legacyQueries = 0;
    const pgPool = { async query(sql) {
      if (sql.includes('FROM jugadores_perfil')) return { rows: [{
        user_id: '8beebdbe-e1d7-4607-9bb0-9a7d64701408', alias: 'fixture',
        deportes: scenario.deportes, email: 'private@example.invalid',
        whatsapp: 'private-contact', push_token: 'private-token',
      }] };
      if (sql.includes('to_regclass')) return { rows: [{ available: scenario.available }] };
      if (sql.includes('FROM public.jugador_deportes')) {
        legacyQueries += 1;
        assert.equal(scenario.available, true, 'must not query an absent table');
        return { rows: scenario.legacy };
      }
      if (sql.includes('FROM equipos')) return { rows: [] };
      assert.fail(`Unexpected query: ${sql}`);
    } };
    const payload = await buildPublicPerfilPayloadPg(pgPool, 'fixture');
    assert.deepEqual(payload.deportes, scenario.expected);
    assert.equal(payload.deporte_principal, scenario.expected[0] ?? null);
    assert.equal(legacyQueries, scenario.legacyQueries);
    for (const key of ['email', 'whatsapp', 'push_token', 'expo_push_token', 'fecha_nacimiento']) {
      assert.equal(Object.hasOwn(payload, key), false);
    }
  });
}
