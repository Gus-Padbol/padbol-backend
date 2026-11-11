import test from 'node:test';
import assert from 'node:assert/strict';
import {decidirPayloadEquipos} from './torneoEquiposRead.js';

const result = [{id: 20, nombre: 'A', jugadores: [{nombre: 'Privado'}], grupo: 'A', posicion: 1},
                {id: 21, nombre: 'B', jugadores: [{nombre: 'Otro'}], grupo: 'B', posicion: 2}];

test('torneo normal (sin audiencia, gate normal): lista completa', () => {
  const out = decidirPayloadEquipos({result, audience: null, enrollmentAdmin: false, gate: {reason: 'normal', allowed: true}, capitanIds: []});
  assert.equal(out.length, 2); assert.equal(out[0].jugadores.length, 1);
});

test('público revelado (reason revealed): lista completa', () => {
  const out = decidirPayloadEquipos({result, audience: null, enrollmentAdmin: false, gate: {reason: 'revealed', allowed: true}, capitanIds: []});
  assert.equal(out.length, 2);
});

test('sellado: sin equipos', () => {
  assert.deepEqual(decidirPayloadEquipos({result, audience: null, enrollmentAdmin: false, gate: {reason: 'sealed', allowed: false}, capitanIds: []}), []);
});

test('capitán sin audiencia: solo sus equipos', () => {
  const out = decidirPayloadEquipos({result, audience: null, enrollmentAdmin: false, gate: {reason: 'captain', allowed: true}, capitanIds: [21]});
  assert.deepEqual(out.map((e) => e.id), [21]);
});

test('admin: lista completa', () => {
  const out = decidirPayloadEquipos({result, audience: null, enrollmentAdmin: true, gate: {reason: 'admin', allowed: true}, capitanIds: []});
  assert.equal(out.length, 2);
});

test('audiencia Nations no admin: proyección mínima y solo revelado/capitán', () => {
  const oculto = decidirPayloadEquipos({result, audience: {admin: false, captainIds: [], revealed: false}, enrollmentAdmin: false, gate: null, capitanIds: []});
  assert.deepEqual(oculto, []);
  const propio = decidirPayloadEquipos({result, audience: {admin: false, captainIds: [20], revealed: false}, enrollmentAdmin: false, gate: null, capitanIds: []});
  assert.equal(propiO_(propio), true);
  function propiO_(p) { return p.length === 1 && p[0].id === 20 && p[0].jugadores.length === 1; }
  const publico = decidirPayloadEquipos({result, audience: {admin: false, captainIds: [], revealed: true}, enrollmentAdmin: false, gate: null, capitanIds: []});
  assert.equal(publico.length, 2); assert.equal(publico[0].jugadores, undefined);
});
