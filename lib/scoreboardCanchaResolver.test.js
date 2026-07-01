import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { pickScoreboardForCancha } from '../src/scoreboard/scoreboardCanchaResolver.js';

function sb(overrides) {
  return {
    id: 'sb-default',
    estado: 'pendiente',
    partido_torneo_id: null,
    created_at: '2026-06-01T10:00:00.000Z',
    updated_at: '2026-06-01T10:00:00.000Z',
    ...overrides,
  };
}

function partido(id, fecha_hora) {
  return { id, fecha_hora, estado: 'programado' };
}

describe('pickScoreboardForCancha', () => {
  it('en_curso gana sobre pendientes', () => {
    const candidates = [
      sb({ id: 'pendiente-1', estado: 'pendiente', partido_torneo_id: 1, updated_at: '2026-06-25T12:00:00.000Z' }),
      sb({ id: 'en-curso-1', estado: 'en_curso', updated_at: '2026-06-20T08:00:00.000Z' }),
    ];
    const partidos = new Map([[1, partido(1, '2026-06-25T18:00:00')]]);

    const picked = pickScoreboardForCancha(candidates, partidos, new Date('2026-06-25T10:00:00Z'));
    assert.equal(picked.id, 'en-curso-1');
  });

  it('si hay varios en_curso, gana updated_at DESC', () => {
    const candidates = [
      sb({ id: 'en-curso-old', estado: 'en_curso', updated_at: '2026-06-20T08:00:00.000Z' }),
      sb({ id: 'en-curso-new', estado: 'en_curso', updated_at: '2026-06-25T08:00:00.000Z' }),
    ];

    const picked = pickScoreboardForCancha(candidates, new Map(), new Date('2026-06-25T10:00:00Z'));
    assert.equal(picked.id, 'en-curso-new');
  });

  it('sin en_curso, gana próxima fecha_hora futura', () => {
    const candidates = [
      sb({ id: 'sb-28', partido_torneo_id: 28, created_at: '2026-06-01T10:00:00.000Z' }),
      sb({ id: 'sb-43', partido_torneo_id: 43, created_at: '2026-06-02T10:00:00.000Z' }),
    ];
    const partidos = new Map([
      [28, partido(28, '2026-06-26T18:00:00')],
      [43, partido(43, '2026-06-27T20:00:00')],
    ]);

    const picked = pickScoreboardForCancha(candidates, partidos, new Date('2026-06-25T10:00:00Z'));
    assert.equal(picked.id, 'sb-28');
    assert.equal(picked.partido_torneo_id, 28);
  });

  it('si todas las fechas pasaron, gana la fecha_hora más antigua entre pendientes', () => {
    const candidates = [
      sb({ id: 'sb-43', partido_torneo_id: 43, created_at: '2026-06-06T10:00:00.000Z' }),
      sb({ id: 'sb-28', partido_torneo_id: 28, created_at: '2026-06-01T10:00:00.000Z' }),
      sb({ id: 'sb-34', partido_torneo_id: 34, created_at: '2026-06-02T10:00:00.000Z' }),
    ];
    const partidos = new Map([
      [28, partido(28, '2026-06-18T18:00:00')],
      [34, partido(34, '2026-06-18T20:00:00')],
      [43, partido(43, '2026-06-24T20:00:00')],
    ]);

    const picked = pickScoreboardForCancha(candidates, partidos, new Date('2026-06-25T10:00:00Z'));
    assert.equal(picked.id, 'sb-28');
    assert.equal(picked.partido_torneo_id, 28);
  });

  it('sin fecha_hora usable, gana created_at ASC', () => {
    const candidates = [
      sb({ id: 'sb-new', partido_torneo_id: 10, created_at: '2026-06-05T10:00:00.000Z' }),
      sb({ id: 'sb-old', partido_torneo_id: 11, created_at: '2026-06-01T10:00:00.000Z' }),
    ];
    const partidos = new Map([
      [10, { id: 10, fecha_hora: null }],
      [11, { id: 11, fecha_hora: '' }],
    ]);

    const picked = pickScoreboardForCancha(candidates, partidos, new Date('2026-06-25T10:00:00Z'));
    assert.equal(picked.id, 'sb-old');
  });

  it('manual sin torneo usa updated_at DESC', () => {
    const candidates = [
      sb({ id: 'manual-old', partido_torneo_id: null, updated_at: '2026-06-01T10:00:00.000Z' }),
      sb({ id: 'manual-new', partido_torneo_id: null, updated_at: '2026-06-25T10:00:00.000Z' }),
    ];

    const picked = pickScoreboardForCancha(candidates, new Map(), new Date('2026-06-25T12:00:00Z'));
    assert.equal(picked.id, 'manual-new');
  });

  it('torneo #23 Cancha 1 elige partido_torneo_id 28 antes que 43', () => {
    const now = new Date('2026-06-25T10:00:00Z');
    const candidates = [
      sb({ id: '14645524-f724-4fe9-982a-2ddbb52b7cb1', partido_torneo_id: 28, created_at: '2026-06-25T08:00:00.000Z' }),
      sb({ id: '64c05876-0000-4000-8000-000000000031', partido_torneo_id: 31, created_at: '2026-06-25T08:01:00.000Z' }),
      sb({ id: '144e9369-0000-4000-8000-000000000034', partido_torneo_id: 34, created_at: '2026-06-25T08:02:00.000Z' }),
      sb({ id: 'd0cfe0e0-0000-4000-8000-000000000037', partido_torneo_id: 37, created_at: '2026-06-25T08:03:00.000Z' }),
      sb({ id: 'c771c237-0000-4000-8000-000000000040', partido_torneo_id: 40, created_at: '2026-06-25T08:04:00.000Z' }),
      sb({ id: '56b0167a-d0e2-4786-b00e-1ab1fc4c7555', partido_torneo_id: 43, created_at: '2026-06-25T08:05:00.000Z' }),
    ];
    const partidos = new Map([
      [28, partido(28, '2026-06-18T18:00:00')],
      [31, partido(31, '2026-06-19T19:00:00')],
      [34, partido(34, '2026-06-18T20:00:00')],
      [37, partido(37, '2026-06-19T21:00:00')],
      [40, partido(40, '2026-06-22T19:00:00')],
      [43, partido(43, '2026-06-24T20:00:00')],
    ]);

    const picked = pickScoreboardForCancha(candidates, partidos, now);
    assert.equal(picked.partido_torneo_id, 28);
    assert.equal(picked.id, '14645524-f724-4fe9-982a-2ddbb52b7cb1');
  });

  it('devuelve null si no hay candidatos elegibles', () => {
    const picked = pickScoreboardForCancha(
      [sb({ id: 'done', estado: 'terminado' })],
      new Map(),
      new Date(),
    );
    assert.equal(picked, null);
  });
});
