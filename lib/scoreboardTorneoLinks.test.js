import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { mapPartidoTorneoPublicRow } from './dto/legacyPublic.js';

describe('scoreboardTorneoLinks migration SQL', () => {
  const sql = readFileSync('docs/sql/scoreboard_torneo_links_migration.sql', 'utf8');

  it('contiene partido_torneo_id en scoreboard_partidos', () => {
    assert.match(sql, /partido_torneo_id BIGINT/i);
    assert.match(sql, /REFERENCES partidos\(id\)/i);
  });

  it('contiene columnas de token y sync en scoreboard_partidos', () => {
    assert.match(sql, /control_token_hash TEXT/i);
    assert.match(sql, /control_token_created_at TIMESTAMPTZ/i);
    assert.match(sql, /control_token_revoked_at TIMESTAMPTZ/i);
    assert.match(sql, /synced_to_torneo_at TIMESTAMPTZ/i);
    assert.match(sql, /sync_torneo_status TEXT/i);
  });

  it('contiene cancha y ganador_equipo_id en partidos', () => {
    assert.match(sql, /ALTER TABLE partidos/i);
    assert.match(sql, /cancha TEXT/i);
    assert.match(sql, /ganador_equipo_id BIGINT/i);
    assert.match(sql, /REFERENCES equipos\(id\)/i);
  });

  it('contiene unique parcial por partido_torneo_id activo', () => {
    assert.match(sql, /idx_scoreboard_partidos_partido_torneo_activo/i);
    assert.match(sql, /UNIQUE INDEX/i);
    assert.match(sql, /partido_torneo_id IS NOT NULL/i);
    assert.match(sql, /estado NOT IN \('terminado', 'finalizado'\)/i);
  });

  it('contiene índices de lookup por torneo/cancha', () => {
    assert.match(sql, /idx_scoreboard_partidos_partido_torneo_id/i);
    assert.match(sql, /idx_scoreboard_partidos_sede_cancha_estado/i);
    assert.match(sql, /idx_partidos_torneo_cancha_fecha/i);
  });
});

describe('mapPartidoTorneoPublicRow scoreboard/torneo fields', () => {
  it('expone scoreboard_id null cuando no hay join', () => {
    const dto = mapPartidoTorneoPublicRow({
      id: 10,
      torneo_id: 23,
      estado: 'pendiente',
      equipo_a_id: 1,
      equipo_b_id: 2,
      equipo_a: { id: 1, nombre: 'A' },
      equipo_b: { id: 2, nombre: 'B' },
    });

    assert.equal(dto.scoreboard_id, null);
  });

  it('expone scoreboard_id cuando viene en la fila', () => {
    const dto = mapPartidoTorneoPublicRow({
      id: 10,
      torneo_id: 23,
      estado: 'pendiente',
      scoreboard_id: '550e8400-e29b-41d4-a716-446655440000',
      equipo_a_id: 1,
      equipo_b_id: 2,
      equipo_a: { id: 1, nombre: 'A' },
      equipo_b: { id: 2, nombre: 'B' },
    });

    assert.equal(dto.scoreboard_id, '550e8400-e29b-41d4-a716-446655440000');
  });

  it('expone cancha y ganador_equipo_id solo desde la fila', () => {
    const dto = mapPartidoTorneoPublicRow({
      id: 11,
      torneo_id: 23,
      estado: 'finalizado',
      cancha: 'Cancha 2',
      ganador_equipo_id: 5,
      equipo_a_id: 5,
      equipo_b_id: 6,
      equipo_a: { id: 5, nombre: 'A' },
      equipo_b: { id: 6, nombre: 'B' },
    });

    assert.equal(dto.cancha, 'Cancha 2');
    assert.equal(dto.ganador_equipo_id, 5);
  });

  it('no inventa cancha ni ganador_equipo_id ausentes', () => {
    const dto = mapPartidoTorneoPublicRow({
      id: 12,
      torneo_id: 23,
      estado: 'pendiente',
      equipo_a_id: 1,
      equipo_b_id: 2,
      equipo_a: { id: 1, nombre: 'A' },
      equipo_b: { id: 2, nombre: 'B' },
    });

    assert.equal(dto.cancha, null);
    assert.equal(dto.ganador_equipo_id, null);
  });
});
