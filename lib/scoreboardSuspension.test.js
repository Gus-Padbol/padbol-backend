import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSuspension, buildResume } from '../src/scoreboard/scoreboardSuspension.js';

const match = { estado: 'en_curso', cancha: '1', score_a: 40, score_b: 15, games_a: 3, sets_b: 1, saque_actual: 'B', historial_puntos: [{ a: 1 }], cronometro_inicio: '2026-10-21T12:00:00Z', cronometro_pausado: false, cronometro_segundos: 45 };
test('suspensión congela el tiempo y conserva parcial, saque e historial', () => {
  const before = structuredClone(match);
  const patch = buildSuspension(match, Date.parse('2026-10-21T12:00:33Z'));
  const suspended = { ...match, ...patch };
  assert.deepEqual(match, before);
  assert.equal(suspended.cronometro_segundos, 78);
  assert.equal(suspended.score_a, 40); assert.equal(suspended.games_a, 3); assert.equal(suspended.sets_b, 1);
  assert.equal(suspended.saque_actual, 'B'); assert.deepEqual(suspended.historial_puntos, match.historial_puntos);
  assert.equal(suspended.cronometro_inicio, null); assert.equal(suspended.cronometro_pausado, true);
});
test('reanudar conserva resultado y reloj detenido y requiere cancha', () => {
  const suspended = { ...match, ...buildSuspension(match, Date.parse('2026-10-21T12:00:33Z')) };
  const resumed = { ...suspended, ...buildResume(suspended, ' 2 ') };
  assert.equal(resumed.cancha, '2'); assert.equal(resumed.estado, 'en_curso');
  assert.equal(resumed.cronometro_segundos, 78); assert.equal(resumed.cronometro_pausado, true);
  assert.equal(resumed.score_a, 40); assert.deepEqual(resumed.historial_puntos, match.historial_puntos);
  assert.throws(() => buildResume(suspended, ''), { status: 400 });
});
test('no se suspende un marcador terminado ni se reanuda otro no suspendido', () => {
  assert.throws(() => buildSuspension({ ...match, estado: 'terminado' }), { status: 409 });
  assert.throws(() => buildResume(match, '2'), { status: 409 });
});
test('suspender un reloj pausado no suma tiempo adicional', () => {
  assert.equal(buildSuspension({ ...match, cronometro_pausado: true }, Date.parse('2026-10-22T12:00:00Z')).cronometro_segundos, 45);
});

test('admite los valores de reloj compatibles con marcadores históricos', () => {
  assert.equal(buildSuspension({ ...match, cronometro_pausado: 'false' }, Date.parse('2026-10-21T12:00:33Z')).cronometro_segundos, 78);
});
