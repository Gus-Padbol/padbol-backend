import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReservaMatchesReleaseToken,
  createReservaReleaseToken,
  verifyReservaReleaseToken,
} from './reservaReleaseToken.js';

const secret = 'qa-release-secret-0123456789-abcdef';
const nowMs = Date.parse('2026-10-03T12:00:00Z');
const reserva = { id: 71, sede: 'Club QA', fecha: '2026-10-04', hora: '18:30:00', cancha: '2', estado: 'pendiente' };

test('capacidad firmada queda ligada a id, slot y expiración', () => {
  const issued = createReservaReleaseToken({ reserva, secret, nowMs, ttlSeconds: 600 });
  const claims = verifyReservaReleaseToken(issued.token, { secret, nowMs: nowMs + 1 });
  assert.equal(claims.reservationId, 71);
  assert.doesNotThrow(() => assertReservaMatchesReleaseToken(reserva, claims));
  assert.throws(() => assertReservaMatchesReleaseToken({ ...reserva, cancha: '3' }, claims), /no corresponde/);
});

test('rechaza ausencia, alteración, encoding no canónico y expiración', () => {
  const { token } = createReservaReleaseToken({ reserva, secret, nowMs, ttlSeconds: 60 });
  assert.throws(() => verifyReservaReleaseToken('', { secret, nowMs }), (e) => e.status === 401);
  assert.throws(() => verifyReservaReleaseToken(`${token}!`, { secret, nowMs }), (e) => e.code === 'RESERVA_RELEASE_TOKEN_INVALID');
  const altered = `${token.slice(0, -1)}${token.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => verifyReservaReleaseToken(altered, { secret, nowMs }), (e) => e.status === 401);
  assert.throws(() => verifyReservaReleaseToken(token, { secret, nowMs: nowMs + 60_000 }), (e) => e.status === 410);
});

test('no firma una reserva fuera de estado pendiente', () => {
  assert.throws(
    () => createReservaReleaseToken({ reserva: { ...reserva, estado: 'confirmada' }, secret, nowMs }),
    (e) => e.code === 'RESERVA_RELEASE_INVALID_RESERVATION',
  );
});
