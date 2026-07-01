import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClasificacion,
  buildFinalRankingForTorneo,
  buildKnockoutRankingRows,
  buildTablaPuntosFromRankingRows,
  parsePartidoResultado,
  shouldPartidoImpactarTabla,
  sortStandingsRows,
} from './torneos/clasificacionService.js';

const POSICION_MULT = [1.0, 0.6, 0.4, 0.25];

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

test('buildFinalRanking round_robin con legacy interno sets-as-ganados ordena por puntos de tabla', () => {
  const equipos = [eq(10, 'Alpha'), eq(20, 'Beta')];
  const partidos = [partido({
    resultado: { goles_a: 2, goles_b: 0 },
    ganador_equipo_id: 10,
  })];

  const { rankingRows, source } = buildFinalRankingForTorneo({
    equipos,
    partidos,
    tipoTorneo: 'round_robin',
  });

  assert.equal(source, 'general');
  assert.equal(rankingRows[0].equipo_id, 10);
  assert.equal(rankingRows[0].puntos, 3);
  assert.equal(rankingRows[0].sets_favor, 2);
  assert.equal(rankingRows[1].sets_contra, 2);

  const tabla = buildTablaPuntosFromRankingRows(rankingRows, {
    torneoId: 1,
    basePoints: 100,
    posicionMult: POSICION_MULT,
  });
  assert.equal(tabla[0].equipo_id, 10);
  assert.equal(tabla[0].posicion, 1);
  assert.equal(tabla[0].puntos, 100);
});

test('buildFinalRanking round_robin con set1/set2 legacy mantiene sets y games', () => {
  const { rankingRows } = buildFinalRankingForTorneo({
    equipos: [eq(10, 'Alpha'), eq(20, 'Beta')],
    partidos: [{
      id: 1,
      estado: 'finalizado',
      equipo_a_id: 10,
      equipo_b_id: 20,
      ganador_equipo_id: 10,
      resultado: { set1: '6-4', set2: '6-3' },
    }],
    tipoTorneo: 'round_robin',
  });

  assert.equal(rankingRows[0].equipo_id, 10);
  assert.equal(rankingRows[0].sets_favor, 2);
  assert.equal(rankingRows[0].games_favor, 12);
});

test('buildFinalRanking grupos_knockout excluye eliminatoria de tabla y prioriza podio', () => {
  const equipos = [
    eq(1, 'Argentina'),
    eq(2, 'España'),
    eq(3, 'Brasil'),
    eq(4, 'Francia'),
  ];

  const partidos = [
    {
      id: 1, estado: 'finalizado', grupo: 'A', fase: 'grupos',
      equipo_a_id: 1, equipo_b_id: 2, ganador_equipo_id: 1,
      resultado: { set1: '6-4', set2: '6-3' },
    },
    {
      id: 2, estado: 'finalizado', grupo: 'A', fase: 'grupos',
      equipo_a_id: 1, equipo_b_id: 3, ganador_equipo_id: 1,
      resultado: { set1: '6-2', set2: '6-2' },
    },
    {
      id: 3, estado: 'finalizado', fase: 'eliminatoria', ronda: 'semifinal',
      equipo_a_id: 1, equipo_b_id: 4, ganador_equipo_id: 1,
      resultado: { set1: '6-1', set2: '6-0' },
    },
    {
      id: 4, estado: 'finalizado', fase: 'eliminatoria', ronda: 'semifinal',
      equipo_a_id: 2, equipo_b_id: 3, ganador_equipo_id: 2,
      resultado: { set1: '6-4', set2: '7-5' },
    },
    {
      id: 5, estado: 'finalizado', fase: 'final', ronda: 'final', es_final: true,
      equipo_a_id: 1, equipo_b_id: 2, ganador_equipo_id: 1,
      resultado: { set1: '6-3', set2: '6-4' },
    },
  ];

  const live = buildClasificacion({ equipos, partidos, tipoTorneo: 'grupos_knockout' });
  assert.equal(live.metadata.partidos_considerados, 2);
  assert.equal(live.metadata.partidos_excluidos, 3);

  const { rankingRows, source } = buildFinalRankingForTorneo({
    equipos,
    partidos,
    tipoTorneo: 'grupos_knockout',
  });

  assert.equal(source, 'knockout_then_grupos');
  assert.equal(rankingRows[0].equipo_id, 1);
  assert.equal(rankingRows[1].equipo_id, 2);
  assert.ok(rankingRows.some((r) => r.equipo_id === 3));
  assert.ok(rankingRows.some((r) => r.equipo_id === 4));
});

test('buildKnockoutRankingRows knockout puro con un partido define campeón y subcampeón', () => {
  const equipos = [eq(69, 'Demo A'), eq(70, 'Demo B')];
  const partidos = [{
    id: 44,
    estado: 'finalizado',
    equipo_a_id: 69,
    equipo_b_id: 70,
    ganador_equipo_id: 69,
    resultado: { goles_a: 2, goles_b: 0 },
  }];

  const rows = buildKnockoutRankingRows(partidos, equipos);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].equipo_id, 69);
  assert.equal(rows[1].equipo_id, 70);

  const { rankingRows, source } = buildFinalRankingForTorneo({
    equipos,
    partidos,
    tipoTorneo: 'knockout',
  });
  assert.equal(source, 'knockout');
  assert.equal(rankingRows[0].equipo_id, 69);

  const tabla = buildTablaPuntosFromRankingRows(rankingRows, {
    torneoId: 27,
    basePoints: 10,
    posicionMult: POSICION_MULT,
  });
  assert.equal(tabla.length, 2);
  assert.equal(tabla[0].puntos, 10);
  assert.equal(tabla[1].puntos, 6);
});

test('buildFinalRanking grupos aplanados conserva orden intra-grupo', () => {
  const equipos = [eq(1, 'A1'), eq(2, 'A2'), eq(3, 'B1')];
  const partidos = [
    {
      id: 1, estado: 'finalizado', grupo: 'A', fase: 'grupos',
      equipo_a_id: 1, equipo_b_id: 2, ganador_equipo_id: 1,
      resultado: { set1: '6-0', set2: '6-0' },
    },
    {
      id: 2, estado: 'finalizado', grupo: 'B', fase: 'grupos',
      equipo_a_id: 3, equipo_b_id: 4, ganador_equipo_id: 3,
      resultado: { set1: '6-2', set2: '6-2' },
    },
  ];

  const { rankingRows, source } = buildFinalRankingForTorneo({
    equipos: [...equipos, eq(4, 'B2')],
    partidos,
    tipoTorneo: 'grupos',
  });

  assert.equal(source, 'grupos');
  assert.equal(rankingRows[0].grupo, 'A');
  assert.equal(rankingRows[0].equipo_id, 1);
  assert.equal(rankingRows.find((r) => r.grupo === 'B')?.equipo_id, 3);
});
