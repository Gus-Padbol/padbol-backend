import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeManualLead } from './crmManualLead.js';
import { commercialSourceFields } from './crmCommercialSource.js';

test('normaliza contacto, interés, estado y seguimiento sin exigir campos opcionales', () => {
  const value = normalizeManualLead({
    name: '  Juan Pérez ',
    email: 'Juan@Example.com ',
    phone: '+54 (911) 1234-5678',
    company: 'Club Norte', country: 'Argentina', city: 'La Plata',
    interest: 'club', status: 'en_espera', nextStep: 'Llamar el martes',
    nextContactAt: '2026-11-10T15:00:00-03:00', reminderHours: [8, 24, 24],
    sourceDetail: 'Referido de un socio', notes: 'Quiere sumar una cancha.',
  });
  assert.equal(value.name, 'Juan Pérez');
  assert.equal(value.email, 'juan@example.com');
  assert.equal(value.phone, '5491112345678');
  assert.equal(value.interest, 'club');
  assert.equal(value.status, 'en_espera');
  assert.deepEqual(value.reminderHours, [24, 8]);
  assert.equal(value.fields['Empresa, club o sede'], 'Club Norte');
});

test('permite ficha incompleta con un solo dato de contacto y no inventa campañas', () => {
  const value = normalizeManualLead({ email: 'persona@example.invalid', status: 'nuevo' });
  assert.equal(value.email, 'persona@example.invalid');
  assert.equal(value.phone, null);
  assert.equal(value.nextContactAt, null);
  assert.equal(value.fields['Origen conocido'], null);
});

test('rechaza identidad inválida y estados/intereses fuera del catálogo', () => {
  assert.throws(() => normalizeManualLead({}), /correo o un teléfono/i);
  assert.throws(() => normalizeManualLead({ email: 'no-es-email' }), /correo/i);
  assert.throws(() => normalizeManualLead({ email: 'a@b.test', status: 'perdido' }), /Estado/i);
  assert.throws(() => normalizeManualLead({ email: 'a@b.test', interest: 'otro' }), /interés/i);
});

test('Carga manual es una etiqueta propia y no se confunde con formulario o email', () => {
  assert.equal(commercialSourceFields({source_channel:'email',origin:'manual'}).sourceLabel, 'Carga manual');
  assert.equal(commercialSourceFields({source_channel:'email',origin:'manual_contact'}).sourceLabel, 'Carga manual');
  assert.equal(commercialSourceFields({source_channel:'email',origin:'web_form:x'}).sourceLabel, 'Formulario web');
});
