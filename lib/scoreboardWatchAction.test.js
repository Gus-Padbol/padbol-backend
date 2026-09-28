import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertWatchSessionActive, parseAtomicActionResult, parseWatchAction, toAtomicState,
} from '../src/scoreboard/scoreboardWatchAction.js';

describe('scoreboard watch v1 contract', () => {
  it('normaliza un comando de punto versionado', () => {
    assert.deepEqual(parseWatchAction({
      action_id: 'watch-action-0001', device_id: 'apple-watch-1', expected_revision: 7,
      sent_at: '2026-09-28T10:00:00Z', command: 'punto', payload: { equipo: 'b' },
    }), {
      action_id: 'watch-action-0001', device_id: 'apple-watch-1', expected_revision: 7,
      sent_at: '2026-09-28T10:00:00.000Z', command: 'punto', equipo: 'B',
    });
  });

  it('rechaza ids débiles, revisión inválida y payload inválido', () => {
    assert.throws(() => parseWatchAction({ action_id: 'x', device_id: 'dev', expected_revision: 0, command: 'saque' }), /action_id/);
    assert.throws(() => parseWatchAction({ action_id: 'action-123', device_id: 'dev', expected_revision: -1, command: 'saque' }), /expected_revision/);
    assert.throws(() => parseWatchAction({ action_id: 'action-123', device_id: 'dev', expected_revision: 0, command: 'punto', payload: {} }), /equipo/);
  });

  it('rechaza sesión revocada, vencida o perteneciente a otro reloj', () => {
    const now = new Date('2026-09-28T12:00:00Z');
    assert.throws(() => assertWatchSessionActive({ revoked_at: now.toISOString() }, 'watch', now), /revocada/);
    assert.throws(() => assertWatchSessionActive({ device_id: 'watch', expires_at: '2026-09-28T11:59:59Z' }, 'watch', now), /vencida/);
    assert.throws(() => assertWatchSessionActive({ device_id: 'other', expires_at: '2026-09-29T00:00:00Z' }, 'watch', now), /otro dispositivo/);
  });

  it('convierte conflictos atómicos en HTTP 409', () => {
    assert.throws(() => parseAtomicActionResult({ status: 'conflict', revision: 9 }),
      (err) => err.status === 409 && err.current_revision === 9);
  });

  it('conserva la respuesta deduplicada como éxito sin reaplicar', () => {
    const result = parseAtomicActionResult({
      status: 'applied', revision: 8, deduplicated: true, scoreboard: { id: 'sb-1' },
    });
    assert.equal(result.deduplicated, true);
    assert.equal(result.revision, 8);
  });

  it('limita el estado enviado al RPC a campos mutables', () => {
    const state = toAtomicState({ id: 'secret', estado: 'pendiente', score_a: 0, score_b: 0 });
    assert.equal(state.id, undefined);
    assert.equal(state.estado, 'pendiente');
  });
});
