import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOfficialFipaTournamentHistory } from './fipaTournamentHistory.js';

test('extrae el inventario y podio explícito sin inventar fechas ni sedes', () => {
  const csv = [
    '"#","#","*","-","-","-","(Last updated)","","WC 2023","","AC 2019"',
    '"","","","Name","Player","Team","Continent","","100%","","10%"',
    '"1","1","","Ana","Uno","Argentina","America","100","1","500","2"',
    '"2","2","","Bea","Dos","Uruguay","America","80","2","300","1"',
  ].join('\n');
  const tournaments = parseOfficialFipaTournamentHistory(csv);
  assert.equal(tournaments.length, 2);
  assert.equal(tournaments[0].nombre, 'Copa Mundial de Padbol 2023');
  assert.equal(tournaments[0].fecha_inicio, null);
  assert.equal(tournaments[0].podio[0].equipo_nombre, 'Argentina');
  assert.equal(tournaments[1].nombre, 'Copa América de Padbol 2019');
});
