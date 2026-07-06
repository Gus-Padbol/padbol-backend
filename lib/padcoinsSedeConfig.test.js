import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { evaluatePadcoinsSedeParticipation } from '../src/padcoins/padcoinsSedeConfigService.js';

describe('evaluatePadcoinsSedeParticipation', () => {
  const now = new Date('2026-07-06T12:00:00.000Z');

  it('sin config o activo false → no participa', () => {
    assert.equal(evaluatePadcoinsSedeParticipation(null, now), false);
    assert.equal(evaluatePadcoinsSedeParticipation({ activo: false }, now), false);
  });

  it('activo true sin fechas → participa', () => {
    assert.equal(evaluatePadcoinsSedeParticipation({ activo: true }, now), true);
  });

  it('fecha_inicio futura → no participa todavía', () => {
    assert.equal(evaluatePadcoinsSedeParticipation({
      activo: true,
      fecha_inicio: '2026-08-01T00:00:00.000Z',
    }, now), false);
  });

  it('fecha_inicio pasada → participa', () => {
    assert.equal(evaluatePadcoinsSedeParticipation({
      activo: true,
      fecha_inicio: '2026-01-01T00:00:00.000Z',
    }, now), true);
  });

  it('fecha_fin pasada → no participa', () => {
    assert.equal(evaluatePadcoinsSedeParticipation({
      activo: true,
      fecha_fin: '2026-06-01T00:00:00.000Z',
    }, now), false);
  });

  it('fecha_fin futura → participa', () => {
    assert.equal(evaluatePadcoinsSedeParticipation({
      activo: true,
      fecha_fin: '2026-12-31T23:59:59.000Z',
    }, now), true);
  });
});
