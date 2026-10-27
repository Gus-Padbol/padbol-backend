import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partidoSuspendidoVisibleParaUsuario } from './partidos.js';

test('partido suspendido visible solo al organizador y sus jugadores', () => {
  const match = { estado: 'suspendido', capitan_user_id: 'organizador', partidos_abiertos_jugadores: [{ user_id: 'jugador' }] };
  assert.equal(partidoSuspendidoVisibleParaUsuario(match, { id: 'organizador' }), true);
  assert.equal(partidoSuspendidoVisibleParaUsuario(match, { id: 'jugador' }), true);
  assert.equal(partidoSuspendidoVisibleParaUsuario(match, { id: 'ajeno' }), false);
  assert.equal(partidoSuspendidoVisibleParaUsuario(match, null), false);
  assert.equal(partidoSuspendidoVisibleParaUsuario({ ...match, estado: 'abierto' }, { id: 'jugador' }), false);
});
