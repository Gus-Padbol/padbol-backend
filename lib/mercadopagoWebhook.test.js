import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMpCurrencyMatchesReserva,
  normalizeMpCurrency,
  validateVerifiedPaymentForReserva,
} from '../routes/mercadopagoWebhook.js';

function buildApprovedPayment(overrides = {}) {
  return {
    id: '123456789',
    status: 'approved',
    external_reference: '42',
    transaction_amount: 5000,
    currency_id: 'ARS',
    ...overrides,
  };
}

function buildPendingReserva(overrides = {}) {
  return {
    id: 42,
    estado: 'pendiente',
    pago_estado: 'pendiente',
    precio_esperado: 5000,
    moneda: 'ARS',
    mp_payment_id: null,
    ...overrides,
  };
}

function mockPgPoolForValidate(reserva, { usedOnOtherReserva = false } = {}) {
  return {
    query: async (sql) => {
      if (/FROM reservas WHERE id = \$1/i.test(sql)) {
        return { rows: reserva ? [reserva] : [] };
      }
      if (/mp_payment_id = \$1 AND id <> \$2/i.test(sql)) {
        return { rows: usedOnOtherReserva ? [{ id: 99, estado: 'confirmada', pago_estado: 'pagado' }] : [] };
      }
      return { rows: [] };
    },
  };
}

test('normalizeMpCurrency lowercases and trims', () => {
  assert.equal(normalizeMpCurrency(' ARS '), 'ars');
  assert.equal(normalizeMpCurrency('Usd'), 'usd');
  assert.equal(normalizeMpCurrency(''), null);
  assert.equal(normalizeMpCurrency(null), null);
});

test('assertMpCurrencyMatchesReserva: ARS vs ARS passes', () => {
  assert.doesNotThrow(() => assertMpCurrencyMatchesReserva('ARS', 'ars'));
});

test('assertMpCurrencyMatchesReserva: ARS vs USD rejects', () => {
  assert.throws(
    () => assertMpCurrencyMatchesReserva('USD', 'ARS'),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'MP_CURRENCY_MISMATCH');
      assert.match(err.message, /no coincide/i);
      return true;
    },
  );
});

test('assertMpCurrencyMatchesReserva: missing payment currency rejects', () => {
  assert.throws(
    () => assertMpCurrencyMatchesReserva(null, 'ARS'),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'MP_CURRENCY_MISSING');
      return true;
    },
  );
});

test('assertMpCurrencyMatchesReserva: missing reserva moneda defaults to ARS', () => {
  assert.doesNotThrow(() => assertMpCurrencyMatchesReserva('ARS', null));
  assert.throws(
    () => assertMpCurrencyMatchesReserva('USD', null),
    (err) => err.code === 'MP_CURRENCY_MISMATCH',
  );
});

test('validateVerifiedPaymentForReserva confirms when ARS payment matches ARS reserva', async () => {
  const pgPool = mockPgPoolForValidate(buildPendingReserva());
  const result = await validateVerifiedPaymentForReserva(pgPool, buildApprovedPayment());

  assert.equal(result.already, false);
  assert.equal(result.reservaId, 42);
  assert.equal(result.montoPagado, 5000);
});

test('validateVerifiedPaymentForReserva rejects USD payment for ARS reserva', async () => {
  const pgPool = mockPgPoolForValidate(buildPendingReserva({ moneda: 'ARS' }));

  await assert.rejects(
    () => validateVerifiedPaymentForReserva(
      pgPool,
      buildApprovedPayment({ currency_id: 'USD' }),
    ),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'MP_CURRENCY_MISMATCH');
      return true;
    },
  );
});

test('validateVerifiedPaymentForReserva rejects approved payment without currency_id', async () => {
  const pgPool = mockPgPoolForValidate(buildPendingReserva());

  await assert.rejects(
    () => validateVerifiedPaymentForReserva(
      pgPool,
      buildApprovedPayment({ currency_id: '' }),
    ),
    (err) => {
      assert.equal(err.status, 400);
      assert.equal(err.code, 'MP_CURRENCY_MISSING');
      return true;
    },
  );
});
