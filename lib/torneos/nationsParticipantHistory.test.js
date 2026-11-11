import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolveNationsParticipantHistory} from './nationsParticipantHistory.js';
import {parseFipaOfficialRankingCsv} from '../../routes/fipaOfficialRanking.js';

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


test('CSV oficial real: Romania coincide con participante RO', async () => {
  const csv = await readFile(new URL('../../data/fipa-ranking-2026.csv', import.meta.url), 'utf8');
  const source = parseFipaOfficialRankingCsv(csv);
  const row = resolveNationsParticipantHistory({
    participants: [{nombre: 'Olivian Surugiu', pais: 'RO'}],
    officialPlayers: source.players,
  })[0];
  assert.equal(row.status, 'matched');
  assert.equal(row.puntos, 2180);
});

test('CSV oficial real: UAE coincide con participante AE', async () => {
  const csv = await readFile(new URL('../../data/fipa-ranking-2026.csv', import.meta.url), 'utf8');
  const source = parseFipaOfficialRankingCsv(csv);
  const row = resolveNationsParticipantHistory({
    participants: [{nombre: 'Saif Al Hammadi', pais: 'AE'}],
    officialPlayers: source.players,
  })[0];
  assert.equal(row.status, 'matched');
  assert.equal(row.puntos, 60.8);
  assert.equal(row.posicion, 65);
});
