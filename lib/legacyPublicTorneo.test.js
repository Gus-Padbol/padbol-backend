import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractSetsGanadosFromResultado,
  mapEquipoTorneoPublicRow,
  mapPartidoTorneoPublicRow,
  splitFechaHoraPartido,
} from './dto/legacyPublic.js';

test('mapEquipoTorneoPublicRow expone jugadores, capitán y estado', () => {
  const dto = mapEquipoTorneoPublicRow({
    id: 1,
    torneo_id: 23,
    nombre: 'Los Pibes',
    jugadores: [
      { nombre: 'Ana', es_capitan: true },
      { nombre: 'Bruno' },
    ],
    inscripcion_estado: 'confirmado',
    puntos_totales: 6,
  }, 'A', 2);

  assert.equal(dto.nombre, 'Los Pibes');
  assert.equal(dto.grupo, 'A');
  assert.equal(dto.capitan_nombre, 'Ana');
  assert.equal(dto.jugadores_count, 2);
  assert.equal(dto.estado, 'confirmado');
  assert.equal(dto.posicion_final, 2);
});

test('mapPartidoTorneoPublicRow devuelve equipos como objetos y goles desde sets', () => {
  const dto = mapPartidoTorneoPublicRow({
    id: 10,
    torneo_id: 23,
    fecha_hora: '2026-06-18T20:30:00',
    estado: 'finalizado',
    grupo: 'A',
    ronda: 1,
    equipo_a_id: 1,
    equipo_b_id: 2,
    equipo_a: { id: 1, nombre: 'Los Pibes' },
    equipo_b: { id: 2, nombre: 'La Meca' },
    resultado: { set1: '6-4', set2: '3-6', set3: '7-5' },
  });

  assert.deepEqual(dto.equipo_a, { id: 1, nombre: 'Los Pibes' });
  assert.deepEqual(dto.equipo_b, { id: 2, nombre: 'La Meca' });
  assert.equal(dto.fecha, '2026-06-18');
  assert.equal(dto.hora, '20:30');
  assert.equal(dto.goles_a, 2);
  assert.equal(dto.goles_b, 1);
  assert.equal(dto.ronda, 1);
});

test('splitFechaHoraPartido usa columnas fecha/hora si existen', () => {
  assert.deepEqual(
    splitFechaHoraPartido({ fecha: '2026-06-18', hora: '20:30:00' }),
    { fecha: '2026-06-18', hora: '20:30' },
  );
});

test('extractSetsGanadosFromResultado respeta goles explícitos', () => {
  assert.deepEqual(
    extractSetsGanadosFromResultado({ goles_a: 3, goles_b: 0 }),
    { goles_a: 3, goles_b: 0 },
  );
});
