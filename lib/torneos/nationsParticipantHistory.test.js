import test from 'node:test';
import assert from 'node:assert/strict';
import {resolveNationsParticipantHistory} from './nationsParticipantHistory.js';

const official = [
  {nombre_completo:'Juan Pérez', pais:'IT', puntos:2180, posicion:3},
  {nombre_completo:'Ana Gómez', pais:'IT', puntos:900, posicion:4},
  {nombre_completo:'Ana Gómez', pais:'IT', puntos:950, posicion:5},
];
test('exacto único conserva puntos reales; nuevo=0; ambiguo no atribuye', () => {
  const rows = resolveNationsParticipantHistory({participants:[
    {nombre:'Juan Perez', pais:'it'},
    {nombre:'Nuevo Jugador', pais:'IT'},
    {nombre:'Ana Gomez', pais:'IT'},
  ], officialPlayers:official});
  assert.deepEqual(rows[0], {status:'matched', puntos:2180, posicion:3});
  assert.deepEqual(rows[1], {status:'zero', puntos:0, posicion:null});
  assert.deepEqual(rows[2], {status:'ambiguous', puntos:null, posicion:null});
});
test('no suma ni expone source_key/cuenta', () => {
  const rows = resolveNationsParticipantHistory({participants:[{nombre:'Juan Pérez',pais:'IT'}], officialPlayers:official});
  assert.equal(rows[0].puntos, 2180);
  assert.equal(JSON.stringify(rows).includes('source_key'), false);
  assert.equal(JSON.stringify(rows).includes('user_id'), false);
});
