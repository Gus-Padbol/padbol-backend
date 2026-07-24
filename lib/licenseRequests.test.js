import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLicenseRequestPayload } from '../routes/licenseRequests.js';

test('license request requires a valid contact email', () => {
  assert.match(
    buildLicenseRequestPayload({
      email: 'invalid',
      club_nombre: 'Club',
      responsable_nombre: 'Persona',
      pais: 'Argentina',
      ciudad: 'Buenos Aires',
    }).error,
    /email/i,
  );
});

test('license request normalizes public input and forces pending state', () => {
  const parsed = buildLicenseRequestPayload({
    email: ' ADMIN@EXAMPLE.COM ',
    club_nombre: ' Club Norte ',
    responsable_nombre: ' Ana ',
    pais: ' Argentina ',
    ciudad: ' Córdoba ',
    estado: 'aprobada',
    deportes_canchas: { deportes: ['padbol'] },
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.email, 'admin@example.com');
  assert.equal(parsed.data.club_nombre, 'Club Norte');
  assert.equal(parsed.data.estado, 'pendiente');
  assert.deepEqual(parsed.data.deportes_canchas, { deportes: ['padbol'] });
});
