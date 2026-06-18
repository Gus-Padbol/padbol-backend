import {
  parsePositiveInt,
  resolveReservaCanchaStorageText,
  normalizeHoraInicioReserva,
  computeHoraFinDesdeDuracion,
  reservaLegacyHoraText,
  BLOCKING_RESERVA_ESTADOS,
  isReservaSlotUniqueViolation,
} from './partidos.js';
import { sqlReservaHoraInicio, sqlReservaSedeMatch } from '../utils/reservasColumns.js';

function throwReservaSlotConflictError() {
  const err = new Error('Este horario ya está reservado');
  err.status = 409;
  throw err;
}

export function normalizeCrearPreferenciaReservaInput(body = {}) {
  const rd = body.reservaData && typeof body.reservaData === 'object' ? body.reservaData : {};
  const src = { ...rd };

  const topLevelKeys = [
    'cancha_id',
    'sede_id',
    'fecha',
    'hora_inicio',
    'hora_fin',
    'hora',
    'user_id',
    'precio',
    'deporte',
    'duracion_minutos',
    'duracion',
    'nombre',
    'email',
    'whatsapp',
    'telefono',
    'nivel',
    'cancha',
    'sede',
    'reserva_id',
    'id',
  ];

  for (const key of topLevelKeys) {
    if (body[key] != null && body[key] !== '') {
      src[key] = body[key];
    }
  }

  if (body.sedeId != null && body.sedeId !== '') {
    src.sede_id = src.sede_id ?? body.sedeId;
  }
  if (body.sedeNombre && !src.sede) {
    src.sede = body.sedeNombre;
  }

  const horaRaw = src.hora_inicio ?? src.hora ?? '';
  const hora = normalizeHoraInicioReserva(horaRaw);

  return {
    reserva_id: parsePositiveInt(src.reserva_id ?? src.id),
    sede_id: parsePositiveInt(src.sede_id ?? body.sedeId),
    sede: src.sede ? String(src.sede).trim() : (body.sedeNombre ? String(body.sedeNombre).trim() : null),
    fecha: String(src.fecha || '').trim().slice(0, 10),
    hora,
    hora_inicio: hora,
    hora_fin: src.hora_fin ? String(src.hora_fin).trim().slice(0, 5) : null,
    cancha_id: parsePositiveInt(src.cancha_id),
    cancha: src.cancha,
    user_id: src.user_id ?? null,
    precio: src.precio ?? body.precio,
    deporte: src.deporte ? String(src.deporte).trim().toLowerCase() : null,
    duracion_minutos: parsePositiveInt(src.duracion_minutos ?? src.duracion),
    nombre: src.nombre ? String(src.nombre).trim() : null,
    email: src.email ? String(src.email).trim().toLowerCase() : null,
    whatsapp: src.whatsapp ?? src.telefono ?? null,
    telefono: src.telefono ?? src.whatsapp ?? null,
    nivel: src.nivel ? String(src.nivel).trim() : 'Principiante',
  };
}

function computeDuracionMinutos(horaInicio, horaFin, fallback = 90) {
  const explicit = parsePositiveInt(fallback);
  if (horaFin && horaInicio) {
    const [h1, m1] = String(horaInicio).slice(0, 5).split(':').map(Number);
    const [h2, m2] = String(horaFin).slice(0, 5).split(':').map(Number);
    if ([h1, m1, h2, m2].every(Number.isFinite)) {
      const diff = (h2 * 60 + m2) - (h1 * 60 + m1);
      if (diff > 0) return diff;
    }
  }
  return explicit && explicit > 0 ? explicit : 90;
}

async function resolveSedeNombrePg(pgPool, { sede_id, sede }) {
  if (sede) return String(sede).trim();
  const sid = parsePositiveInt(sede_id);
  if (!sid || !pgPool) return null;
  const { rows } = await pgPool.query('SELECT nombre FROM sedes WHERE id = $1 LIMIT 1', [sid]);
  return rows[0]?.nombre ? String(rows[0].nombre).trim() : null;
}

async function resolveSedeIdPg(pgPool, { sede_id, sedeNombre }) {
  const sid = parsePositiveInt(sede_id);
  if (sid != null) return sid;
  if (!sedeNombre || !pgPool) return null;
  const { rows } = await pgPool.query(
    'SELECT id FROM sedes WHERE lower(trim(nombre)) = lower(trim($1)) LIMIT 1',
    [sedeNombre],
  );
  return rows[0]?.id != null ? Number(rows[0].id) : null;
}

async function assertSlotDisponiblePg(pgPool, { sedeNombre, sedeId, fecha, horaInicio, canchaText }) {
  const hi = normalizeHoraInicioReserva(horaInicio);
  const horaExpr = sqlReservaHoraInicio('');
  const sedeExpr = sqlReservaSedeMatch('', '$1', '$2');

  const { rows } = await pgPool.query(
    `SELECT id, estado FROM reservas
     WHERE ${sedeExpr}
       AND fecha = $3
       AND left(${horaExpr}, 5) = $4
       AND cancha = $5
       AND estado = ANY($6::text[])
     LIMIT 1`,
    [sedeId ?? null, sedeNombre, fecha, hi, canchaText, BLOCKING_RESERVA_ESTADOS],
  );
  if (rows[0]) {
    const err = new Error('Este horario ya está reservado');
    err.status = 409;
    throw err;
  }
}

async function persistReservaPricingPg(pgPool, reservaId, {
  precio,
  precio_esperado,
  moneda,
  pricing_snapshot,
  user_id,
  payment_provider,
  stripe_checkout_session_id,
}) {
  const snapshotJson = pricing_snapshot ? JSON.stringify(pricing_snapshot) : null;
  try {
    await pgPool.query(
      `UPDATE reservas
       SET precio = COALESCE($2, precio),
           precio_esperado = $3,
           moneda = COALESCE($4, moneda, 'ARS'),
           pricing_snapshot = $5::jsonb,
           user_id = COALESCE($6, user_id),
           payment_provider = COALESCE($7, payment_provider),
           stripe_checkout_session_id = COALESCE($8, stripe_checkout_session_id)
       WHERE id = $1`,
      [
        reservaId,
        precio,
        precio_esperado,
        moneda,
        snapshotJson,
        user_id ?? null,
        payment_provider ?? null,
        stripe_checkout_session_id ?? null,
      ],
    );
  } catch (err) {
    if (!/precio_esperado|pricing_snapshot|payment_provider|stripe_checkout|colum|column/i.test(String(err.message || ''))) {
      throw err;
    }
    await pgPool.query(
      `UPDATE reservas
       SET precio = COALESCE($2, precio),
           user_id = COALESCE($3, user_id)
       WHERE id = $1`,
      [reservaId, precio, user_id ?? null],
    );
  }
}

export async function persistStripeCheckoutSessionPg(pgPool, reservaId, sessionId, {
  payment_provider = 'stripe',
} = {}) {
  if (!pgPool || !reservaId || !sessionId) return;
  try {
    await pgPool.query(
      `UPDATE reservas
       SET stripe_checkout_session_id = $2,
           payment_provider = COALESCE($3, payment_provider, 'stripe')
       WHERE id = $1`,
      [reservaId, String(sessionId), payment_provider],
    );
  } catch (err) {
    if (!/stripe_checkout|payment_provider|colum|column/i.test(String(err.message || ''))) throw err;
  }
}

/**
 * Inserta reserva en estado pendiente antes del checkout MP.
 * Si ya viene reserva_id (p. ej. prereserva de partido), la reutiliza.
 */
export async function ensureReservaPendienteParaMpPg(pgPool, body = {}, options = {}) {
  if (!pgPool) {
    const err = new Error('DATABASE_URL no configurada — pgPool no disponible');
    err.status = 503;
    throw err;
  }

  const input = normalizeCrearPreferenciaReservaInput(body);
  const authUser = options.authUser ?? null;
  const quote = options.quote ?? null;
  const paymentProvider = options.paymentProvider ?? null;
  const authUserId = authUser?.id ? String(authUser.id) : null;
  const authEmail = authUser?.email ? String(authUser.email).trim().toLowerCase() : null;

  if (authUserId) {
    input.user_id = authUserId;
  }
  if (authEmail && !input.email) {
    input.email = authEmail;
  }
  if (authUser?.user_metadata?.full_name && !input.nombre) {
    input.nombre = String(authUser.user_metadata.full_name).trim();
  }

  const serverPrecio = quote?.total != null ? Math.round(Number(quote.total)) : null;
  const serverMoneda = quote?.moneda ?? 'ARS';

  if (input.reserva_id) {
    const { rows } = await pgPool.query(
      `SELECT id, estado, pago_estado, user_id, email FROM reservas WHERE id = $1 LIMIT 1`,
      [input.reserva_id],
    );
    const existing = rows[0];
    if (!existing) {
      const err = new Error(`Reserva ${input.reserva_id} no encontrada`);
      err.status = 404;
      throw err;
    }
    if (authUserId) {
      const ownerOk = (existing.user_id && String(existing.user_id) === authUserId)
        || (authEmail && existing.email && String(existing.email).trim().toLowerCase() === authEmail);
      if (!ownerOk) {
        const err = new Error('No tenés permiso para pagar esta reserva');
        err.status = 403;
        throw err;
      }
    }
    const estado = String(existing.estado || '').toLowerCase();
    if (estado === 'confirmada') {
      const err = new Error('La reserva ya está confirmada');
      err.status = 409;
      throw err;
    }
    if (serverPrecio != null) {
      await persistReservaPricingPg(pgPool, existing.id, {
        precio: serverPrecio,
        precio_esperado: serverPrecio,
        moneda: serverMoneda,
        pricing_snapshot: quote?.pricing_snapshot ?? null,
        user_id: authUserId,
        payment_provider: paymentProvider,
      });
    }
    return { reserva_id: existing.id, created: false };
  }

  const sedeNombre = await resolveSedeNombrePg(pgPool, input);
  if (!sedeNombre) {
    const err = new Error('Falta sede o sede_id válido para crear la reserva');
    err.status = 400;
    throw err;
  }
  const sedeId = await resolveSedeIdPg(pgPool, { sede_id: input.sede_id, sedeNombre });

  if (!input.fecha || !input.hora) {
    const err = new Error('Faltan fecha y hora para crear la reserva');
    err.status = 400;
    throw err;
  }
  if (!input.email) {
    const err = new Error('Falta email para crear la reserva');
    err.status = 400;
    throw err;
  }

  const canchaText = resolveReservaCanchaStorageText({
    cancha: input.cancha,
    cancha_id: input.cancha_id,
  });
  const horaInicio = normalizeHoraInicioReserva(input.hora_inicio ?? input.hora);
  const duracionMinutos = computeDuracionMinutos(horaInicio, input.hora_fin, input.duracion_minutos);
  const horaFin = input.hora_fin
    ? String(input.hora_fin).trim().slice(0, 5)
    : computeHoraFinDesdeDuracion(horaInicio, duracionMinutos);
  const horaLegacy = reservaLegacyHoraText(horaInicio, horaFin);
  const precio = serverPrecio ?? parsePositiveInt(input.precio) ?? 0;
  const contacto = String(input.whatsapp || input.telefono || '').trim();

  await assertSlotDisponiblePg(pgPool, {
    sedeNombre,
    sedeId,
    fecha: input.fecha,
    horaInicio,
    canchaText,
  });

  let reservaId;
  try {
    const insertWithPricing = paymentProvider
      ? `INSERT INTO reservas (
           sede, sede_id, fecha, hora, hora_inicio, hora_fin, cancha, cancha_id,
           nombre, email, telefono, whatsapp,
           nivel, precio, precio_esperado, moneda, pricing_snapshot, payment_provider,
           estado, pago_estado, duracion_minutos, user_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15, $16, $17::jsonb, $18,
           'pendiente', 'pendiente', $19, $20
         )
         RETURNING id`
      : `INSERT INTO reservas (
           sede, sede_id, fecha, hora, hora_inicio, hora_fin, cancha, cancha_id,
           nombre, email, telefono, whatsapp,
           nivel, precio, precio_esperado, moneda, pricing_snapshot,
           estado, pago_estado, duracion_minutos, user_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, $15, $16, $17::jsonb,
           'pendiente', 'pendiente', $18, $19
         )
         RETURNING id`;

    const insertParams = paymentProvider
      ? [
        sedeNombre,
        sedeId,
        input.fecha,
        horaLegacy,
        horaInicio,
        horaFin,
        canchaText,
        input.cancha_id ?? null,
        input.nombre || input.email,
        input.email,
        contacto,
        contacto,
        input.nivel,
        precio,
        serverPrecio ?? precio,
        serverMoneda,
        quote?.pricing_snapshot ? JSON.stringify(quote.pricing_snapshot) : null,
        paymentProvider,
        duracionMinutos,
        authUserId || input.user_id || null,
      ]
      : [
        sedeNombre,
        sedeId,
        input.fecha,
        horaLegacy,
        horaInicio,
        horaFin,
        canchaText,
        input.cancha_id ?? null,
        input.nombre || input.email,
        input.email,
        contacto,
        contacto,
        input.nivel,
        precio,
        serverPrecio ?? precio,
        serverMoneda,
        quote?.pricing_snapshot ? JSON.stringify(quote.pricing_snapshot) : null,
        duracionMinutos,
        authUserId || input.user_id || null,
      ];

    const { rows } = await pgPool.query(insertWithPricing, insertParams);
    reservaId = rows[0]?.id;
  } catch (insertErr) {
    if (isReservaSlotUniqueViolation(insertErr)) {
      throwReservaSlotConflictError();
    }
    if (!/precio_esperado|pricing_snapshot|colum|column/i.test(String(insertErr.message || ''))) {
      throw insertErr;
    }
    try {
      const { rows } = await pgPool.query(
        `INSERT INTO reservas (
           sede, sede_id, fecha, hora, hora_inicio, hora_fin, cancha, cancha_id,
           nombre, email, telefono, whatsapp,
           nivel, precio, estado, pago_estado, duracion_minutos, user_id
         ) VALUES (
           $1, $2, $3, $4, $5, $6, $7, $8,
           $9, $10, $11, $12,
           $13, $14, 'pendiente', 'pendiente', $15, $16
         )
         RETURNING id`,
        [
          sedeNombre,
          sedeId,
          input.fecha,
          horaLegacy,
          horaInicio,
          horaFin,
          canchaText,
          input.cancha_id ?? null,
          input.nombre || input.email,
          input.email,
          contacto,
          contacto,
          input.nivel,
          precio,
          duracionMinutos,
          authUserId || input.user_id || null,
        ],
      );
      reservaId = rows[0]?.id;
    } catch (fallbackErr) {
      if (isReservaSlotUniqueViolation(fallbackErr)) {
        throwReservaSlotConflictError();
      }
      throw fallbackErr;
    }
  }
  if (!reservaId) {
    throw new Error('No se pudo crear la reserva pendiente');
  }

  console.log(`✓ Reserva pendiente creada id=${reservaId} (${sedeNombre} ${input.fecha} ${horaInicio}-${horaFin})`);
  return { reserva_id: reservaId, created: true };
}
