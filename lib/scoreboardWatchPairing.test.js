import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  generatePairingCode, normalizePairingCode, revokeWatchSession,
} from '../src/scoreboard/scoreboardWatchSessionService.js';

describe('scoreboard watch pairing', () => {
  it('genera códigos legibles de exactamente seis caracteres', () => {
    const codes = new Set(Array.from({ length: 50 }, generatePairingCode));
    assert.equal(codes.size, 50);
    for (const code of codes) assert.match(code, /^[23456789ABCDEFGHJKLMNPQRSTUVWXYZ]{6}$/);
  });

  it('acepta espacios/guion y normaliza a mayúsculas', () => {
    assert.equal(normalizePairingCode('ab2-cd3'), 'AB2CD3');
  });

  it('rechaza longitud y caracteres ambiguos', () => {
    assert.throws(() => normalizePairingCode('ABC12'), /pairing_code/);
    assert.throws(() => normalizePairingCode('ABCI23'), /pairing_code/);
    assert.throws(() => normalizePairingCode('ABCO23'), /pairing_code/);
  });

  it('nunca revoca todas las sesiones si falta session_id', async () => {
    await assert.rejects(
      revokeWatchSession({ from: () => { throw new Error('no debe consultar'); } }, 'board-1', ''),
      (error) => error.status === 400 && /session_id/.test(error.message),
    );
  });
});
