import test from 'node:test';
import assert from 'node:assert/strict';
import { pickPublicSedeWithPaymentStatus, redactSedePaymentValues } from '../utils/sedePublicSelect.js';

const row = { id: 1, nombre: 'QA', precio_por_reserva: 25, mp_access_token: 'synthetic-marker',
  mp_public_key: 'synthetic-public', stripe_account_id: 'synthetic-account',
  stripe_customer_id: 'synthetic-customer', stripe_subscription_id: 'synthetic-subscription',
  stripe_secret_key: 'synthetic-secret', stripe_webhook_secret: 'synthetic-webhook', estado: 'pendiente' };
test('public venue DTO returns payment booleans, public fields and no stored billing values', () => {
  assert.deepEqual(pickPublicSedeWithPaymentStatus(row), { id: 1, nombre: 'QA', precio_por_reserva: 25,
    mercadopago_configurado: true, stripe_configurado: true });
});
test('payment indicators reflect empty configuration without returning original values', () => {
  assert.deepEqual(pickPublicSedeWithPaymentStatus({ id: 2, mp_access_token: ' ', stripe_account_id: null }), {
    id: 2, mercadopago_configurado: false, stripe_configurado: false });
});
test('pending venue workflow preserves status while redacting every stored billing value', () => {
  assert.deepEqual(redactSedePaymentValues(row), { id: 1, nombre: 'QA', precio_por_reserva: 25,
    estado: 'pendiente', mercadopago_configurado: true, stripe_configurado: true });
});

test('all DTO levels remove private fields and preserve non-sensitive workflow data', () => {
  const nested = { ...row, licencia_activa: true, numero_licencia: 'fixture-license', franjas_horarias: [],
    options: [{ stripe_account_id: 'synthetic-account', MP_ACCESS_TOKEN: 'synthetic-marker', label: 'visible' }],
    access_token: 'synthetic-marker', password: 'synthetic-marker' };
  const dto = redactSedePaymentValues(nested);
  assert.equal(dto.licencia_activa, true);
  assert.equal(dto.numero_licencia, 'fixture-license');
  assert.deepEqual(dto.franjas_horarias, []);
  assert.deepEqual(dto.options, [{ label: 'visible' }]);
  assert.equal(JSON.stringify(dto).includes('synthetic-'), false);
  const publicDto = pickPublicSedeWithPaymentStatus({ ...row, amenities: [{ name: 'visible', private_key: 'synthetic-key' }] });
  assert.deepEqual(publicDto.amenities, [{ name: 'visible' }]);
});
