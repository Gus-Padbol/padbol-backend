import test from 'node:test';
import assert from 'node:assert/strict';
import {SEDE_PUBLIC_COLUMNS, SEDE_APP_SELECT} from './sedePublicSelect.js';

test('tipo_sede viaja en el DTO público (el guard de UI depende de él)', () => {
  assert.ok(SEDE_PUBLIC_COLUMNS.includes('tipo_sede'));
  assert.match(SEDE_APP_SELECT, /\btipo_sede\b/);
});

test('el DTO no expone campos sensibles', () => {
  // pago_manual_instrucciones es intencionalmente público (instrucción de pago); los secretos no.
  for (const campo of ['mp_access_token', 'mp_public_key', 'stripe_account_id']) {
    assert.equal(SEDE_PUBLIC_COLUMNS.includes(campo), false, `${campo} no debe ser público`);
  }
});
