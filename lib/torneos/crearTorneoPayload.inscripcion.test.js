import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrearTorneoPayload } from './crearTorneoPayload.js';

const body = {
  nombre: 'Torneo QA',
  sede_id: 7,
  deporte: 'padbol',
  formato_equipo: 'dobles',
  modalidad_plantel: 'dobles',
  fecha_inicio: '2027-03-12',
  fecha_fin: '2027-03-14',
  cantidad_equipos: 16,
  inscripcion_monto: '1500',
  cupos_maximos: '16',
  premios_descripcion: 'Trofeo y premio',
  fecha_apertura_inscripcion: '2027-01-10T12:00:00-03:00',
};

test('persiste monto, cupos, premios y apertura en el payload de alta', () => {
  const p = buildCrearTorneoPayload(body, 'actor');
  assert.equal(p.inscripcion_monto, 1500);
  assert.equal(p.cupos_maximos, 16);
  assert.equal(p.premios_descripcion, 'Trofeo y premio');
  assert.equal(p.fecha_apertura_inscripcion, '2027-01-10T15:00:00.000Z');
});

test('mantiene null cuando los campos opcionales no vienen', () => {
  const p = buildCrearTorneoPayload({ ...body, inscripcion_monto: undefined, cupos_maximos: undefined, premios_descripcion: undefined, fecha_apertura_inscripcion: undefined }, 'actor');
  assert.equal(p.inscripcion_monto, null);
  assert.equal(p.cupos_maximos, null);
  assert.equal(p.premios_descripcion, null);
  assert.equal(p.fecha_apertura_inscripcion, null);
});

test('rechaza monto negativo y capacidad inválida', () => {
  assert.throws(() => buildCrearTorneoPayload({ ...body, inscripcion_monto: -1 }, 'actor'), (e) => e.code === 'TOURNAMENT_MONEY_INVALID');
  assert.throws(() => buildCrearTorneoPayload({ ...body, cupos_maximos: 1 }, 'actor'), (e) => e.code === 'TOURNAMENT_CAPACITY_INVALID');
});
