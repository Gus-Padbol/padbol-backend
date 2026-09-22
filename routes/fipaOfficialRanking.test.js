import assert from 'node:assert/strict';
import test from 'node:test';
import { filterOfficialFipaRanking, normalizeFipaContinent, parseFipaOfficialRankingCsv } from './fipaOfficialRanking.js';

const CSV = [
  '"#","#","*","-","-","-","(Last updated: August 2026)"',
  '"","","","Name","Player","Team","Continent",""',
  '"1","1","*","Olivian","Surugiu","Romania","Europe","2180"',
  '"1","1","*","Victoras","Popescu","Romania","Europe","2180"',
  '"2","2","","Sebastián","Sanroman","Uruguay","America","1700,8"',
].join('\n');

test('parses complete official players and keeps ties and decimal points', () => {
  const parsed = parseFipaOfficialRankingCsv(CSV);
  assert.equal(parsed.updatedLabel, '(Last updated: August 2026)');
  assert.deepEqual(parsed.players.map((row) => row.posicion), [1, 1, 2]);
  assert.equal(parsed.players[2].puntos, 1700.8);
});

test('normalizes continents and creates continental positions', () => {
  const players = parseFipaOfficialRankingCsv(CSV).players;
  assert.equal(normalizeFipaContinent('América'), 'america');
  const america = filterOfficialFipaRanking(players, 'america');
  assert.equal(america.length, 1);
  assert.equal(america[0].posicion, 1);
  assert.equal(america[0].posicion_mundial, 2);
  assert.equal(filterOfficialFipaRanking(players, 'unknown'), null);
});
