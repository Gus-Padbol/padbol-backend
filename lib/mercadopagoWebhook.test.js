import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMpCurrencyMatchesReserva,
  assertMpPaymentIdNotUsedOnOtherReservaPg,
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

function mockPgPoolForValidate(reserva, {
  usedOnOtherReserva = false,
  mpPaymentIdCheckError = null,
} = {}) {
  return {
    query: async (sql) => {
      if (/FROM reservas WHERE id = \$1/i.test(sql)) {
        return { rows: reserva ? [reserva] : [] };
      }
      if (/mp_payment_id = \$1 AND id <> \$2/i.test(sql)) {
        if (mpPaymentIdCheckError) throw mpPaymentIdCheckError;
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

test('assertMpPaymentIdNotUsedOnOtherReservaPg rejects payment used on another reserva', async () => {
  const pgPool = mockPgPoolForValidate(buildPendingReserva(), { usedOnOtherReserva: true });

  await assert.rejects(
    () => assertMpPaymentIdNotUsedOnOtherReservaPg(pgPool, '123456789', 42),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'MP_PAYMENT_ID_ALREADY_USED');
      return true;
    },
  );
});

test('validateVerifiedPaymentForReserva rejects when mp_payment_id belongs to another reserva', async () => {
  const pgPool = mockPgPoolForValidate(buildPendingReserva(), { usedOnOtherReserva: true });

  await assert.rejects(
    () => validateVerifiedPaymentForReserva(pgPool, buildApprovedPayment()),
    (err) => {
      assert.equal(err.status, 409);
      assert.equal(err.code, 'MP_PAYMENT_ID_ALREADY_USED');
      return true;
    },
  );
});

test('assertMpPaymentIdNotUsedOnOtherReservaPg fails safe on SQL/column errors', async () => {
  const columnErr = new Error('column "mp_payment_id" of relation "reservas" does not exist');
  const pgPool = mockPgPoolForValidate(buildPendingReserva(), {
    mpPaymentIdCheckError: columnErr,
  });

  await assert.rejects(
    () => assertMpPaymentIdNotUsedOnOtherReservaPg(pgPool, '123456789', 42),
    (err) => {
      assert.equal(err.status, 503);
      assert.equal(err.code, 'MP_PAYMENT_ID_CHECK_FAILED');
      assert.equal(err.message, 'No se pudo verificar unicidad del pago de Mercado Pago');
      assert.doesNotMatch(err.message, /column|sql/i);
      return true;
    },
  );
});

test('validateVerifiedPaymentForReserva fails safe when mp_payment_id check query errors', async () => {
  const pgPool = mockPgPoolForValidate(buildPendingReserva(), {
    mpPaymentIdCheckError: new Error('column "mp_payment_id" does not exist'),
  });

  await assert.rejects(
    () => validateVerifiedPaymentForReserva(pgPool, buildApprovedPayment()),
    (err) => err.code === 'MP_PAYMENT_ID_CHECK_FAILED' && err.status === 503,
  );
});

test('validateVerifiedPaymentForReserva is idempotent for same payment_id on same reserva', async () => {
  const pgPool = mockPgPoolForValidate(buildPendingReserva({
    estado: 'confirmada',
    pago_estado: 'pagado',
    mp_payment_id: '123456789',
  }));

  const result = await validateVerifiedPaymentForReserva(pgPool, buildApprovedPayment());

  assert.equal(result.already, true);
  assert.equal(result.reservaId, 42);
  assert.equal(result.mpPaymentId, '123456789');
});
