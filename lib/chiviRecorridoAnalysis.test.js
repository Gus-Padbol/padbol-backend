import test from 'node:test';
import assert from 'node:assert/strict';
import { parseAnalysisJson } from '../src/services/chiviRecorridoAnalysis.js';

test('Chivi normaliza el análisis estructurado del recorrido', () => {
  const result = parseAnalysisJson('```json\n{"datos_reconocidos":{"ranking":24},"dudas":["nivel ilegible"],"resumen":"Ranking visible","confianza":"alta"}\n```');
  assert.deepEqual(result.datos_reconocidos, { ranking: 24 });
  assert.deepEqual(result.dudas, ['nivel ilegible']);
  assert.equal(result.confianza, 'alta');
});

test('Chivi usa confianza baja ante valores inválidos', () => {
  assert.equal(parseAnalysisJson('{"datos_reconocidos":{},"confianza":"total"}').confianza, 'baja');
});
