import test from 'node:test';
import assert from 'node:assert/strict';
import { validateCompletion } from './crmLeadAlerts.js';

const now = Date.parse('2026-11-15T12:00:00Z');
const base = { contact_at: '2026-11-15T11:00:00Z', channel: 'email', outcome: 'Contacto intentado', summary: 'Se registró el intento de contacto comercial.', commercial_state: 'en_espera', next_action: 'Volver a contactar' };

for (const responded of [false, true]) {
  test(`next contact must be strictly future; client responded=${responded}`, (t) => {
    t.mock.method(Date, 'now', () => now);
    for (const offset of [-1, 0]) {
      assert.throws(() => validateCompletion({ ...base, client_responded: responded, next_action_at: new Date(now + offset).toISOString() }), { code: 'NEXT_ACTION_IN_PAST', status: 400 });
    }
    const result = validateCompletion({ ...base, client_responded: responded, next_action_at: new Date(now + 1).toISOString() });
    assert.equal(result.attended, responded);
    for (const next_action_at of [null, '', 'invalid']) assert.throws(() => validateCompletion({ ...base, client_responded: responded, next_action_at }), { code: 'NEXT_ACTION_DATE_REQUIRED' });
  });
}

test('unanswered cannot be closed or attended; justified answered closure needs no next date', () => {
  assert.throws(() => validateCompletion({ ...base, client_responded: false, commercial_state: 'cerrado' }), { code: 'UNANSWERED_CANNOT_BE_ATTENDED' });
  assert.throws(() => validateCompletion({ ...base, client_responded: false, attended: true }), { code: 'UNANSWERED_CANNOT_BE_ATTENDED' });
  const closed = validateCompletion({ ...base, client_responded: true, commercial_state: 'cerrado', closure_reason: 'El interesado desistió de continuar.' });
  assert.equal(closed.attended, true);
  assert.equal(closed.nextActionAt, null);
});
