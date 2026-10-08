import test from 'node:test';

import assert from 'node:assert/strict';

import { buildOrganizationPayload, normalizeOrganizationId } from './adminOrganizations.js';

test('normalizeOrganizationId only accepts UUIDs', () => {
  assert.equal(normalizeOrganizationId('550e8400-e29b-41d4-a716-446655440000'), '550e8400-e29b-41d4-a716-446655440000');
  assert.equal(normalizeOrganizationId('123'), null);
});

test('buildOrganizationPayload trims fields and defaults to Business', () => {
  const payload = buildOrganizationPayload({ nombre: '  Cadena Centro  ', pais_principal: ' Argentina ' });
  assert.equal(payload.nombre, 'Cadena Centro');
  assert.equal(payload.pais_principal, 'Argentina');
  assert.equal(payload.plan_codigo, 'business');
  assert.equal(payload.estado, 'activa');
  assert.equal(payload.limite_sedes, 1);
  assert.equal(payload.limite_canchas_total, 1);
  assert.equal(payload.limite_admins_centrales, 1);
  assert.deepEqual(payload.funciones_habilitadas, ['reservas', 'torneos', 'jugadores', 'reportes']);
});

test('buildOrganizationPayload rejects an empty name', () => {
  assert.throws(() => buildOrganizationPayload({ nombre: ' ' }), /Nombre de la organización obligatorio/);
});

test('buildOrganizationPayload validates commercial limits and enabled functions', () => {
  assert.throws(() => buildOrganizationPayload({ nombre: 'Cadena', limite_sedes: 0 }), /limite_sedes/);
  assert.throws(
    () => buildOrganizationPayload({ nombre: 'Cadena', funciones_habilitadas: ['inventada'] }),
    /Habilitá al menos una función/,
  );
  const payload = buildOrganizationPayload({
    nombre: 'Cadena',
    limite_sedes: 4,
    limite_canchas_total: 20,
    limite_admins_centrales: 2,
    funciones_habilitadas: ['reservas', 'scoreboard', 'reservas'],
  });
  assert.equal(payload.limite_sedes, 4);
  assert.equal(payload.limite_canchas_total, 20);
  assert.equal(payload.limite_admins_centrales, 2);
  assert.deepEqual(payload.funciones_habilitadas, ['reservas', 'scoreboard']);
});
