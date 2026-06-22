import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { enrichPartidoResponse } from '../utils/scoreboardLogic.js';
import {
  parseOptionalScoreboardLinkId,
  pickScoreboardPartidoLinks,
} from '../routes/scoreboard.js';

describe('scoreboardPartidoLinks migration SQL', () => {
  const sql = readFileSync('docs/sql/scoreboard_partido_links_migration.sql', 'utf8');

  it('contiene partido_abierto_id', () => {
    assert.match(sql, /partido_abierto_id BIGINT/i);
    assert.match(sql, /REFERENCES partidos_abiertos\(id\)/i);
  });

  it('contiene reserva_id', () => {
    assert.match(sql, /reserva_id BIGINT/i);
    assert.match(sql, /REFERENCES reservas\(id\)/i);
  });

  it('contiene unique parcial por partido_abierto_id activo', () => {
    assert.match(sql, /idx_scoreboard_partidos_partido_abierto_activo/i);
    assert.match(sql, /UNIQUE INDEX/i);
    assert.match(sql, /partido_abierto_id IS NOT NULL/i);
    assert.match(sql, /estado NOT IN \('terminado', 'finalizado'\)/i);
  });

  it('contiene índices por partido_abierto_id y reserva_id', () => {
    assert.match(sql, /idx_scoreboard_partidos_partido_abierto_id/i);
    assert.match(sql, /idx_scoreboard_partidos_reserva_id/i);
  });
});

describe('scoreboard partido link helpers', () => {
  it('pickScoreboardPartidoLinks acepta campos opcionales válidos', () => {
    const links = pickScoreboardPartidoLinks({
      partido_abierto_id: '42',
      reserva_id: 99001,
    });

    assert.equal(links.partido_abierto_id, 42);
    assert.equal(links.reserva_id, 99001);
  });

  it('no rompe creación sin partido_abierto_id ni reserva_id', () => {
    assert.deepEqual(pickScoreboardPartidoLinks({}), {});
    assert.deepEqual(pickScoreboardPartidoLinks({
      sede_id: 1,
      equipo_a_nombre: 'A',
    }), {});
  });

  it('rechaza partido_abierto_id inválido', () => {
    assert.throws(
      () => pickScoreboardPartidoLinks({ partido_abierto_id: 'abc' }),
      (err) => err.status === 400 && /partido_abierto_id inválido/i.test(err.message),
    );
  });

  it('rechaza reserva_id inválido', () => {
    assert.throws(
      () => pickScoreboardPartidoLinks({ reserva_id: 0 }),
      (err) => err.status === 400 && /reserva_id inválido/i.test(err.message),
    );
  });

  it('parseOptionalScoreboardLinkId acepta null explícito', () => {
    assert.equal(parseOptionalScoreboardLinkId(null, 'partido_abierto_id'), null);
    assert.equal(parseOptionalScoreboardLinkId('', 'reserva_id'), null);
  });

  it('enrichPartidoResponse expone links cuando están en el row', () => {
    const enriched = enrichPartidoResponse({
      id: 'uuid-1',
      sede_id: 3,
      cancha: '2',
      partido_abierto_id: 128,
      reserva_id: 501,
      equipo_a_nombre: 'Equipo A',
      equipo_b_nombre: 'Equipo B',
      equipo_a_jugadores: [],
      equipo_b_jugadores: [],
      jersey_a1: 1,
      jersey_a2: 2,
      jersey_a3: 3,
      jersey_a4: 4,
      jersey_b1: 1,
      jersey_b2: 2,
      jersey_b3: 3,
      jersey_b4: 4,
      estado: 'pendiente',
      saque_actual: 'A',
      score_a: 0,
      score_b: 0,
      games_a: 0,
      games_b: 0,
      sets_a: 0,
      sets_b: 0,
      historial_sets: [],
      es_tiebreak: false,
      ultimo_punto: null,
      historial_puntos: [],
      cronometro_inicio: null,
      cronometro_pausado: false,
      cronometro_segundos: 0,
    });

    assert.equal(enriched.partido_abierto_id, 128);
    assert.equal(enriched.reserva_id, 501);
    assert.ok(enriched.display);
  });
});
