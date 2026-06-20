import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MatchSummaryPayloadError,
  buildMatchSummaryDisclaimers,
  buildMatchSummaryPayload,
  normalizeMatchResult,
} from '../src/partidos/matchSummaryPayload.js';

describe('matchSummaryPayload', () => {
  describe('normalizeMatchResult', () => {
    it('normaliza puntos agregados equipo1/equipo2', () => {
      const result = normalizeMatchResult({ equipo1: 6, equipo2: 4, ganador: 'equipo1' });

      assert.equal(result.formato, 'puntos_agregados');
      assert.equal(result.ganador, 'equipo1');
      assert.equal(result.marcador_texto, '6-4');
      assert.deepEqual(result.puntos_agregados, { equipo1: 6, equipo2: 4 });
      assert.equal(result.sets, null);
      assert.equal(result.fuente, 'dual_captain');
    });

    it('normaliza sets con sets_detalle', () => {
      const result = normalizeMatchResult({
        equipo1_sets: 2,
        equipo2_sets: 1,
        sets_detalle: [{ eq1: 6, eq2: 4 }, { eq1: 3, eq2: 6 }, { eq1: 6, eq2: 2 }],
        ganador: 'equipo1',
      });

      assert.equal(result.formato, 'sets');
      assert.equal(result.ganador, 'equipo1');
      assert.equal(result.marcador_texto, '2-1 (6-4, 3-6, 6-2)');
      assert.equal(result.puntos_agregados, null);
      assert.deepEqual(result.sets?.equipo1_sets, 2);
      assert.deepEqual(result.sets?.equipo2_sets, 1);
      assert.equal(result.sets?.sets_detalle.length, 3);
      assert.equal(result.fuente, 'sets_legacy_endpoint');
    });

    it('devuelve desconocido si no puede normalizar', () => {
      const result = normalizeMatchResult({ foo: 'bar' });

      assert.equal(result.formato, 'desconocido');
      assert.equal(result.marcador_texto, null);
      assert.equal(result.puntos_agregados, null);
      assert.equal(result.sets, null);
      assert.equal(result.fuente, null);
    });
  });

  describe('buildMatchSummaryDisclaimers', () => {
    it('incluye aviso de que no incluye jugadas', () => {
      const disclaimers = buildMatchSummaryDisclaimers({
        equipos: { derivacion: 'joined_at_split' },
        confirmacion: { estado: 'confirmado' },
      });

      assert.match(disclaimers.sin_jugadas_ni_estadisticas, /no incluye jugadas/i);
      assert.match(disclaimers.basado_en_datos_cargados, /datos cargados/i);
      assert.match(disclaimers.equipos_derivados, /orden de unión/i);
    });
  });

  describe('buildMatchSummaryPayload', () => {
    it('lanza error controlado si el partido no existe', async () => {
      const pgPool = {
        query: async () => ({ rows: [] }),
      };

      await assert.rejects(
        () => buildMatchSummaryPayload({ partidoId: 999, userId: 'user-1', pgPool }),
        (err) => {
          assert.ok(err instanceof MatchSummaryPayloadError);
          assert.equal(err.status, 404);
          assert.equal(err.code, 'PARTIDO_NOT_FOUND');
          return true;
        },
      );
    });
  });
});
