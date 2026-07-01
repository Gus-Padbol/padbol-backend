import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildControlPath,
  generateControlToken,
  hashControlToken,
  maskControlTokenForLog,
  stripSensitiveControlFields,
  verifyControlToken,
} from '../src/scoreboard/scoreboardControlToken.js';
import {
  assertScoreboardMutable,
  isScoreboardTerminated,
} from '../src/scoreboard/scoreboardControlAuth.js';

describe('scoreboardControlToken helpers', () => {
  it('generateControlToken produce tokens distintos', () => {
    const a = generateControlToken();
    const b = generateControlToken();
    assert.ok(a.length >= 32);
    assert.notEqual(a, b);
  });

  it('hashControlToken es determinístico', () => {
    const token = 'test-token-abc';
    assert.equal(hashControlToken(token), hashControlToken(token));
    assert.notEqual(hashControlToken(token), hashControlToken('other'));
  });

  it('verifyControlToken valida hash correcto', () => {
    const token = generateControlToken();
    const hash = hashControlToken(token);
    assert.equal(verifyControlToken(token, hash), true);
    assert.equal(verifyControlToken('wrong', hash), false);
  });

  it('buildControlPath codifica token', () => {
    assert.match(buildControlPath('abc123'), /^\/scoreboard\/control\//);
  });

  it('maskControlTokenForLog no expone token completo', () => {
    const masked = maskControlTokenForLog('abcdefghijklmnopqrstuvwxyz');
    assert.ok(!masked.includes('abcdefghijklmnopqrstuvwxyz'));
    assert.match(masked, /…/);
  });

  it('stripSensitiveControlFields elimina hash y fechas de token', () => {
    const stripped = stripSensitiveControlFields({
      id: 'uuid-1',
      control_token_hash: 'abc',
      control_token_created_at: '2026-01-01',
      control_token_revoked_at: null,
      estado: 'pendiente',
    });

    assert.equal(stripped.id, 'uuid-1');
    assert.equal(stripped.control_token_hash, undefined);
    assert.equal(stripped.control_token_created_at, undefined);
    assert.equal(stripped.estado, 'pendiente');
  });
});

describe('scoreboardControlAuth estado', () => {
  it('isScoreboardTerminated reconoce terminado y finalizado', () => {
    assert.equal(isScoreboardTerminated('terminado'), true);
    assert.equal(isScoreboardTerminated('finalizado'), true);
    assert.equal(isScoreboardTerminated('pendiente'), false);
  });

  it('assertScoreboardMutable rechaza partido terminado', () => {
    assert.throws(
      () => assertScoreboardMutable({ estado: 'terminado' }),
      (err) => err.status === 400 && /terminó/i.test(err.message),
    );
  });
});
