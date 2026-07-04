import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildScoreboardMapForTorneoPartidos,
  isScoreboardTorneoPartidoActivo,
  normalizeResolvedScoreboardForTorneoPartido,
  pickScoreboardRowForTorneoPartido,
  resolveScoreboardForTorneoPartido,
} from '../src/scoreboard/scoreboardTorneoPartidoResolver.js';

function row(overrides = {}) {
  return {
    id: 'sb-default',
    estado: 'pendiente',
    partido_torneo_id: 45,
    torneo_id: 28,
    sede_id: 1,
    cancha: 'Cancha 1',
    updated_at: '2026-07-01T10:00:00.000Z',
    ...overrides,
  };
}

describe('isScoreboardTorneoPartidoActivo', () => {
  it('pendiente y en_curso son activos', () => {
    assert.equal(isScoreboardTorneoPartidoActivo('pendiente'), true);
    assert.equal(isScoreboardTorneoPartidoActivo('en_curso'), true);
  });

  it('terminado y finalizado no son activos', () => {
    assert.equal(isScoreboardTorneoPartidoActivo('terminado'), false);
    assert.equal(isScoreboardTorneoPartidoActivo('FINALIZADO'), false);
  });
});

describe('pickScoreboardRowForTorneoPartido', () => {
  it('sin candidatos → null', () => {
    const { row: picked, multipleActive } = pickScoreboardRowForTorneoPartido([]);
    assert.equal(picked, null);
    assert.equal(multipleActive, false);
  });

  it('un activo → devuelve activo', () => {
    const active = row({ id: 'sb-active', estado: 'en_curso' });
    const { row: picked } = pickScoreboardRowForTorneoPartido([active]);
    assert.equal(picked.id, 'sb-active');
  });

  it('activo + terminado → devuelve activo', () => {
    const candidates = [
      row({ id: 'sb-old', estado: 'terminado', updated_at: '2026-07-03T10:00:00.000Z' }),
      row({ id: 'sb-live', estado: 'en_curso', updated_at: '2026-07-01T10:00:00.000Z' }),
    ];
    const { row: picked } = pickScoreboardRowForTorneoPartido(candidates);
    assert.equal(picked.id, 'sb-live');
  });

  it('varios terminados → devuelve el más reciente por updated_at', () => {
    const candidates = [
      row({ id: 'sb-t1', estado: 'terminado', updated_at: '2026-07-01T10:00:00.000Z' }),
      row({ id: 'sb-t2', estado: 'finalizado', updated_at: '2026-07-03T10:00:00.000Z' }),
      row({ id: 'sb-t3', estado: 'terminado', updated_at: '2026-07-02T10:00:00.000Z' }),
    ];
    const { row: picked } = pickScoreboardRowForTorneoPartido(candidates);
    assert.equal(picked.id, 'sb-t2');
  });

  it('varios activos → devuelve el más reciente y marca multipleActive', () => {
    const candidates = [
      row({ id: 'sb-a1', estado: 'pendiente', updated_at: '2026-07-01T10:00:00.000Z' }),
      row({ id: 'sb-a2', estado: 'en_curso', updated_at: '2026-07-03T10:00:00.000Z' }),
      row({ id: 'sb-a3', estado: 'pendiente', updated_at: '2026-07-02T10:00:00.000Z' }),
    ];
    const { row: picked, multipleActive } = pickScoreboardRowForTorneoPartido(candidates);
    assert.equal(picked.id, 'sb-a2');
    assert.equal(multipleActive, true);
  });
});

describe('normalizeResolvedScoreboardForTorneoPartido', () => {
  it('normaliza campos del contrato público', () => {
    const normalized = normalizeResolvedScoreboardForTorneoPartido(row({
      id: '5dca454c-47d6-476f-9438-7d6ab767b823',
      estado: 'Terminado',
      partido_torneo_id: 45,
      torneo_id: 28,
      sede_id: 1,
      cancha: 'Cancha 2',
      updated_at: '2026-07-04T12:00:00.000Z',
    }));

    assert.deepEqual(normalized, {
      scoreboard_id: '5dca454c-47d6-476f-9438-7d6ab767b823',
      scoreboard_estado: 'terminado',
      partido_torneo_id: 45,
      torneo_id: 28,
      sede_id: 1,
      cancha: 'Cancha 2',
      updated_at: '2026-07-04T12:00:00.000Z',
    });
  });

  it('filas inválidas → null', () => {
    assert.equal(normalizeResolvedScoreboardForTorneoPartido(null), null);
    assert.equal(normalizeResolvedScoreboardForTorneoPartido({ estado: 'pendiente' }), null);
  });
});

describe('resolveScoreboardForTorneoPartido', () => {
  it('sin marcador → null', async () => {
    const supabase = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          then(resolve) {
            resolve({ data: [], error: null });
          },
        };
      },
    };

    const result = await resolveScoreboardForTorneoPartido(supabase, 999);
    assert.equal(result, null);
  });

  it('partidoId inválido → null sin consultar', async () => {
    let queried = false;
    const supabase = {
      from() {
        queried = true;
        return { select: () => ({ eq: () => ({ then: (r) => r({ data: [], error: null }) }) }) };
      },
    };

    assert.equal(await resolveScoreboardForTorneoPartido(supabase, 0), null);
    assert.equal(await resolveScoreboardForTorneoPartido(supabase, 'abc'), null);
    assert.equal(queried, false);
  });

  it('integración mock: activo gana sobre terminado', async () => {
    const rows = [
      row({ id: 'sb-done', estado: 'terminado', updated_at: '2026-07-04T10:00:00.000Z' }),
      row({ id: 'sb-live', estado: 'pendiente', updated_at: '2026-07-03T10:00:00.000Z' }),
    ];
    const supabase = {
      from(table) {
        return {
          select() { this._table = table; return this; },
          eq(_col, val) {
            this._partidoId = val;
            return this;
          },
          then(resolve) {
            assert.equal(this._table, 'scoreboard_partidos');
            assert.equal(this._partidoId, 45);
            resolve({ data: rows, error: null });
          },
        };
      },
    };

    const result = await resolveScoreboardForTorneoPartido(supabase, 45);
    assert.equal(result.scoreboard_id, 'sb-live');
    assert.equal(result.scoreboard_estado, 'pendiente');
    assert.equal(result.partido_torneo_id, 45);
  });

  it('dispara onMultipleActive cuando hay varios activos', async () => {
    const rows = [
      row({ id: 'sb-1', estado: 'pendiente', updated_at: '2026-07-01T10:00:00.000Z' }),
      row({ id: 'sb-2', estado: 'en_curso', updated_at: '2026-07-02T10:00:00.000Z' }),
    ];
    const supabase = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          then(resolve) { resolve({ data: rows, error: null }); },
        };
      },
    };

    let warned = null;
    const result = await resolveScoreboardForTorneoPartido(supabase, 45, {
      onMultipleActive: (partidoTorneoId, count) => { warned = { partidoTorneoId, count }; },
    });

    assert.equal(result.scoreboard_id, 'sb-2');
    assert.deepEqual(warned, { partidoTorneoId: 45, count: 2 });
  });
});

describe('buildScoreboardMapForTorneoPartidos', () => {
  it('resuelve un marcador por partido_torneo_id', () => {
    const map = buildScoreboardMapForTorneoPartidos([
      row({ id: 'sb-45', partido_torneo_id: 45, estado: 'en_curso' }),
      row({ id: 'sb-46', partido_torneo_id: 46, estado: 'pendiente' }),
    ]);

    assert.equal(map.size, 2);
    assert.equal(map.get(45).scoreboard_id, 'sb-45');
    assert.equal(map.get(46).scoreboard_id, 'sb-46');
  });

  it('elige activo más reciente por partido cuando hay duplicados', () => {
    const map = buildScoreboardMapForTorneoPartidos([
      row({ id: 'sb-old', partido_torneo_id: 45, estado: 'pendiente', updated_at: '2026-07-01T10:00:00.000Z' }),
      row({ id: 'sb-new', partido_torneo_id: 45, estado: 'en_curso', updated_at: '2026-07-02T10:00:00.000Z' }),
    ]);

    assert.equal(map.size, 1);
    assert.equal(map.get(45).scoreboard_id, 'sb-new');
  });
});
