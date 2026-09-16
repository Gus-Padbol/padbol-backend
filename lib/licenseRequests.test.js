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
  assert.equal(parsed.data.whatsapp_followup_consent, false);
  assert.equal(parsed.data.whatsapp_followup_consent_source, null);
  assert.equal(parsed.data.whatsapp_followup_consent_version, null);
  assert.equal(parsed.data.whatsapp_followup_consent_text, null);
  assert.equal(parsed.data.whatsapp_followup_consent_at, null);
});

test('license request stores specific WhatsApp follow-up consent separately from marketing', () => {
  const before = Date.now();
  const parsed = buildLicenseRequestPayload({
    email: 'club@example.com',
    club_nombre: 'Club Norte',
    responsable_nombre: 'Ana',
    whatsapp: '+54 9 221 555 1234',
    whatsapp_followup_consent: true,
    whatsapp_followup_consent_source: 'web:contacto_business',
  });
  assert.equal(parsed.error, undefined);
  assert.equal(parsed.data.whatsapp_followup_consent, true);
  assert.equal(parsed.data.whatsapp_followup_consent_source, 'web:contacto_business');
  assert.equal(parsed.data.whatsapp_followup_consent_version, 'whatsapp-followup-v1');
  assert.match(parsed.data.whatsapp_followup_consent_text, /seguimiento a esta solicitud/i);
  assert.match(parsed.data.whatsapp_followup_consent_text, /no incluye comunicaciones de marketing/i);
  assert.ok(Date.parse(parsed.data.whatsapp_followup_consent_at) >= before);
});
