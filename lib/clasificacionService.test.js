import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClasificacion,
  parsePartidoResultado,
  shouldPartidoImpactarTabla,
  sortStandingsRows,
} from './torneos/clasificacionService.js';

const eq = (id, nombre) => ({ id, nombre });

function partido(overrides = {}) {
  return {
    id: 1,
    estado: 'finalizado',
    equipo_a_id: 10,
    equipo_b_id: 20,
    ganador_equipo_id: 10,
    resultado: { goles_a: 2, goles_b: 0 },
    ...overrides,
  };
}

test('parsePartidoResultado: legacy interno goles_a/goles_b representa sets ganados', () => {
  const parsed = parsePartidoResultado(partido({
    resultado: { goles_a: 2, goles_b: 0 },
    ganador_equipo_id: 10,
  }));

  assert.equal(parsed.sets_a, 2);
  assert.equal(parsed.sets_b, 0);
  assert.equal(parsed.games_a, null);
  assert.equal(parsed.games_b, null);
  assert.equal(parsed.winner_id, 10);
  assert.equal(parsed.source_format, 'legacy_goles_as_sets');
});

test('parsePartidoResultado: legacy set1/set2 suma sets y games', () => {
  const parsed = parsePartidoResultado(partido({
    resultado: { set1: '6-4', set2: '6-3' },
    ganador_equipo_id: 10,
  }));

  assert.equal(parsed.sets_a, 2);
  assert.equal(parsed.sets_b, 0);
  assert.equal(parsed.games_a, 12);
  assert.equal(parsed.games_b, 7);
  assert.equal(parsed.source_format, 'legacy_sets');
});

test('parsePartidoResultado: ganador_equipo_id es fuente principal aunque sets sugieran otro lado', () => {
  const parsed = parsePartidoResultado(partido({
    resultado: { goles_a: 0, goles_b: 2 },
    ganador_equipo_id: 10,
  }));

  assert.equal(parsed.winner_id, 10);
});

test('shouldPartidoImpactarTabla excluye fase eliminatoria, playoff y final', () => {
  assert.equal(shouldPartidoImpactarTabla(partido({ fase: 'eliminatoria' }), 'round_robin'), false);
  assert.equal(shouldPartidoImpactarTabla(partido({ fase: 'playoff' }), 'liga_playoff'), false);
  assert.equal(shouldPartidoImpactarTabla(partido({ fase: 'final' }), 'round_robin'), false);
  assert.equal(shouldPartidoImpactarTabla(partido({ fase: 'liga' }), 'liga_playoff'), true);
});

test('shouldPartidoImpactarTabla respeta impacto_tabla', () => {
  assert.equal(
    shouldPartidoImpactarTabla(partido({ fase: 'eliminatoria', impacto_tabla: false }), 'round_robin'),
    false,
  );
  assert.equal(
    shouldPartidoImpactarTabla(partido({ fase: 'eliminatoria', impacto_tabla: true }), 'round_robin'),
    true,
  );
});

test('knockout devuelve tabla_aplica false y arrays vacíos', () => {
  const result = buildClasificacion({
    equipos: [eq(10, 'Demo A'), eq(20, 'Demo B')],
    partidos: [partido()],
    tipoTorneo: 'knockout',
  });

  assert.equal(result.metadata.tabla_aplica, false);
  assert.equal(result.metadata.motivo, 'knockout_no_tiene_tabla_general');
  assert.deepEqual(result.general, []);
  assert.deepEqual(result.grupos, {});
  assert.equal(result.metadata.partidos_excluidos, 1);
});

test('round_robin acumula sets en tabla general', () => {
  const result = buildClasificacion({
    equipos: [eq(10, 'Alpha'), eq(20, 'Beta')],
    partidos: [partido()],
    tipoTorneo: 'round_robin',
  });

  assert.equal(result.general.length, 2);
  assert.equal(result.general[0].equipo_id, 10);
  assert.equal(result.general[0].sets_favor, 2);
  assert.equal(result.general[0].sets_contra, 0);
  assert.equal(result.general[0].puntos, 3);
  assert.equal(result.general[1].sets_favor, 0);
  assert.equal(result.general[1].sets_contra, 2);
  assert.equal(result.metadata.formato_resultado.legacy_goles_as_sets, 1);
  assert.deepEqual(result.grupos, {});
});

test('grupos_knockout agrupa por grupo', () => {
  const result = buildClasificacion({
    equipos: [eq(10, 'A1'), eq(20, 'A2'), eq(30, 'B1')],
    partidos: [
      partido({ id: 1, grupo: 'A', equipo_a_id: 10, equipo_b_id: 20, ganador_equipo_id: 10 }),
      partido({
        id: 2,
        grupo: 'B',
        equipo_a_id: 30,
        equipo_b_id: 40,
        ganador_equipo_id: 30,
        resultado: { set1: '6-2', set2: '6-1' },
      }),
    ],
    tipoTorneo: 'grupos_knockout',
  });

  assert.deepEqual(result.general, []);
  assert.ok(result.grupos.A);
  assert.ok(result.grupos.B);
  assert.equal(result.grupos.A[0].equipo_id, 10);
  assert.equal(result.grupos.A[0].puntos, 3);
});

test('fase eliminatoria no cuenta en round_robin', () => {
  const result = buildClasificacion({
    equipos: [eq(10, 'Alpha'), eq(20, 'Beta')],
    partidos: [
      partido({ fase: 'liga' }),
      partido({ id: 2, fase: 'eliminatoria', ronda: 'semifinal' }),
    ],
    tipoTorneo: 'round_robin',
  });

  assert.equal(result.metadata.partidos_considerados, 1);
  assert.equal(result.metadata.partidos_excluidos, 1);
  assert.equal(result.general[0].jugados, 1);
});

test('sortStandingsRows desempata por diferencia_sets', () => {
  const rows = sortStandingsRows([
    {
      equipo_id: 1,
      equipo_nombre: 'B',
      jugados: 2,
      ganados: 1,
      perdidos: 1,
      empatados: 0,
      puntos: 3,
      sets_favor: 3,
      sets_contra: 3,
      diferencia_sets: 0,
      games_favor: null,
      games_contra: null,
      diferencia_games: null,
      partidos_finalizados: 2,
      _has_games: false,
    },
    {
      equipo_id: 2,
      equipo_nombre: 'A',
      jugados: 2,
      ganados: 1,
      perdidos: 1,
      empatados: 0,
      puntos: 3,
      sets_favor: 4,
      sets_contra: 2,
      diferencia_sets: 2,
      games_favor: null,
      games_contra: null,
      diferencia_games: null,
      partidos_finalizados: 2,
      _has_games: false,
    },
  ]);

  assert.equal(rows[0].equipo_id, 2);
  assert.equal(rows[0].posicion, 1);
  assert.equal(rows[0].tiebreak.detalle, 'puntos');
  assert.equal(rows[1].tiebreak.detalle, 'diferencia_sets');
});

test('equipos sin partidos aparecen con estadísticas en cero', () => {
  const result = buildClasificacion({
    equipos: [eq(10, 'Alpha'), eq(20, 'Beta'), eq(30, 'Gamma')],
    partidos: [partido()],
    tipoTorneo: 'round_robin',
  });

  const gamma = result.general.find((r) => r.equipo_id === 30);
  assert.ok(gamma);
  assert.equal(gamma.jugados, 0);
  assert.equal(gamma.puntos, 0);
  assert.equal(gamma.sets_favor, 0);
});

test('knockout con partido finalizado mantiene metadata explicativa', () => {
  const result = buildClasificacion({
    equipos: [eq(69, 'Demo A'), eq(70, 'Demo B')],
    partidos: [{
      id: 44,
      estado: 'finalizado',
      equipo_a_id: 69,
      equipo_b_id: 70,
      ganador_equipo_id: 69,
      resultado: { goles_a: 2, goles_b: 0 },
    }],
    tipoTorneo: 'knockout',
  });

  assert.equal(result.metadata.tabla_aplica, false);
  assert.equal(result.metadata.partidos_considerados, 0);
  assert.equal(result.metadata.partidos_excluidos, 1);
  assert.deepEqual(result.general, []);
});

test('buildClasificacion scope=grupos filtra bloque general', () => {
  const result = buildClasificacion({
    equipos: [eq(10, 'Alpha'), eq(20, 'Beta')],
    partidos: [partido()],
    tipoTorneo: 'round_robin',
    scope: 'grupos',
  });

  assert.deepEqual(result.general, []);
  assert.ok(result.general.length === 0);
});
