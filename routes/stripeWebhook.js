import {
  assertPaymentAmountCoversExpected,
  PAYMENT_AMOUNT_TOLERANCE,
} from './mercadopagoWebhook.js';
import {
  fromStripeMinorUnits,
  stripeCurrenciesMatch,
} from '../lib/stripe/stripeAmount.js';
import { mapPagoExitosoPollDto } from '../lib/dto/reservaDto.js';

const ALLOWED_PRE_CONFIRM_ESTADOS = new Set(['pendiente', 'prereserva']);

const RESERVA_STRIPE_SELECT = `
  id, estado, pago_estado, sede, sede_id, fecha, hora, cancha, whatsapp, telefono,
  precio, precio_esperado, moneda, monto_pagado,
  stripe_payment_intent_id, stripe_checkout_session_id, payment_provider, user_id
`;

function jsonError(res, status, message, extra = {}) {
  if (res.headersSent) return;
  return res.status(status).json({ ok: false, error: message, ...extra });
}

function normalizeEstado(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function parseStripeMetadataReservaId(metadata = {}) {
  const raw = metadata.reserva_id ?? metadata.reservaId ?? metadata.external_reference;
  const n = parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function fetchReservaForStripeConfirmPg(pgPool, reservaId) {
  const rid = parseInt(String(reservaId), 10);
  const { rows } = await pgPool.query(
    `SELECT ${RESERVA_STRIPE_SELECT} FROM reservas WHERE id = $1`,
    [rid],
  );
  return rows[0] ?? null;
}

async function assertStripePaymentIntentNotUsedOnOtherReservaPg(pgPool, paymentIntentId, reservaId) {
  if (!paymentIntentId) return;
  const { rows } = await pgPool.query(
    `SELECT id FROM reservas
     WHERE stripe_payment_intent_id = $1 AND id <> $2
     LIMIT 1`,
    [paymentIntentId, reservaId],
  );
  if (rows[0]) {
    const err = new Error(`El payment_intent ${paymentIntentId} ya fue usado en la reserva ${rows[0].id}`);
    err.status = 409;
    err.code = 'STRIPE_PAYMENT_INTENT_ALREADY_USED';
    throw err;
  }
}

async function assertStripeSessionNotUsedOnOtherReservaPg(pgPool, sessionId, reservaId) {
  if (!sessionId) return;
  const { rows } = await pgPool.query(
    `SELECT id FROM reservas
     WHERE stripe_checkout_session_id = $1 AND id <> $2
     LIMIT 1`,
    [sessionId, reservaId],
  );
  if (rows[0]) {
    const err = new Error(`La checkout session ${sessionId} ya fue usada en la reserva ${rows[0].id}`);
    err.status = 409;
    err.code = 'STRIPE_SESSION_ALREADY_USED';
    throw err;
  }
}

function extractStripePaymentIntentId(session) {
  if (typeof session.payment_intent === 'string') return session.payment_intent;
  if (session.payment_intent?.id) return String(session.payment_intent.id);
  return null;
}

/**
 * Valida checkout session Stripe + reserva. No muta DB.
 */
export async function validateVerifiedStripeSessionForReserva(pgPool, session, stripeClient) {
  if (!pgPool) {
    const err = new Error('DATABASE_URL no configurada — pgPool no disponible');
    err.status = 503;
    throw err;
  }

  let fullSession = session;
  if (stripeClient && session?.id && (!session.amount_total || !session.currency)) {
    fullSession = await stripeClient.checkout.sessions.retrieve(String(session.id), {
      expand: ['payment_intent'],
    });
  }

  const paymentStatus = String(fullSession.payment_status || '').toLowerCase();
  if (paymentStatus !== 'paid') {
    const err = new Error(paymentStatus ? `Checkout en estado ${paymentStatus}` : 'Estado de pago desconocido');
    err.status = 400;
    err.payment_status = paymentStatus;
    throw err;
  }

  const reservaId = parseStripeMetadataReservaId(fullSession.metadata ?? {});
  if (!reservaId) {
    const err = new Error('metadata.reserva_id vacío o inválido');
    err.status = 400;
    throw err;
  }

  const sessionId = fullSession.id ? String(fullSession.id) : null;
  const paymentIntentId = extractStripePaymentIntentId(fullSession);
  if (!paymentIntentId) {
    const err = new Error('Checkout session sin payment_intent');
    err.status = 400;
    throw err;
  }

  const montoPagado = fromStripeMinorUnits(fullSession.currency, fullSession.amount_total);
  const reserva = await fetchReservaForStripeConfirmPg(pgPool, reservaId);
  if (!reserva) {
    const err = new Error(`Reserva ${reservaId} no encontrada`);
    err.status = 404;
    throw err;
  }

  const estado = normalizeEstado(reserva.estado);
  const pagoEstado = normalizeEstado(reserva.pago_estado);

  if (estado === 'confirmada' && pagoEstado === 'pagado') {
    const samePi = reserva.stripe_payment_intent_id
      && String(reserva.stripe_payment_intent_id) === paymentIntentId;
    const sameSession = sessionId && reserva.stripe_checkout_session_id
      && String(reserva.stripe_checkout_session_id) === sessionId;
    if (!samePi && !sameSession) {
      const err = new Error('La reserva ya está confirmada con otro pago Stripe');
      err.status = 409;
      throw err;
    }
    return {
      reservaId,
      reserva,
      montoPagado,
      paymentIntentId,
      sessionId,
      already: true,
    };
  }

  if (!ALLOWED_PRE_CONFIRM_ESTADOS.has(estado)) {
    const err = new Error(`Estado de reserva no válido para confirmar pago: ${estado || 'desconocido'}`);
    err.status = 400;
    throw err;
  }

  if (reserva.precio_esperado == null || Number(reserva.precio_esperado) <= 0) {
    const err = new Error('La reserva no tiene precio_esperado — crear checkout con crear-pago-stripe');
    err.status = 400;
    throw err;
  }

  if (!stripeCurrenciesMatch(reserva.moneda, fullSession.currency)) {
    const err = new Error(
      `Moneda del pago (${fullSession.currency}) no coincide con la reserva (${reserva.moneda})`,
    );
    err.status = 400;
    throw err;
  }

  assertPaymentAmountCoversExpected(montoPagado, reserva.precio_esperado, PAYMENT_AMOUNT_TOLERANCE);
  await assertStripePaymentIntentNotUsedOnOtherReservaPg(pgPool, paymentIntentId, reservaId);
  await assertStripeSessionNotUsedOnOtherReservaPg(pgPool, sessionId, reservaId);

  return {
    reservaId,
    reserva,
    montoPagado,
    paymentIntentId,
    sessionId,
    already: false,
  };
}

export async function confirmReservaAfterVerifiedStripePayment(pgPool, {
  reservaId,
  montoPagado,
  paymentIntentId,
  sessionId,
}) {
  if (!pgPool) {
    const err = new Error('DATABASE_URL no configurada — pgPool no disponible');
    err.status = 503;
    throw err;
  }

  const rid = parseInt(String(reservaId), 10);
  const pi = String(paymentIntentId || '').trim();
  const sid = sessionId ? String(sessionId) : null;
  if (!pi) {
    const err = new Error('stripe_payment_intent_id requerido');
    err.status = 400;
    throw err;
  }

  const monto = Number(montoPagado);

  const { rows: updatedRows } = await pgPool.query(
    `UPDATE reservas
     SET estado = 'confirmada',
         pago_estado = 'pagado',
         monto_pagado = $2::numeric,
         stripe_payment_intent_id = $3,
         stripe_checkout_session_id = COALESCE($4, stripe_checkout_session_id),
         payment_provider = 'stripe'
     WHERE id = $1
       AND lower(trim(estado)) IN ('pendiente', 'prereserva')
     RETURNING ${RESERVA_STRIPE_SELECT}`,
    [rid, Number.isFinite(monto) ? monto : null, pi, sid],
  );

  if (updatedRows[0]) {
    return { reserva: updatedRows[0], already: false };
  }

  const existing = await fetchReservaForStripeConfirmPg(pgPool, rid);
  if (!existing) {
    const err = new Error(`Reserva ${rid} no encontrada`);
    err.status = 404;
    throw err;
  }

  const estado = normalizeEstado(existing.estado);
  const pagoEstado = normalizeEstado(existing.pago_estado);
  if (estado === 'confirmada' && pagoEstado === 'pagado') {
    return { reserva: existing, already: true };
  }

  const err = new Error(`No se pudo confirmar la reserva ${rid} (estado actual: ${estado})`);
  err.status = 409;
  throw err;
}

export async function procesarStripeCheckoutSession(pgPool, session, deps = {}) {
  const validated = await validateVerifiedStripeSessionForReserva(
    pgPool,
    session,
    deps.stripeClient,
  );

  if (validated.already) {
    return {
      ok: true,
      processed: true,
      reserva_id: validated.reservaId,
      session_id: validated.sessionId,
      payment_intent_id: validated.paymentIntentId,
      already: true,
      reserva: validated.reserva,
      confirmed: true,
    };
  }

  const { reserva, already } = await confirmReservaAfterVerifiedStripePayment(pgPool, {
    reservaId: validated.reservaId,
    montoPagado: validated.montoPagado,
    paymentIntentId: validated.paymentIntentId,
    sessionId: validated.sessionId,
  });

  if (!already && deps.sendWhatsAppConfirmation && reserva) {
    const phone = reserva.whatsapp || reserva.telefono;
    if (phone) {
      let direccion = null;
      if (deps.supabase && reserva.sede) {
        try {
          const { data: sedeRow } = await deps.supabase
            .from('sedes')
            .select('direccion')
            .eq('nombre', reserva.sede)
            .maybeSingle();
          direccion = sedeRow?.direccion ?? null;
        } catch {
          /* noop */
        }
      }
      deps.sendWhatsAppConfirmation(phone, {
        sede: reserva.sede,
        fecha: reserva.fecha,
        hora: reserva.hora,
        cancha: reserva.cancha,
        direccion,
      }).catch((err) => console.warn('⚠️ WhatsApp confirmación Stripe:', err.message));
    }
  }

  console.log(
    `✓ Stripe session ${validated.sessionId} → reserva ${validated.reservaId} confirmada${already ? ' (ya estaba)' : ''}`,
  );

  return {
    ok: true,
    processed: true,
    reserva_id: validated.reservaId,
    session_id: validated.sessionId,
    payment_intent_id: validated.paymentIntentId,
    already,
    reserva,
    confirmed: true,
  };
}

function buildStripePagoExitosoReadResponse({ reserva, reservaId, paymentStatus }) {
  const estado = normalizeEstado(reserva?.estado);
  const pagoEstado = normalizeEstado(reserva?.pago_estado);
  const confirmed = estado === 'confirmada' && pagoEstado === 'pagado';

  return mapPagoExitosoPollDto({
    reserva,
    reservaId,
    confirmed,
    provider: 'stripe',
    paymentStatus: paymentStatus ?? null,
    message: confirmed
      ? 'Reserva confirmada por webhook de Stripe'
      : 'Pago pendiente de confirmación — esperá unos segundos o revisá el estado de la reserva',
  });
}

async function handleStripePagoExitosoReadOnly(req, res, pgPool, deps) {
  try {
    if (!pgPool) {
      return jsonError(res, 503, 'DATABASE_URL no configurada — pgPool no disponible');
    }

    const sessionId = String(
      req.query?.session_id
      ?? req.query?.checkout_session_id
      ?? req.body?.session_id
      ?? '',
    ).trim();

    if (!sessionId) {
      return res.status(400).json({
        ok: false,
        read_only: true,
        provider: 'stripe',
        error: 'Falta session_id',
      });
    }

    let paymentStatus = null;
    if (deps.stripeClient) {
      try {
        const session = await deps.stripeClient.checkout.sessions.retrieve(sessionId);
        paymentStatus = String(session.payment_status || '').toLowerCase();
      } catch (fetchErr) {
        console.warn('[STRIPE PAGO-EXITOSO] no se pudo leer session:', fetchErr.message);
      }
    }

    const { rows } = await pgPool.query(
      `SELECT ${RESERVA_STRIPE_SELECT} FROM reservas
       WHERE stripe_checkout_session_id = $1
       LIMIT 1`,
      [sessionId],
    );
    const reserva = rows[0] ?? null;

    if (!reserva) {
      return res.status(404).json({
        ok: false,
        read_only: true,
        provider: 'stripe',
        error: `No hay reserva asociada a session_id ${sessionId}`,
      });
    }

    return res.status(200).json(buildStripePagoExitosoReadResponse({
      reserva,
      reservaId: reserva.id,
      sessionId,
      paymentStatus,
    }));
  } catch (err) {
    console.error('[STRIPE PAGO-EXITOSO] error:', err?.message);
    return jsonError(res, err.status || 500, err.message || 'Error al consultar estado de pago');
  }
}

async function handleStripeWebhook(req, res, pgPool, deps) {
  try {
    if (!pgPool) {
      return jsonError(res, 503, 'DATABASE_URL no configurada — pgPool no disponible');
    }

    const webhookSecret = String(process.env.STRIPE_WEBHOOK_SECRET || '').trim();
    if (!webhookSecret) {
      return jsonError(res, 503, 'STRIPE_WEBHOOK_SECRET no configurado');
    }

    if (!deps.stripeClient) {
      return jsonError(res, 503, 'Stripe no configurado en el servidor');
    }

    const signature = req.headers['stripe-signature'];
    if (!signature) {
      return jsonError(res, 400, 'Falta header stripe-signature');
    }

    const rawBody = req.rawBody ?? req.body;
    let event;
    try {
      event = deps.stripeClient.webhooks.constructEvent(
        rawBody,
        signature,
        webhookSecret,
      );
    } catch (err) {
      console.error('❌ Stripe webhook signature:', err.message);
      return jsonError(res, 400, `Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
      const result = await procesarStripeCheckoutSession(pgPool, event.data.object, deps);
      return res.status(200).json(result);
    }

    return res.status(200).json({ ok: true, received: true, type: event.type, processed: false });
  } catch (err) {
    console.error('❌ Stripe webhook:', err.message);
    return jsonError(res, err.status || 500, err.message || 'Error al procesar pago Stripe');
  }
}

export function mountStripeWebhookRoutes(app, deps) {
  const { pgPool, stripeClient, sendWhatsAppConfirmation, supabase } = deps;
  const handlerDeps = { stripeClient, sendWhatsAppConfirmation, supabase };

  app.get('/api/webhooks/stripe', (_req, res) => {
    res.status(200).json({ ok: true, service: 'stripe-webhook' });
  });

  app.post('/api/webhooks/stripe', (req, res) => {
    void handleStripeWebhook(req, res, pgPool, handlerDeps);
  });

  app.get('/api/pago-exitoso-stripe', (req, res) => {
    void handleStripePagoExitosoReadOnly(req, res, pgPool, handlerDeps);
  });

  app.post('/api/pago-exitoso-stripe', (req, res) => {
    void handleStripePagoExitosoReadOnly(req, res, pgPool, handlerDeps);
  });
}
