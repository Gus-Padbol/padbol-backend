import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  selectQualifiersFromClasificacion,
  buildCrossSeedOrder,
  assertGruposKnockoutReady,
  buildGruposKnockoutBracketPlan,
} from './torneos/gruposKnockoutService.js';

// Grupos A y B de 4 equipos. 1A=1, 2A=2, 1B=5, 2B=6.
function buildClasificacion2x4() {
  return {
    grupos: {
      A: [
        { equipo_id: 1, equipo_nombre: 'A1', grupo: 'A', posicion: 1 },
        { equipo_id: 2, equipo_nombre: 'A2', grupo: 'A', posicion: 2 },
        { equipo_id: 3, equipo_nombre: 'A3', grupo: 'A', posicion: 3 },
        { equipo_id: 4, equipo_nombre: 'A4', grupo: 'A', posicion: 4 },
      ],
      B: [
        { equipo_id: 5, equipo_nombre: 'B1', grupo: 'B', posicion: 1 },
        { equipo_id: 6, equipo_nombre: 'B2', grupo: 'B', posicion: 2 },
        { equipo_id: 7, equipo_nombre: 'B3', grupo: 'B', posicion: 3 },
        { equipo_id: 8, equipo_nombre: 'B4', grupo: 'B', posicion: 4 },
      ],
    },
  };
}

const TORNEO = { id: 99, sede_id: 1, tipo_torneo: 'grupos_knockout' };

const GROUP_PARTIDOS_FINALIZADOS = [
  { id: 1, grupo: 'A', estado: 'finalizado' },
  { id: 2, grupo: 'A', estado: 'finalizado' },
  { id: 3, grupo: 'B', estado: 'finalizado' },
  { id: 4, grupo: 'B', estado: 'finalizado' },
];

describe('selectQualifiersFromClasificacion', () => {
  it('2 grupos de 4 → clasifica 1A, 2A, 1B, 2B correctamente', () => {
    const qualifiers = selectQualifiersFromClasificacion(buildClasificacion2x4(), { perGroup: 2 });
    assert.equal(qualifiers.length, 4);
    assert.deepEqual(
      qualifiers.map((q) => ({ grupo: q.grupo, posicion: q.posicion, equipo_id: q.equipo_id })),
      [
        { grupo: 'A', posicion: 1, equipo_id: 1 },
        { grupo: 'A', posicion: 2, equipo_id: 2 },
        { grupo: 'B', posicion: 1, equipo_id: 5 },
        { grupo: 'B', posicion: 2, equipo_id: 6 },
      ],
    );
    assert.equal(qualifiers[0].equipo_nombre, 'A1');
  });

  it('error si no hay exactamente 2 grupos', () => {
    assert.throws(
      () => selectQualifiersFromClasificacion({ grupos: { A: [] } }, { perGroup: 2 }),
      /2 grupos/,
    );
  });

  it('error si un grupo no tiene 2 clasificados', () => {
    const clasificacion = {
      grupos: {
        A: [{ equipo_id: 1, equipo_nombre: 'A1', grupo: 'A', posicion: 1 }],
        B: [
          { equipo_id: 5, equipo_nombre: 'B1', grupo: 'B', posicion: 1 },
          { equipo_id: 6, equipo_nombre: 'B2', grupo: 'B', posicion: 2 },
        ],
      },
    };
    assert.throws(
      () => selectQualifiersFromClasificacion(clasificacion, { perGroup: 2 }),
      (err) => err.code === 'grupo_sin_clasificados',
    );
  });
});

describe('buildCrossSeedOrder', () => {
  it('orden cruzado final: [1A, 2B, 1B, 2A]', () => {
    const qualifiers = selectQualifiersFromClasificacion(buildClasificacion2x4(), { perGroup: 2 });
    const order = buildCrossSeedOrder(qualifiers);
    assert.deepEqual(
      order.map((q) => `${q.posicion}${q.grupo}`),
      ['1A', '2B', '1B', '2A'],
    );
    assert.deepEqual(order.map((q) => q.equipo_id), [1, 6, 5, 2]);
  });
});

describe('assertGruposKnockoutReady', () => {
  it('ok si tipo grupos_knockout, grupos finalizados y sin llave', () => {
    const result = assertGruposKnockoutReady({
      tipoTorneo: 'grupos_knockout',
      partidos: GROUP_PARTIDOS_FINALIZADOS,
    });
    assert.equal(result.ok, true);
    assert.equal(result.grupos_partidos, 4);
  });

  it('tipo inválido → error', () => {
    assert.throws(
      () => assertGruposKnockoutReady({ tipoTorneo: 'knockout', partidos: GROUP_PARTIDOS_FINALIZADOS }),
      (err) => err.code === 'grupos_knockout_tipo_invalido' && err.status === 400,
    );
  });

  it('grupos incompletos → error', () => {
    const partidos = [
      { id: 1, grupo: 'A', estado: 'finalizado' },
      { id: 2, grupo: 'B', estado: 'pendiente' },
    ];
    assert.throws(
      () => assertGruposKnockoutReady({ tipoTorneo: 'grupos_knockout', partidos }),
      (err) => err.code === 'grupos_incompletos' && err.status === 409,
    );
  });

  it('llave existente → error', () => {
    const partidos = [
      ...GROUP_PARTIDOS_FINALIZADOS,
      { id: 10, grupo: null, estado: 'pendiente', bracket_round: 1 },
    ];
    assert.throws(
      () => assertGruposKnockoutReady({ tipoTorneo: 'grupos_knockout', partidos }),
      (err) => err.code === 'llave_existente' && err.status === 409,
    );
  });

  it('sin partidos de grupos → error', () => {
    assert.throws(
      () => assertGruposKnockoutReady({ tipoTorneo: 'grupos_knockout', partidos: [] }),
      (err) => err.code === 'grupos_incompletos',
    );
  });
});

describe('buildGruposKnockoutBracketPlan', () => {
  function buildPlan() {
    return buildGruposKnockoutBracketPlan({
      torneo: TORNEO,
      partidos: GROUP_PARTIDOS_FINALIZADOS,
      clasificacion: buildClasificacion2x4(),
    });
  }

  it('genera 3 partidos (2 semis + final)', () => {
    const { partidosData } = buildPlan();
    assert.equal(partidosData.length, 3);
  });

  it('semifinal 1 (round 1, pos 1): 1A vs 2B', () => {
    const { partidosData } = buildPlan();
    const semi1 = partidosData.find((p) => p.bracket_round === 1 && p.bracket_position === 1);
    assert.equal(semi1.equipo_a_id, 1);
    assert.equal(semi1.equipo_b_id, 6);
  });

  it('semifinal 2 (round 1, pos 2): 1B vs 2A', () => {
    const { partidosData } = buildPlan();
    const semi2 = partidosData.find((p) => p.bracket_round === 1 && p.bracket_position === 2);
    assert.equal(semi2.equipo_a_id, 5);
    assert.equal(semi2.equipo_b_id, 2);
  });

  it('final (round 2) con equipos null', () => {
    const { partidosData } = buildPlan();
    const final = partidosData.find((p) => p.bracket_round === 2);
    assert.equal(final.bracket_position, 1);
    assert.equal(final.equipo_a_id, null);
    assert.equal(final.equipo_b_id, null);
  });

  it('bracket_round/bracket_position correctos', () => {
    const { partidosData } = buildPlan();
    const shape = partidosData
      .map((p) => `${p.bracket_round}-${p.bracket_position}`)
      .sort();
    assert.deepEqual(shape, ['1-1', '1-2', '2-1']);
  });

  it('grupo null en todos los partidos knockout', () => {
    const { partidosData } = buildPlan();
    assert.ok(partidosData.every((p) => p.grupo === null));
  });

  it('no usa fase ni es_final y ronda es integer', () => {
    const { partidosData } = buildPlan();
    for (const p of partidosData) {
      assert.ok(!('fase' in p));
      assert.ok(!('es_final' in p));
      assert.equal(typeof p.ronda, 'number');
      assert.equal(p.ronda, p.bracket_round);
    }
  });

  it('devuelve clasificados con grupo/posicion/equipo_id/equipo_nombre', () => {
    const { clasificados } = buildPlan();
    assert.equal(clasificados.length, 4);
    assert.deepEqual(
      clasificados.map((c) => `${c.posicion}${c.grupo}`),
      ['1A', '2A', '1B', '2B'],
    );
    assert.equal(clasificados[0].equipo_nombre, 'A1');
  });

  it('propaga error si el torneo no está listo (tipo inválido)', () => {
    assert.throws(
      () => buildGruposKnockoutBracketPlan({
        torneo: { ...TORNEO, tipo_torneo: 'knockout' },
        partidos: GROUP_PARTIDOS_FINALIZADOS,
        clasificacion: buildClasificacion2x4(),
      }),
      (err) => err.code === 'grupos_knockout_tipo_invalido',
    );
  });
});
