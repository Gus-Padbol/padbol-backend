import {
  parsePositiveInt,
  resolveReservaCanchaStorageText,
} from './partidos.js';

const BLOCKING_ESTADOS = ['confirmada', 'prereserva', 'pendiente'];

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
  const hora = String(horaRaw).trim().split(' - ')[0].slice(0, 5);

  return {
    reserva_id: parsePositiveInt(src.reserva_id ?? src.id),
    sede_id: parsePositiveInt(src.sede_id ?? body.sedeId),
    sede: src.sede ? String(src.sede).trim() : (body.sedeNombre ? String(body.sedeNombre).trim() : null),
    fecha: String(src.fecha || '').trim().slice(0, 10),
    hora,
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

async function assertSlotDisponiblePg(pgPool, { sedeNombre, fecha, hora, canchaText }) {
  const { rows } = await pgPool.query(
    `SELECT id, estado FROM reservas
     WHERE sede = $1 AND fecha = $2 AND hora = $3 AND cancha = $4
       AND estado = ANY($5::text[])
     LIMIT 1`,
    [sedeNombre, fecha, hora, canchaText, BLOCKING_ESTADOS],
  );
  if (rows[0]) {
    const err = new Error('Este horario ya está reservado');
    err.status = 409;
    throw err;
  }
}

/**
 * Inserta reserva en estado pendiente antes del checkout MP.
 * Si ya viene reserva_id (p. ej. prereserva de partido), la reutiliza.
 */
export async function ensureReservaPendienteParaMpPg(pgPool, body = {}) {
  if (!pgPool) {
    const err = new Error('DATABASE_URL no configurada — pgPool no disponible');
    err.status = 503;
    throw err;
  }

  const input = normalizeCrearPreferenciaReservaInput(body);

  if (input.reserva_id) {
    const { rows } = await pgPool.query(
      `SELECT id, estado, pago_estado FROM reservas WHERE id = $1 LIMIT 1`,
      [input.reserva_id],
    );
    const existing = rows[0];
    if (!existing) {
      const err = new Error(`Reserva ${input.reserva_id} no encontrada`);
      err.status = 404;
      throw err;
    }
    const estado = String(existing.estado || '').toLowerCase();
    if (estado === 'confirmada') {
      const err = new Error('La reserva ya está confirmada');
      err.status = 409;
      throw err;
    }
    return { reserva_id: existing.id, created: false };
  }

  const sedeNombre = await resolveSedeNombrePg(pgPool, input);
  if (!sedeNombre) {
    const err = new Error('Falta sede o sede_id válido para crear la reserva');
    err.status = 400;
    throw err;
  }
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
  const duracionMinutos = computeDuracionMinutos(input.hora, input.hora_fin, input.duracion_minutos);
  const precio = parsePositiveInt(input.precio) ?? 0;
  const contacto = String(input.whatsapp || input.telefono || '').trim();

  await assertSlotDisponiblePg(pgPool, {
    sedeNombre,
    fecha: input.fecha,
    hora: input.hora,
    canchaText,
  });

  const { rows } = await pgPool.query(
    `INSERT INTO reservas (
       sede, fecha, hora, cancha, nombre, email, telefono, whatsapp,
       nivel, precio, estado, pago_estado, duracion_minutos, user_id
     ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8,
       $9, $10, 'pendiente', 'pendiente', $11, $12
     )
     RETURNING id`,
    [
      sedeNombre,
      input.fecha,
      input.hora,
      canchaText,
      input.nombre || input.email,
      input.email,
      contacto,
      contacto,
      input.nivel,
      precio,
      duracionMinutos,
      input.user_id || null,
    ],
  );

  const reservaId = rows[0]?.id;
  if (!reservaId) {
    throw new Error('No se pudo crear la reserva pendiente');
  }

  console.log(`✓ Reserva pendiente creada id=${reservaId} (${sedeNombre} ${input.fecha} ${input.hora})`);
  return { reserva_id: reservaId, created: true };
}
