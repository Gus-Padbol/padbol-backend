import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PARTIDO_HORARIO_CONFLICTO_CODE,
  JUGADOR_HORARIO_CONFLICTO_CODE,
  buildJugadorHorarioConflictoBody,
  buildPartidoHorarioConflictoBody,
  computeSolicitudExpiresAt,
  findPartidoConHorarioSuperpuesto,
  isSolicitudExpirada,
  isSolicitudPendienteActiva,
  partidosSeSolapan,
  solicitudesSuperpuestasParaMarcarConflicto,
} from './solicitudesPartidoHorario.js';

const FECHA = '2026-07-15';

function partido(id, hora, overrides = {}) {
  return {
    id,
    fecha: FECHA,
    hora,
    duracion_minutos: 90,
    estado: 'abierto',
    ...overrides,
  };
}

function solicitud(id, partidoId, estado, createdAt, expiresAt = null) {
  return {
    id,
    partido_id: partidoId,
    solicitante_id: 'user-1',
    estado,
    created_at: createdAt,
    expires_at: expiresAt,
  };
}

describe('solicitudesPartidoHorario — solapamiento', () => {
  it('partidosSeSolapan detecta superposición parcial', () => {
    const a = partido(1, '18:00');
    const b = partido(2, '18:30');
    assert.equal(partidosSeSolapan(a, b), true);
  });

  it('partidosSeSolapan no solapa si uno termina cuando el otro empieza', () => {
    const a = partido(1, '18:00');
    const b = partido(2, '19:30');
    assert.equal(partidosSeSolapan(a, b), false);
  });

  it('findPartidoConHorarioSuperpuesto ignora cancelados/finalizados', () => {
    const target = partido(10, '19:00');
    const confirmado = partido(1, '18:30', { estado: 'completo' });
    const cancelado = partido(2, '18:00', { estado: 'cancelado' });
    const hit = findPartidoConHorarioSuperpuesto([confirmado, cancelado], target);
    assert.equal(hit?.id, 1);
  });

  it('buildPartidoHorarioConflictoBody y buildJugadorHorarioConflictoBody', () => {
    assert.equal(buildPartidoHorarioConflictoBody().code, PARTIDO_HORARIO_CONFLICTO_CODE);
    assert.equal(buildJugadorHorarioConflictoBody().code, JUGADOR_HORARIO_CONFLICTO_CODE);
  });
});

describe('solicitudesPartidoHorario — vencimiento', () => {
  it('default 4 horas desde la invitación', () => {
    const createdAt = '2026-07-10T10:00:00.000Z';
    const partidoRow = partido(1, '22:00', { fecha: '2026-07-10' });
    const expiresAt = computeSolicitudExpiresAt(createdAt, partidoRow);
    const expiresMs = new Date(expiresAt).getTime();
    const expectedMs = new Date(createdAt).getTime() + 4 * 60 * 60 * 1000;
    assert.equal(expiresMs, expectedMs);
  });

  it('vence 2 horas antes del partido si empieza dentro de las 4 horas', () => {
    const createdAt = '2026-07-15T14:30:00-03:00';
    const partidoRow = partido(1, '18:00', { fecha: '2026-07-15' });
    const expiresAt = computeSolicitudExpiresAt(createdAt, partidoRow);
    const partidoStartMs = new Date('2026-07-15T18:00:00-03:00').getTime();
    const expectedMs = partidoStartMs - 2 * 60 * 60 * 1000;
    assert.equal(new Date(expiresAt).getTime(), expectedMs);
  });

  it('invitación vencida no cuenta como pendiente activa', () => {
    const partidoRow = partido(1, '18:00');
    const createdAt = '2020-01-01T10:00:00.000Z';
    const row = solicitud('s1', 1, 'invitado', createdAt);
    assert.equal(isSolicitudExpirada(row, partidoRow, Date.now()), true);
    assert.equal(isSolicitudPendienteActiva(row, partidoRow, Date.now()), false);
  });

  it('invitación vigente sigue pendiente activa', () => {
    const partidoRow = partido(1, '22:00', { fecha: '2030-07-15' });
    const createdAt = new Date().toISOString();
    const row = solicitud('s1', 1, 'invitado', createdAt);
    assert.equal(isSolicitudPendienteActiva(row, partidoRow, Date.now()), true);
  });
});

describe('solicitudesPartidoHorario — múltiples invitaciones pendientes', () => {
  it('jugador puede tener 2 invitaciones pendientes superpuestas activas', () => {
    const p1 = partido(1, '18:00');
    const p2 = partido(2, '18:30');
    const now = Date.now();
    const s1 = solicitud('s1', 1, 'invitado', new Date(now).toISOString());
    const s2 = solicitud('s2', 2, 'pendiente', new Date(now).toISOString());

    assert.equal(isSolicitudPendienteActiva(s1, p1, now), true);
    assert.equal(isSolicitudPendienteActiva(s2, p2, now), true);
    assert.equal(partidosSeSolapan(p1, p2), true);
  });

  it('al aceptar una, marca en conflicto otras pendientes superpuestas', () => {
    const accepted = partido(1, '18:00');
    const other = partido(2, '18:30');
    const now = Date.now();
    const rows = [
      { solicitud: solicitud('s1', 1, 'invitado', new Date(now).toISOString()), partido: accepted },
      { solicitud: solicitud('s2', 2, 'pendiente', new Date(now).toISOString()), partido: other },
      { solicitud: solicitud('s3', 3, 'invitado', new Date(now).toISOString()), partido: partido(3, '21:00') },
    ];

    const conflict = solicitudesSuperpuestasParaMarcarConflicto(rows, accepted, {
      excludeSolicitudId: 's1',
      nowMs: now,
    });

    assert.equal(conflict.length, 1);
    assert.equal(conflict[0].id, 's2');
  });
});

describe('conflicto al confirmar', () => {
  it('jugador con partido confirmado superpuesto genera conflicto al buscar otro', () => {
    const confirmado = partido(1, '18:00', { estado: 'completo' });
    const nuevo = partido(2, '18:30');
    const hit = findPartidoConHorarioSuperpuesto([confirmado], nuevo, { excludePartidoId: 2 });
    assert.ok(hit);
  });

  it('capitán no debería invitar si jugador ya tiene partido superpuesto (regla de negocio)', () => {
    const confirmado = partido(1, '18:00', { estado: 'abierto' });
    const invitacion = partido(2, '18:30');
    const hit = findPartidoConHorarioSuperpuesto([confirmado], invitacion, { excludePartidoId: 2 });
    assert.ok(hit);
    assert.equal(buildJugadorHorarioConflictoBody().code, JUGADOR_HORARIO_CONFLICTO_CODE);
  });
});
