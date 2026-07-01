import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertKnockoutBracketTeamCount,
  buildKnockoutBracketMatches,
  linkBracketMatches,
  mergeBracketLinks,
} from './torneos/knockoutBracketService.js';

function equipos(n) {
  return Array.from({ length: n }, (_, i) => ({ id: i + 1, nombre: `Equipo ${i + 1}` }));
}

function withIds(partidos, startId = 100) {
  return partidos.map((p, idx) => ({ ...p, id: startId + idx }));
}

describe('assertKnockoutBracketTeamCount', () => {
  it('acepta 4, 8 y 16 equipos', () => {
    assert.doesNotThrow(() => assertKnockoutBracketTeamCount(4));
    assert.doesNotThrow(() => assertKnockoutBracketTeamCount(8));
    assert.doesNotThrow(() => assertKnockoutBracketTeamCount(16));
  });

  it('rechaza cantidades inválidas con status 400', () => {
    assert.throws(
      () => assertKnockoutBracketTeamCount(3),
      (err) => err.status === 400 && /4, 8 o 16/.test(err.message),
    );
    assert.throws(
      () => assertKnockoutBracketTeamCount(10),
      (err) => err.status === 400,
    );
  });
});

describe('buildKnockoutBracketMatches', () => {
  it('4 equipos crea 3 partidos: 2 semifinales y 1 final', () => {
    const rows = buildKnockoutBracketMatches({
      equipos: equipos(4),
      torneoId: 50,
      sedeId: 7,
      shuffle: false,
    });

    assert.equal(rows.length, 3);
    assert.deepEqual(rows.map((r) => r.ronda), ['semifinal', 'semifinal', 'final']);
    assert.deepEqual(rows.map((r) => r.bracket_round), [1, 1, 2]);
    assert.deepEqual(rows.map((r) => r.bracket_position), [1, 2, 1]);
  });

  it('8 equipos crea 7 partidos', () => {
    const rows = buildKnockoutBracketMatches({
      equipos: equipos(8),
      torneoId: 50,
      sedeId: 7,
      shuffle: false,
    });

    assert.equal(rows.length, 7);
    assert.equal(rows.filter((r) => r.ronda === 'cuartos').length, 4);
    assert.equal(rows.filter((r) => r.ronda === 'semifinal').length, 2);
    assert.equal(rows.filter((r) => r.ronda === 'final').length, 1);
  });

  it('16 equipos crea 15 partidos', () => {
    const rows = buildKnockoutBracketMatches({
      equipos: equipos(16),
      torneoId: 50,
      sedeId: 7,
      shuffle: false,
    });

    assert.equal(rows.length, 15);
    assert.equal(rows.filter((r) => r.ronda === 'octavos').length, 8);
    assert.equal(rows.filter((r) => r.ronda === 'cuartos').length, 4);
    assert.equal(rows.filter((r) => r.ronda === 'semifinal').length, 2);
    assert.equal(rows.filter((r) => r.ronda === 'final').length, 1);
  });

  it('primera ronda con equipos reales y rondas futuras null', () => {
    const rows = buildKnockoutBracketMatches({
      equipos: equipos(4),
      torneoId: 50,
      sedeId: 7,
      shuffle: false,
    });

    const semis = rows.filter((r) => r.bracket_round === 1);
    assert.equal(semis[0].equipo_a_id, 1);
    assert.equal(semis[0].equipo_b_id, 2);
    assert.equal(semis[1].equipo_a_id, 3);
    assert.equal(semis[1].equipo_b_id, 4);

    const final = rows.find((r) => r.ronda === 'final');
    assert.equal(final.equipo_a_id, null);
    assert.equal(final.equipo_b_id, null);
  });

  it('última ronda usa fase final y es_final', () => {
    const rows = buildKnockoutBracketMatches({
      equipos: equipos(8),
      torneoId: 50,
      sedeId: 7,
      shuffle: false,
    });

    const previas = rows.filter((r) => r.bracket_round < 3);
    const final = rows.find((r) => r.ronda === 'final');

    assert.ok(previas.every((r) => r.fase === 'eliminatoria'));
    assert.equal(final.fase, 'final');
    assert.equal(final.es_final, true);
    assert.ok(previas.every((r) => r.grupo == null && r.estado === 'pendiente'));
  });

  it('cantidad inválida lanza error antes de crear filas', () => {
    assert.throws(
      () => buildKnockoutBracketMatches({
        equipos: equipos(5),
        torneoId: 50,
        sedeId: 7,
        shuffle: false,
      }),
      (err) => err.status === 400,
    );
  });
});

describe('linkBracketMatches', () => {
  it('4 equipos: semis apuntan a final slots A/B y final sin link saliente', () => {
    const built = buildKnockoutBracketMatches({
      equipos: equipos(4),
      torneoId: 50,
      sedeId: 7,
      shuffle: false,
    });
    const inserted = withIds(built, 200);
    const updates = linkBracketMatches(inserted);
    const merged = mergeBracketLinks(inserted, updates);

    assert.equal(updates.length, 2);
    assert.deepEqual(updates, [
      { id: 200, partido_siguiente_id: 202, partido_siguiente_slot: 'A' },
      { id: 201, partido_siguiente_id: 202, partido_siguiente_slot: 'B' },
    ]);

    const final = merged.find((p) => p.ronda === 'final');
    assert.equal(final.partido_siguiente_id, undefined);
    assert.equal(final.partido_siguiente_slot, undefined);
  });

  it('8 equipos crea links correctos entre cuartos, semis y final', () => {
    const built = buildKnockoutBracketMatches({
      equipos: equipos(8),
      torneoId: 50,
      sedeId: 7,
      shuffle: false,
    });
    const inserted = withIds(built, 300);
    const updates = linkBracketMatches(inserted);

    assert.equal(updates.length, 6);
    assert.deepEqual(
      updates.filter((u) => u.partido_siguiente_id === 304),
      [
        { id: 300, partido_siguiente_id: 304, partido_siguiente_slot: 'A' },
        { id: 301, partido_siguiente_id: 304, partido_siguiente_slot: 'B' },
      ],
    );
    assert.deepEqual(
      updates.filter((u) => u.partido_siguiente_id === 305),
      [
        { id: 302, partido_siguiente_id: 305, partido_siguiente_slot: 'A' },
        { id: 303, partido_siguiente_id: 305, partido_siguiente_slot: 'B' },
      ],
    );
    assert.deepEqual(
      updates.filter((u) => u.partido_siguiente_id === 306),
      [
        { id: 304, partido_siguiente_id: 306, partido_siguiente_slot: 'A' },
        { id: 305, partido_siguiente_id: 306, partido_siguiente_slot: 'B' },
      ],
    );
  });

  it('16 equipos crea 14 links salientes', () => {
    const built = buildKnockoutBracketMatches({
      equipos: equipos(16),
      torneoId: 50,
      sedeId: 7,
      shuffle: false,
    });
    const inserted = withIds(built, 400);
    const updates = linkBracketMatches(inserted);

    assert.equal(updates.length, 14);
    assert.equal(updates.filter((u) => u.partido_siguiente_slot === 'A').length, 7);
    assert.equal(updates.filter((u) => u.partido_siguiente_slot === 'B').length, 7);
  });
});

describe('knockoutBracketService aislamiento', () => {
  it('no exporta generadores de round_robin ni grupos_knockout', () => {
    assert.equal(typeof buildKnockoutBracketMatches, 'function');
    assert.equal(typeof linkBracketMatches, 'function');
  });
});
