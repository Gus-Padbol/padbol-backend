import { MercadoPagoConfig, Payment } from 'mercadopago';

/** Tolerancia mínima ARS entre monto MP y precio_esperado (redondeos MP). */
export const PAYMENT_AMOUNT_TOLERANCE = 1;

const ALLOWED_PRE_CONFIRM_ESTADOS = new Set(['pendiente', 'prereserva']);

const RESERVA_CONFIRM_SELECT = `
  id, estado, pago_estado, sede, fecha, hora, cancha, whatsapp, telefono,
  precio, precio_esperado, monto_pagado, mp_payment_id, user_id
`;

function jsonError(res, status, message, extra = {}) {
  if (res.headersSent) return;
  return res.status(status).json({ ok: false, error: message, ...extra });
}

export function parseReservaIdFromExternalReference(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return null;
  try {
    s = decodeURIComponent(s);
  } catch {
    /* keep */
  }

  if (/^\d+$/.test(s)) {
    const n = parseInt(s, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  try {
    const o = JSON.parse(s);
    if (o == null) return null;
    if (typeof o === 'number' && Number.isFinite(o) && o > 0) return o;
    if (typeof o === 'string' && /^\d+$/.test(o.trim())) return parseInt(o.trim(), 10);
    if (typeof o === 'object') {
      const candidate = o.reserva_id ?? o.id ?? o.reservaId;
      const n = parseInt(String(candidate ?? ''), 10);
      return Number.isFinite(n) && n > 0 ? n : null;
    }
  } catch {
    /* not JSON — ignore */
  }

  return null;
}

export function extractMercadoPagoPaymentId(req) {
  const q = req.query || {};
  if (String(q.topic || '').toLowerCase() === 'payment' && q.id) {
    return String(q.id).trim();
  }
  if (q.payment_id) return String(q.payment_id).trim();
  if (q.collection_id && String(q.collection_status || q.status || '').toLowerCase() === 'approved') {
    return String(q.collection_id).trim();
  }

  const b = req.body || {};
  if (String(b.type || '').toLowerCase() === 'payment' && b.data?.id != null) {
    return String(b.data.id).trim();
  }
  if (String(b.action || '').startsWith('payment.') && b.data?.id != null) {
    return String(b.data.id).trim();
  }
  if (b.payment_id != null) return String(b.payment_id).trim();

  return null;
}

function parseReservaIdFromRequest(req) {
  const q = req.query || {};
  const fromQuery = parseReservaIdFromExternalReference(
    q.external_reference ?? q.reserva_id ?? q.reservaId,
  );
  if (fromQuery) return fromQuery;
  const b = req.body || {};
  return parseReservaIdFromExternalReference(
    b.external_reference ?? b.reserva_id ?? b.reservaId,
  );
}

async function collectMpAccessTokensPg(pgPool, defaultToken) {
  const tokens = [];
  const main = String(defaultToken || process.env.MP_ACCESS_TOKEN || '').trim();
  if (main) tokens.push(main);

  if (pgPool) {
    try {
      const { rows } = await pgPool.query(
        `SELECT DISTINCT mp_access_token
         FROM sedes
         WHERE mp_access_token IS NOT NULL AND trim(mp_access_token) <> ''`,
      );
      for (const row of rows) {
        const t = String(row.mp_access_token || '').trim();
        if (t && !tokens.includes(t)) tokens.push(t);
      }
    } catch (err) {
      console.warn('⚠️ MP tokens sedes pg:', err.message);
    }
  }

  return tokens;
}

export async function fetchMercadoPagoPaymentById(paymentId, pgPool, defaultToken) {
  const id = String(paymentId || '').trim();
  if (!id) throw new Error('payment id vacío');

  const tokens = await collectMpAccessTokensPg(pgPool, defaultToken);
  if (!tokens.length) throw new Error('Ningún MP_ACCESS_TOKEN configurado');

  let lastErr;
  for (const token of tokens) {
    try {
      const client = new MercadoPagoConfig({ accessToken: token });
      const api = new Payment(client);
      const data = await api.get({ id });
      if (data?.id != null) return data;
    } catch (e) {
      lastErr = e;
    }
  }

  throw lastErr || new Error('No se pudo obtener el pago en Mercado Pago');
}

function normalizeEstado(value) {
  return String(value ?? '').trim().toLowerCase();
}

export function assertPaymentAmountCoversExpected(montoPagado, precioEsperado, tolerance = PAYMENT_AMOUNT_TOLERANCE) {
  const paid = Number(montoPagado);
  const expected = Number(precioEsperado);
  if (!Number.isFinite(expected) || expected <= 0) {
    const err = new Error('La reserva no tiene precio_esperado válido');
    err.status = 400;
    throw err;
  }
  if (!Number.isFinite(paid) || paid <= 0) {
    const err = new Error('Monto del pago inválido');
    err.status = 400;
    throw err;
  }
  if (paid + tolerance < expected) {
    const err = new Error(
      `Monto pagado insuficiente: ${paid} < precio_esperado ${expected}`,
    );
    err.status = 402;
    err.monto_pagado = paid;
    err.precio_esperado = expected;
    throw err;
  }
}

async function fetchReservaForPaymentConfirmPg(pgPool, reservaId) {
  const rid = parseInt(String(reservaId), 10);
  const { rows } = await pgPool.query(
    `SELECT ${RESERVA_CONFIRM_SELECT} FROM reservas WHERE id = $1`,
    [rid],
  );
  return rows[0] ?? null;
}

async function assertMpPaymentIdNotUsedOnOtherReservaPg(pgPool, mpPaymentId, reservaId) {
  if (!mpPaymentId) return null;

  let rows;
  try {
    ({ rows } = await pgPool.query(
      `SELECT id, estado, pago_estado FROM reservas
       WHERE mp_payment_id = $1 AND id <> $2
       LIMIT 1`,
      [mpPaymentId, reservaId],
    ));
  } catch (err) {
    if (!/mp_payment_id|colum|column/i.test(String(err.message || ''))) throw err;
    return null;
  }

  if (rows[0]) {
    const err = new Error(`El pago MP ${mpPaymentId} ya fue usado en la reserva ${rows[0].id}`);
    err.status = 409;
    err.code = 'MP_PAYMENT_ID_ALREADY_USED';
    throw err;
  }
  return null;
}

/**
 * Valida pago MP + reserva antes de confirmar. No muta DB.
 */
export async function validateVerifiedPaymentForReserva(pgPool, payment) {
  if (!pgPool) {
    const err = new Error('DATABASE_URL no configurada — pgPool no disponible');
    err.status = 503;
    throw err;
  }

  const status = String(payment?.status || '').toLowerCase();
  if (status !== 'approved') {
    const err = new Error(status ? `Pago en estado ${status}` : 'Estado de pago desconocido');
    err.status = 400;
    err.payment_status = status;
    throw err;
  }

  const reservaId = parseReservaIdFromExternalReference(payment.external_reference);
  if (!reservaId) {
    const err = new Error('external_reference vacío o no es un reserva_id válido');
    err.status = 400;
    throw err;
  }

  const mpPaymentId = payment?.id != null ? String(payment.id).trim() : null;
  if (!mpPaymentId) {
    const err = new Error('Pago MP sin id');
    err.status = 400;
    throw err;
  }

  const montoPagado = payment.transaction_amount != null
    ? Number(payment.transaction_amount)
    : null;

  const reserva = await fetchReservaForPaymentConfirmPg(pgPool, reservaId);
  if (!reserva) {
    const err = new Error(`Reserva ${reservaId} no encontrada`);
    err.status = 404;
    throw err;
  }

  const estado = normalizeEstado(reserva.estado);
  const pagoEstado = normalizeEstado(reserva.pago_estado);

  if (estado === 'confirmada' && pagoEstado === 'pagado') {
    if (reserva.mp_payment_id && String(reserva.mp_payment_id) !== mpPaymentId) {
      const err = new Error('La reserva ya está confirmada con otro pago');
      err.status = 409;
      throw err;
    }
    return {
      reservaId,
      reserva,
      montoPagado,
      mpPaymentId,
      already: true,
    };
  }

  if (!ALLOWED_PRE_CONFIRM_ESTADOS.has(estado)) {
    const err = new Error(`Estado de reserva no válido para confirmar pago: ${estado || 'desconocido'}`);
    err.status = 400;
    throw err;
  }

  if (reserva.precio_esperado == null || Number(reserva.precio_esperado) <= 0) {
    const err = new Error('La reserva no tiene precio_esperado — crear checkout con crear-preferencia');
    err.status = 400;
    throw err;
  }

  assertPaymentAmountCoversExpected(montoPagado, reserva.precio_esperado);
  await assertMpPaymentIdNotUsedOnOtherReservaPg(pgPool, mpPaymentId, reservaId);

  return {
    reservaId,
    reserva,
    montoPagado,
    mpPaymentId,
    already: false,
  };
}

/**
 * Confirma reserva con datos ya verificados. Único punto de UPDATE a confirmada/pagado vía MP.
 */
export async function confirmReservaAfterVerifiedPayment(pgPool, {
  reservaId,
  montoPagado,
  mpPaymentId,
}) {
  if (!pgPool) {
    const err = new Error('DATABASE_URL no configurada — pgPool no disponible');
    err.status = 503;
    throw err;
  }

  const rid = parseInt(String(reservaId), 10);
  if (!Number.isFinite(rid) || rid <= 0) {
    const err = new Error('reserva_id inválido');
    err.status = 400;
    throw err;
  }

  const monto = Number(montoPagado);
  const pid = String(mpPaymentId || '').trim();
  if (!pid) {
    const err = new Error('mp_payment_id requerido');
    err.status = 400;
    throw err;
  }

  let updatedRows;
  try {
    ({ rows: updatedRows } = await pgPool.query(
      `UPDATE reservas
       SET estado = 'confirmada',
           pago_estado = 'pagado',
           monto_pagado = $2::numeric,
           mp_payment_id = $3
       WHERE id = $1
         AND lower(trim(estado)) IN ('pendiente', 'prereserva')
       RETURNING ${RESERVA_CONFIRM_SELECT}`,
      [rid, Number.isFinite(monto) ? monto : null, pid],
    ));
  } catch (updateErr) {
    if (!/mp_payment_id|colum|column/i.test(String(updateErr.message || ''))) throw updateErr;
    ({ rows: updatedRows } = await pgPool.query(
      `UPDATE reservas
       SET estado = 'confirmada',
           pago_estado = 'pagado',
           monto_pagado = $2::numeric
       WHERE id = $1
         AND lower(trim(estado)) IN ('pendiente', 'prereserva')
       RETURNING id, estado, pago_estado, sede, fecha, hora, cancha, whatsapp, telefono,
                 precio, precio_esperado, monto_pagado, user_id`,
      [rid, Number.isFinite(monto) ? monto : null],
    ));
  }

  if (updatedRows[0]) {
    return { reserva: updatedRows[0], already: false };
  }

  const existing = await fetchReservaForPaymentConfirmPg(pgPool, rid);
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

/** @deprecated Usar confirmReservaAfterVerifiedPayment + validateVerifiedPaymentForReserva */
export async function confirmarReservaPorPagoPg(pgPool, reservaId, payment) {
  const validated = await validateVerifiedPaymentForReserva(pgPool, payment);
  if (validated.already) {
    return { reserva: validated.reserva, already: true };
  }
  return confirmReservaAfterVerifiedPayment(pgPool, {
    reservaId: validated.reservaId,
    montoPagado: validated.montoPagado,
    mpPaymentId: validated.mpPaymentId,
  });
}

export async function procesarPagoMercadoPago(pgPool, paymentId, deps = {}) {
  const payment = await fetchMercadoPagoPaymentById(paymentId, pgPool, deps.defaultMpToken);
  const pid = String(payment?.id ?? paymentId);
  const status = String(payment?.status || '').toLowerCase();

  if (status !== 'approved') {
    return {
      ok: true,
      processed: false,
      payment_id: pid,
      status,
      message: status ? `Pago en estado ${status} — sin confirmar reserva` : 'Estado de pago desconocido',
    };
  }

  const validated = await validateVerifiedPaymentForReserva(pgPool, payment);

  if (validated.already) {
    return {
      ok: true,
      processed: true,
      payment_id: pid,
      reserva_id: validated.reservaId,
      already: true,
      reserva: validated.reserva,
      confirmed: true,
    };
  }

  const { reserva, already } = await confirmReservaAfterVerifiedPayment(pgPool, {
    reservaId: validated.reservaId,
    montoPagado: validated.montoPagado,
    mpPaymentId: validated.mpPaymentId,
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
      }).catch((err) => console.warn('⚠️ WhatsApp confirmación MP:', err.message));
    }
  }

  console.log(`✓ MP pago ${pid} → reserva ${validated.reservaId} confirmada${already ? ' (ya estaba)' : ''}`);

  return {
    ok: true,
    processed: true,
    payment_id: pid,
    reserva_id: validated.reservaId,
    already,
    reserva,
    confirmed: true,
  };
}

function buildPagoExitosoReadResponse({ reserva, reservaId, payment, paymentId, paymentStatus }) {
  const estado = normalizeEstado(reserva?.estado);
  const pagoEstado = normalizeEstado(reserva?.pago_estado);
  const confirmed = estado === 'confirmada' && pagoEstado === 'pagado';

  return {
    ok: true,
    read_only: true,
    confirmed,
    reserva_id: reservaId ?? reserva?.id ?? null,
    estado: reserva?.estado ?? null,
    pago_estado: reserva?.pago_estado ?? null,
    mp_payment_id: reserva?.mp_payment_id ?? null,
    payment_id: paymentId ?? (payment?.id != null ? String(payment.id) : null),
    payment_status: paymentStatus ?? (payment?.status ? String(payment.status) : null),
    message: confirmed
      ? 'Reserva confirmada por webhook de Mercado Pago'
      : 'Pago pendiente de confirmación — esperá unos segundos o revisá el estado de la reserva',
  };
}

/** GET/POST /api/pago-exitoso — solo lectura; no confirma reservas. */
async function handlePagoExitosoReadOnly(req, res, pgPool, deps) {
  try {
    console.log('[PAGO-EXITOSO] query params:', JSON.stringify(req.query));

    if (!pgPool) {
      return jsonError(res, 503, 'DATABASE_URL no configurada — pgPool no disponible');
    }

    const paymentId = extractMercadoPagoPaymentId(req)
      ?? (req.query?.payment_id ? String(req.query.payment_id).trim() : null)
      ?? (req.query?.collection_id ? String(req.query.collection_id).trim() : null);

    let reservaId = parseReservaIdFromRequest(req);
    let payment = null;
    let paymentStatus = null;

    if (paymentId) {
      try {
        payment = await fetchMercadoPagoPaymentById(paymentId, pgPool, deps.defaultMpToken);
        paymentStatus = String(payment?.status || '').toLowerCase();
        if (!reservaId) {
          reservaId = parseReservaIdFromExternalReference(payment.external_reference);
        }
      } catch (fetchErr) {
        console.warn('[PAGO-EXITOSO] no se pudo leer pago MP:', fetchErr.message);
      }
    }

    if (!reservaId) {
      return res.status(400).json({
        ok: false,
        read_only: true,
        error: 'Falta reserva_id o payment_id con external_reference válido',
      });
    }

    const reserva = await fetchReservaForPaymentConfirmPg(pgPool, reservaId);
    if (!reserva) {
      return res.status(404).json({
        ok: false,
        read_only: true,
        error: `Reserva ${reservaId} no encontrada`,
      });
    }

    return res.status(200).json(buildPagoExitosoReadResponse({
      reserva,
      reservaId,
      payment,
      paymentId,
      paymentStatus,
    }));
  } catch (err) {
    console.error('[PAGO-EXITOSO] error:', err?.message);
    return jsonError(res, err.status || 500, err.message || 'Error al consultar estado de pago');
  }
}

async function handleMercadoPagoWebhook(req, res, pgPool, deps) {
  try {
    if (!pgPool) {
      return jsonError(res, 503, 'DATABASE_URL no configurada — pgPool no disponible');
    }

    const paymentId = extractMercadoPagoPaymentId(req)
      ?? (req.query?.payment_id ? String(req.query.payment_id).trim() : null)
      ?? (req.query?.collection_id ? String(req.query.collection_id).trim() : null);

    if (!paymentId) {
      return res.status(400).json({
        ok: false,
        error: 'Falta payment_id (topic=payment&id=…, payment_id o collection_id)',
      });
    }

    const result = await procesarPagoMercadoPago(pgPool, paymentId, deps);
    return res.status(200).json(result);
  } catch (err) {
    console.error('❌ MP webhook:', err.message);
    return jsonError(res, err.status || 500, err.message || 'Error al procesar pago');
  }
}

export function mountMercadoPagoWebhookRoutes(app, deps) {
  const { pgPool, sendWhatsAppConfirmation, supabase, defaultMpToken } = deps;
  const handlerDeps = { sendWhatsAppConfirmation, supabase, defaultMpToken };

  /** Validación URL en panel MP — siempre JSON */
  app.get('/api/webhooks/mercadopago', (_req, res) => {
    res.status(200).json({ ok: true, service: 'mercadopago-webhook' });
  });

  /** Notificación IPN de Mercado Pago — único endpoint que confirma reservas */
  app.post('/api/webhooks/mercadopago', (req, res) => {
    void handleMercadoPagoWebhook(req, res, pgPool, handlerDeps);
  });

  /**
   * Retorno del checkout — solo lectura (poll de confirmación vía webhook).
   * Query: payment_id, collection_id, external_reference, reserva_id
   */
  app.get('/api/pago-exitoso', (req, res) => {
    void handlePagoExitosoReadOnly(req, res, pgPool, handlerDeps);
  });

  app.post('/api/pago-exitoso', (req, res) => {
    void handlePagoExitosoReadOnly(req, res, pgPool, handlerDeps);
  });
}
