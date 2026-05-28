import { MercadoPagoConfig, Payment } from 'mercadopago';

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

export async function confirmarReservaPorPagoPg(pgPool, reservaId, payment) {
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

  const monto = payment?.transaction_amount != null
    ? Number(payment.transaction_amount)
    : null;
  const mpPaymentId = payment?.id != null ? String(payment.id).trim() : null;

  const { rows: existingRows } = await pgPool.query(
    'SELECT id, estado, pago_estado, sede, fecha, hora, cancha, whatsapp, telefono, precio, mp_payment_id FROM reservas WHERE id = $1',
    [rid],
  );
  const existing = existingRows[0];
  if (!existing) {
    const err = new Error(`Reserva ${rid} no encontrada`);
    err.status = 404;
    throw err;
  }

  if (String(existing.estado || '').toLowerCase() === 'confirmada'
    && String(existing.pago_estado || '').toLowerCase() === 'pagado') {
    if (mpPaymentId && !existing.mp_payment_id) {
      await pgPool.query(
        'UPDATE reservas SET mp_payment_id = $2 WHERE id = $1',
        [rid, mpPaymentId],
      ).catch((err) => {
        if (!/mp_payment_id|colum|column/i.test(String(err.message || ''))) throw err;
      });
    }
    return { reserva: existing, already: true };
  }

  let updatedRows;
  try {
    ({ rows: updatedRows } = await pgPool.query(
      `UPDATE reservas
       SET estado = 'confirmada',
           pago_estado = 'pagado',
           monto_pagado = COALESCE($2::numeric, monto_pagado, precio),
           mp_payment_id = COALESCE($3, mp_payment_id)
       WHERE id = $1
       RETURNING id, estado, pago_estado, monto_pagado, mp_payment_id, sede, fecha, hora, cancha, whatsapp, telefono, precio, user_id`,
      [rid, Number.isFinite(monto) ? monto : null, mpPaymentId],
    ));
  } catch (updateErr) {
    if (!/mp_payment_id|colum|column/i.test(String(updateErr.message || ''))) throw updateErr;
    ({ rows: updatedRows } = await pgPool.query(
      `UPDATE reservas
       SET estado = 'confirmada',
           pago_estado = 'pagado',
           monto_pagado = COALESCE($2::numeric, monto_pagado, precio)
       WHERE id = $1
       RETURNING id, estado, pago_estado, monto_pagado, sede, fecha, hora, cancha, whatsapp, telefono, precio, user_id`,
      [rid, Number.isFinite(monto) ? monto : null],
    ));
  }

  return { reserva: updatedRows[0] ?? existing, already: false };
}

export async function procesarPagoMercadoPago(pgPool, paymentId, deps = {}) {
  const payment = await fetchMercadoPagoPaymentById(paymentId, pgPool, deps.defaultMpToken);
  const pid = String(payment?.id ?? paymentId);
  const status = String(payment?.status || '').toLowerCase();

  if (deps.logTag === 'PAGO-EXITOSO') {
    console.log('[PAGO-EXITOSO] MP status:', payment?.status, 'external_reference:', payment?.external_reference);
  }

  if (!['approved'].includes(status)) {
    return {
      ok: true,
      processed: false,
      payment_id: pid,
      status,
      message: status ? `Pago en estado ${status} — sin confirmar reserva` : 'Estado de pago desconocido',
    };
  }

  const reservaId = parseReservaIdFromExternalReference(payment.external_reference);
  if (!reservaId) {
    const err = new Error('external_reference vacío o no es un reserva_id válido');
    err.status = 400;
    throw err;
  }

  const { reserva, already } = await confirmarReservaPorPagoPg(pgPool, reservaId, payment);

  if (deps.logTag === 'PAGO-EXITOSO') {
    console.log('[PAGO-EXITOSO] reserva actualizada:', reservaId);
  }

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

  console.log(`✓ MP pago ${pid} → reserva ${reservaId} confirmada${already ? ' (ya estaba)' : ''}`);

  return {
    ok: true,
    processed: true,
    payment_id: pid,
    reserva_id: reservaId,
    already,
    reserva,
  };
}

async function handleMercadoPagoReturnOrWebhook(req, res, pgPool, deps, options = {}) {
  const logTag = options.logTag || null;
  try {
    if (logTag === 'PAGO-EXITOSO') {
      console.log('[PAGO-EXITOSO] query params:', JSON.stringify(req.query));
    }

    if (!pgPool) {
      return jsonError(res, 503, 'DATABASE_URL no configurada — pgPool no disponible');
    }

    const paymentId = extractMercadoPagoPaymentId(req);
    const pid = paymentId
      ?? (req.query?.payment_id ? String(req.query.payment_id).trim() : null)
      ?? (req.query?.collection_id ? String(req.query.collection_id).trim() : null);

    if (logTag === 'PAGO-EXITOSO') {
      console.log('[PAGO-EXITOSO] payment_id:', pid);
    }

    if (!pid) {
      return res.status(400).json({
        ok: false,
        error: 'Falta payment_id (topic=payment&id=…, payment_id o collection_id)',
      });
    }

    const result = await procesarPagoMercadoPago(pgPool, pid, { ...deps, logTag });
    return res.status(200).json(result);
  } catch (err) {
    if (logTag === 'PAGO-EXITOSO') {
      console.error('[PAGO-EXITOSO] error:', err?.message);
    } else {
      console.error('❌ MP pago/retorno:', err.message);
    }
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

  /** Notificación IPN de Mercado Pago */
  app.post('/api/webhooks/mercadopago', (req, res) => {
    void handleMercadoPagoReturnOrWebhook(req, res, pgPool, handlerDeps);
  });

  /**
   * Retorno del checkout (redirect) — el cliente puede consultar confirmación vía API JSON
   * Query: payment_id, collection_id, external_reference, status, collection_status
   */
  app.get('/api/pago-exitoso', (req, res) => {
    void handleMercadoPagoReturnOrWebhook(req, res, pgPool, handlerDeps, { logTag: 'PAGO-EXITOSO' });
  });

  app.post('/api/pago-exitoso', (req, res) => {
    void handleMercadoPagoReturnOrWebhook(req, res, pgPool, handlerDeps);
  });
}
