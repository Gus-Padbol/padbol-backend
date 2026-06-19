import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertMpCurrencyMatchesReserva,
  assertMpPaymentIdNotUsedOnOtherReservaPg,
  buildMercadoPagoWebhookClientError,
  MP_WEBHOOK_PUBLIC_ERROR,
  MP_WEBHOOK_VERIFY_UNAVAILABLE_ERROR,
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

test('buildMercadoPagoWebhookClientError hides currency mismatch details', () => {
  const err = new Error('Moneda del pago (USD) no coincide con la reserva (ARS)');
  err.status = 400;
  err.code = 'MP_CURRENCY_MISMATCH';

  const { status, body } = buildMercadoPagoWebhookClientError(err);

  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.equal(body.error, MP_WEBHOOK_PUBLIC_ERROR);
  assert.doesNotMatch(body.error, /USD|ARS|moneda/i);
});

test('buildMercadoPagoWebhookClientError hides reused payment ids', () => {
  const err = new Error('El pago MP 123456789 ya fue usado en la reserva 99');
  err.status = 409;
  err.code = 'MP_PAYMENT_ID_ALREADY_USED';

  const { status, body } = buildMercadoPagoWebhookClientError(err);

  assert.equal(status, 409);
  assert.equal(body.ok, false);
  assert.equal(body.error, MP_WEBHOOK_PUBLIC_ERROR);
  assert.doesNotMatch(JSON.stringify(body), /123456789|reserva 99|MP_PAYMENT/i);
});

test('buildMercadoPagoWebhookClientError returns generic 503 for mp_payment_id check failure', () => {
  const err = new Error('No se pudo verificar unicidad del pago de Mercado Pago');
  err.status = 503;
  err.code = 'MP_PAYMENT_ID_CHECK_FAILED';

  const { status, body } = buildMercadoPagoWebhookClientError(err);

  assert.equal(status, 503);
  assert.equal(body.error, MP_WEBHOOK_VERIFY_UNAVAILABLE_ERROR);
  assert.doesNotMatch(body.error, /unicidad|mp_payment_id/i);
});

test('buildMercadoPagoWebhookClientError hides sql and stack details on unexpected errors', () => {
  const err = new Error('column "mp_payment_id" of relation "reservas" does not exist');
  err.status = 500;
  err.stack = 'Error: column "mp_payment_id"\n    at Object.query (/app/routes/mercadopagoWebhook.js:10:5)';

  const { status, body } = buildMercadoPagoWebhookClientError(err);

  assert.equal(status, 500);
  assert.equal(body.error, MP_WEBHOOK_PUBLIC_ERROR);
  assert.doesNotMatch(JSON.stringify(body), /column|relation|reservas|stack|mercadopagoWebhook/i);
});

test('buildMercadoPagoWebhookClientError uses invalid payload message for missing payment_id', () => {
  const { status, body } = buildMercadoPagoWebhookClientError(null, { invalidPayload: true });

  assert.equal(status, 400);
  assert.equal(body.ok, false);
  assert.match(body.error, /inválida/i);
  assert.doesNotMatch(body.error, /payment_id|topic|collection_id/i);
});
