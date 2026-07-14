import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RESERVA_ADMIN_SELECT,
  RESERVA_OWNER_SELECT,
  mapMisReservaRow,
  mapReservaDetailDto,
} from './dto/reservaDto.js';
import {
  buildReservaInsertRow,
  classifyReservaWriteError,
  isReservaSlotUniqueViolation,
} from '../routes/partidos.js';

/** Columnas reales de public.reservas en producción (select * auditado Jul 2026). */
const PROD_RESERVAS_COLUMNS = new Set([
  'id',
  'sede',
  'fecha',
  'hora',
  'cancha',
  'nombre',
  'email',
  'telefono',
  'whatsapp',
  'nivel',
  'precio',
  'estado',
  'created_at',
  'recordatorio_enviado',
  'mp_payment_id',
  'mp_comprobante_url',
  'monto_pagado',
  'moneda',
  'user_id',
  'duracion_minutos',
  'tipo',
  'qr_token',
  'checkin_at',
  'checkin_by',
  'checkin_realizado',
  'pago_estado',
  'hora_inicio',
  'hora_fin',
  'cancha_id',
  'sede_id',
  'notificacion_post_partido_enviada',
  'partido_id',
  'deporte',
  'precio_esperado',
  'pricing_snapshot',
  'stripe_checkout_session_id',
  'stripe_payment_intent_id',
  'payment_provider',
  'mp_preference_id',
]);

test('RESERVA_OWNER_SELECT no pide updated_at (inexistente en prod → 42703/500)', () => {
  const cols = RESERVA_OWNER_SELECT.split(', ').map((c) => c.trim());
  assert.ok(!cols.includes('updated_at'));
  for (const col of cols) {
    assert.ok(PROD_RESERVAS_COLUMNS.has(col), `columna desconocida en prod: ${col}`);
  }
});

test('RESERVA_ADMIN_SELECT tampoco incluye updated_at', () => {
  const cols = RESERVA_ADMIN_SELECT.split(', ').map((c) => c.trim());
  assert.ok(!cols.includes('updated_at'));
  for (const col of cols) {
    assert.ok(PROD_RESERVAS_COLUMNS.has(col), `columna admin desconocida en prod: ${col}`);
  }
});

test('buildReservaInsertRow arma fila válida para reserva manual admin La Meca', () => {
  const row = buildReservaInsertRow({
    sedeNombre: 'La Meca Padbol Club',
    sedeId: 1,
    fecha: '2026-07-20',
    hora: '18:00',
    canchaText: '1',
    cancha_id: 1,
    nombre: 'Reserva Manual Test',
    email: 'manual@padbol.com',
    telefono: '5491112345678',
    whatsapp: '5491112345678',
    nivel: 'Principiante',
    precio: 0,
    estado: 'pendiente',
    pago_estado: 'pendiente',
    duracion_minutos: 90,
    user_id: '5a63f375-637c-43de-9339-cb9e8e392f5b',
  });

  assert.equal(row.sede, 'La Meca Padbol Club');
  assert.equal(row.sede_id, 1);
  assert.equal(row.fecha, '2026-07-20');
  assert.equal(row.hora_inicio, '18:00');
  assert.equal(row.hora_fin, '19:30');
  assert.equal(row.hora, '18:00 - 19:30');
  assert.equal(row.cancha, '1');
  assert.equal(row.cancha_id, 1);
  assert.equal(row.nombre, 'Reserva Manual Test');
  assert.equal(row.email, 'manual@padbol.com');
  assert.equal(row.telefono, '5491112345678');
  assert.equal(row.whatsapp, '5491112345678');
  assert.equal(row.estado, 'pendiente');
  assert.equal(row.pago_estado, 'pendiente');
  assert.equal(row.duracion_minutos, 90);
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'updated_at'));
});

test('mapMisReservaRow (respuesta POST) mapea fila sin updated_at', () => {
  const mapped = mapMisReservaRow({
    id: 42,
    sede: 'La Meca Padbol Club',
    sede_id: 1,
    fecha: '2026-07-20',
    hora: '18:00 - 19:30',
    hora_inicio: '18:00',
    hora_fin: '19:30',
    duracion_minutos: 90,
    cancha: '1',
    estado: 'pendiente',
    pago_estado: 'pendiente',
    precio: 0,
    moneda: 'ARS',
    nombre: 'Reserva Manual Test',
    nivel: 'Principiante',
    checkin_realizado: false,
    created_at: '2026-07-13T12:00:00.000Z',
  });

  assert.equal(mapped.id, 42);
  assert.equal(mapped.sede, 'La Meca Padbol Club');
  assert.equal(mapped.hora_inicio, '18:00');
  assert.equal(mapped.hora_fin, '19:30');
  assert.equal(mapped.estado, 'pendiente');
  assert.ok(!Object.prototype.hasOwnProperty.call(mapped, 'updated_at'));
});

test('mapReservaDetailDto admin usa created_at como fallback de updated_at', () => {
  const mapped = mapReservaDetailDto({
    id: 7,
    sede: 'La Meca Padbol Club',
    sede_id: 1,
    fecha: '2026-07-20',
    hora: '18:00',
    hora_inicio: '18:00',
    hora_fin: '19:30',
    duracion_minutos: 90,
    cancha: '1',
    estado: 'confirmada',
    pago_estado: 'pagado',
    precio: 1000,
    email: 'a@b.com',
    telefono: '123',
    created_at: '2026-07-13T12:00:00.000Z',
  }, { isAdmin: true });

  assert.equal(mapped.updated_at, '2026-07-13T12:00:00.000Z');
});

test('classifyReservaWriteError: unique → 409', () => {
  assert.equal(isReservaSlotUniqueViolation({ code: '23505' }), true);
  assert.deepEqual(
    classifyReservaWriteError({ code: '23505', message: 'duplicate key' }),
    { status: 409, error: 'Este horario ya está reservado' },
  );
  assert.deepEqual(
    classifyReservaWriteError({
      message: 'duplicate key value violates unique constraint "idx_reservas_slot_blocking_unique"',
    }),
    { status: 409, error: 'Este horario ya está reservado' },
  );
});

test('classifyReservaWriteError: not-null / FK / fecha → 400', () => {
  assert.deepEqual(
    classifyReservaWriteError({ code: '23502', message: 'null value in column "fecha"' }),
    { status: 400, error: 'Faltan campos obligatorios para crear la reserva' },
  );
  assert.deepEqual(
    classifyReservaWriteError({ code: '23503', message: 'foreign key' }),
    { status: 400, error: 'Referencia inválida (sede o cancha)' },
  );
  assert.deepEqual(
    classifyReservaWriteError({ code: '22007', message: 'invalid input syntax for type date' }),
    { status: 400, error: 'Formato de fecha u hora inválido' },
  );
});

test('classifyReservaWriteError: error desconocido → null (sigue 500)', () => {
  assert.equal(classifyReservaWriteError({ code: 'XX000', message: 'boom' }), null);
  assert.equal(
    classifyReservaWriteError({
      code: '42703',
      message: 'column reservas.updated_at does not exist',
    }),
    null,
  );
});

test('12-13. Reserva (normal/manual) acepta cancha custom por cancha_id sin whitelist deporte', () => {
  const row = buildReservaInsertRow({
    sedeNombre: 'La Meca Padbol Club',
    sedeId: 1,
    fecha: '2026-08-01',
    hora: '10:00',
    canchaText: '3',
    cancha_id: 99,
    nombre: 'Custom Court Booking',
    email: 'player@padbol.com',
    telefono: '1',
    whatsapp: '1',
    nivel: 'Principiante',
    precio: 0,
    estado: 'pendiente',
    pago_estado: 'pendiente',
    duracion_minutos: 90,
    user_id: '5a63f375-637c-43de-9339-cb9e8e392f5b',
  });
  assert.equal(row.cancha_id, 99);
  assert.equal(row.cancha, '3');
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'deporte'));
});
