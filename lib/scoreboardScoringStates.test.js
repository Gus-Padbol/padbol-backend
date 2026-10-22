import test from 'node:test';
import assert from 'node:assert/strict';
import {assertScoreboardScoringActive} from '../src/scoreboard/scoreboardControlAuth.js';
test('puntuación y deshacer solo con partido iniciado y reloj activo', () => {
 for (const partido of [
  {estado:'pendiente',cronometro_inicio:null},
  {estado:'en_curso',cronometro_inicio:null},
  {estado:'en_curso',cronometro_inicio:'2026-10-22T10:00:00Z',cronometro_pausado:true},
  {estado:'suspendido',cronometro_inicio:'2026-10-22T10:00:00Z'},
  {estado:'terminado',cronometro_inicio:'2026-10-22T10:00:00Z'},
 ]) assert.throws(()=>assertScoreboardScoringActive(partido));
 assert.doesNotThrow(()=>assertScoreboardScoringActive({estado:'en_curso',cronometro_inicio:'2026-10-22T10:00:00Z',cronometro_pausado:false}));
});
