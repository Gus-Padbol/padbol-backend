import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  MatchSummaryPayloadError,
  buildMatchSummaryDisclaimers,
  buildMatchSummaryPayload,
  buildScoreboardOpcional,
  computeDuracionAproximadaMinutos,
  fetchLinkedScoreboard,
  normalizeMatchResult,
  pickBestScoreboardRow,
} from '../src/partidos/matchSummaryPayload.js';

const basePartidoRow = {
  id: 42,
  sede_id: 1,
  sede_nombre: 'Club Test',
  cancha: '2',
  reserva_id: 501,
  capitan_user_id: '11111111-1111-1111-1111-111111111111',
  capitan_email: 'cap@test.com',
  capitan_nombre: 'Capitan',
  fecha: '2026-06-01',
  hora: '20:00:00',
  nivel: 'intermedio',
  estado: 'finalizado',
  ganador: 'equipo1',
  resultado: { equipo1: 6, equipo2: 4 },
  resultado_json: {
    estado_confirmacion: 'confirmado',
    confirmado_at: '2026-06-01T22:00:00.000Z',
  },
  deporte: 'padbol',
  sede_nombre_join: 'Club Test',
  sede_ciudad: 'Buenos Aires',
};

const baseScoreboardRow = {
  id: 'sb-uuid-1',
  estado: 'terminado',
  sets_a: 2,
  sets_b: 1,
  games_a: 0,
  games_b: 0,
  score_a: 0,
  score_b: 0,
  historial_sets: [{ set: 1, a: 6, b: 4 }, { set: 2, a: 3, b: 6 }, { set: 3, a: 6, b: 2 }],
  historial_puntos: [{ score_a: 15, score_b: 0 }],
  cronometro_segundos: 3720,
  cronometro_inicio: null,
  cronometro_pausado: true,
  equipo_a_nombre: 'Equipo A',
  equipo_b_nombre: 'Equipo B',
  equipo_a_jugadores: [{ nombre: 'Ana' }],
  equipo_b_jugadores: [{ nombre: 'Bruno' }],
  created_at: '2026-06-01T20:00:00.000Z',
  updated_at: '2026-06-01T22:00:00.000Z',
};

function createPgPoolMock(handlers = {}) {
  return {
    query: async (sql, params = []) => {
      if (/FROM partidos_abiertos pa/i.test(sql)) {
        return { rows: handlers.partidoRows ?? [basePartidoRow] };
      }
      if (/FROM partidos_abiertos_jugadores/i.test(sql)) {
        return {
          rows: handlers.jugadoresRows ?? [
            { user_id: basePartidoRow.capitan_user_id, email: 'cap@test.com', joined_at: '2026-06-01T19:00:00.000Z' },
            { user_id: '22222222-2222-2222-2222-222222222222', email: 'b@test.com', joined_at: '2026-06-01T19:05:00.000Z' },
          ],
        };
      }
      if (/FROM jugadores_perfil/i.test(sql)) {
        return { rows: handlers.perfilRows ?? [] };
      }
      if (/FROM xp_transacciones/i.test(sql)) {
        return { rows: handlers.xpRows ?? [] };
      }
      if (/partido_abierto_id = \$1/i.test(sql)) {
        return { rows: handlers.scoreboardByPartidoRows ?? [] };
      }
      if (/reserva_id = \$1/i.test(sql) && /scoreboard_partidos/i.test(sql)) {
        return { rows: handlers.scoreboardByReservaRows ?? [] };
      }
      if (/FROM scoreboard_historial_puntos/i.test(sql)) {
        return { rows: [{ total: handlers.historialPuntosCount ?? 0 }] };
      }
      return { rows: [] };
    },
  };
}

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

  describe('scoreboard helpers', () => {
    it('pickBestScoreboardRow prefiere terminado y más reciente', () => {
      const picked = pickBestScoreboardRow([
        { id: '1', estado: 'en_curso', updated_at: '2026-06-02T00:00:00.000Z' },
        { id: '2', estado: 'terminado', updated_at: '2026-06-01T22:00:00.000Z' },
        { id: '3', estado: 'terminado', updated_at: '2026-06-01T23:00:00.000Z' },
      ]);

      assert.equal(picked.id, '3');
    });

    it('computeDuracionAproximadaMinutos redondea segundos', () => {
      assert.equal(computeDuracionAproximadaMinutos(3720), 62);
      assert.equal(computeDuracionAproximadaMinutos(null), null);
      assert.equal(computeDuracionAproximadaMinutos(undefined), null);
      assert.equal(computeDuracionAproximadaMinutos(0), null);
    });

    it('buildScoreboardOpcional incluye resumen de historial y duración', () => {
      const optional = buildScoreboardOpcional(baseScoreboardRow, 18);

      assert.equal(optional.scoreboard_id, 'sb-uuid-1');
      assert.equal(optional.sets_a, 2);
      assert.equal(optional.sets_b, 1);
      assert.equal(optional.duracion_aproximada_minutos, 62);
      assert.equal(optional.historial_puntos_resumen.registros_tabla, 18);
      assert.equal(optional.historial_puntos_resumen.snapshots_json, 1);
      assert.equal(optional.historial_sets.length, 3);
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
      assert.match(disclaimers.datos_marcador, /No hay marcador vinculado/i);
    });

    it('incluye disclaimer de marcador cuando hay scoreboard_opcional', () => {
      const disclaimers = buildMatchSummaryDisclaimers({
        scoreboard_opcional: { scoreboard_id: 'sb-1' },
      });

      assert.match(disclaimers.datos_marcador, /marcador registrados/i);
    });
  });

  describe('buildMatchSummaryPayload', () => {
    it('lanza error controlado si el partido no existe', async () => {
      const pgPool = createPgPoolMock({ partidoRows: [] });

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

    it('mantiene scoreboard_opcional null si no hay marcador', async () => {
      const pgPool = createPgPoolMock();

      const payload = await buildMatchSummaryPayload({
        partidoId: 42,
        userId: basePartidoRow.capitan_user_id,
        pgPool,
      });

      assert.equal(payload.scoreboard_opcional, null);
      assert.match(payload.disclaimers.datos_marcador, /No hay marcador vinculado/i);
    });

    it('incluye scoreboard_opcional si hay scoreboard vinculado por partido_abierto_id', async () => {
      const pgPool = createPgPoolMock({
        scoreboardByPartidoRows: [baseScoreboardRow],
        historialPuntosCount: 12,
      });

      const payload = await buildMatchSummaryPayload({
        partidoId: 42,
        userId: basePartidoRow.capitan_user_id,
        pgPool,
      });

      assert.ok(payload.scoreboard_opcional);
      assert.equal(payload.scoreboard_opcional.scoreboard_id, 'sb-uuid-1');
      assert.equal(payload.scoreboard_opcional.sets_a, 2);
      assert.equal(payload.scoreboard_opcional.historial_puntos_resumen.registros_tabla, 12);
      assert.match(payload.disclaimers.datos_marcador, /marcador registrados/i);
    });

    it('incluye scoreboard_opcional si hay scoreboard vinculado por reserva_id', async () => {
      const pgPool = createPgPoolMock({
        scoreboardByReservaRows: [baseScoreboardRow],
        historialPuntosCount: 5,
      });

      const payload = await buildMatchSummaryPayload({
        partidoId: 42,
        userId: basePartidoRow.capitan_user_id,
        pgPool,
      });

      assert.ok(payload.scoreboard_opcional);
      assert.equal(payload.scoreboard_opcional.equipo_a_nombre, 'Equipo A');
    });

    it('no reemplaza resultado confirmado por capitanes', async () => {
      const pgPool = createPgPoolMock({
        scoreboardByPartidoRows: [baseScoreboardRow],
      });

      const payload = await buildMatchSummaryPayload({
        partidoId: 42,
        userId: basePartidoRow.capitan_user_id,
        pgPool,
      });

      assert.equal(payload.resultado.formato, 'puntos_agregados');
      assert.equal(payload.resultado.marcador_texto, '6-4');
      assert.equal(payload.resultado.ganador, 'equipo1');
      assert.equal(payload.scoreboard_opcional.sets_a, 2);
    });

    it('incluye nombres de equipos personalizados cuando existen en equipos_asignacion', async () => {
      const pgPool = createPgPoolMock({
        partidoRows: [{
          ...basePartidoRow,
          equipos_asignacion: {
            modo: 'manual',
            equipo1: [basePartidoRow.capitan_user_id, '22222222-2222-2222-2222-222222222222'],
            equipo2: ['33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'],
            equipo1_nombre: 'Los Pibes',
            equipo2_nombre: 'La Meca Team',
            definido_por: basePartidoRow.capitan_user_id,
            definido_at: '2026-06-01T19:30:00.000Z',
            bloqueado: true,
          },
        }],
        jugadoresRows: [
          { user_id: basePartidoRow.capitan_user_id, email: 'cap@test.com', joined_at: '2026-06-01T19:00:00.000Z' },
          { user_id: '22222222-2222-2222-2222-222222222222', email: 'b@test.com', joined_at: '2026-06-01T19:05:00.000Z' },
          { user_id: '33333333-3333-3333-3333-333333333333', email: 'c@test.com', joined_at: '2026-06-01T19:10:00.000Z' },
          { user_id: '44444444-4444-4444-4444-444444444444', email: 'd@test.com', joined_at: '2026-06-01T19:15:00.000Z' },
        ],
      });

      const payload = await buildMatchSummaryPayload({
        partidoId: 42,
        userId: basePartidoRow.capitan_user_id,
        pgPool,
      });

      assert.equal(payload.equipos.equipo1.nombre, 'Los Pibes');
      assert.equal(payload.equipos.equipo2.nombre, 'La Meca Team');
    });

    it('usa defaults Equipo 1/2 si equipos_asignacion no tiene nombres', async () => {
      const pgPool = createPgPoolMock();

      const payload = await buildMatchSummaryPayload({
        partidoId: 42,
        userId: basePartidoRow.capitan_user_id,
        pgPool,
      });

      assert.equal(payload.equipos.equipo1.nombre, 'Equipo 1');
      assert.equal(payload.equipos.equipo2.nombre, 'Equipo 2');
    });

    it('incluye analisis_previo con fecha en español y duración condicional', async () => {
      const pgPool = createPgPoolMock({
        scoreboardByPartidoRows: [{
          ...baseScoreboardRow,
          cronometro_segundos: 0,
        }],
      });

      const payload = await buildMatchSummaryPayload({
        partidoId: 42,
        userId: basePartidoRow.capitan_user_id,
        pgPool,
      });

      assert.ok(payload.analisis_previo);
      assert.equal(payload.analisis_previo.fecha_espanol, '1 de junio de 2026');
      assert.equal(payload.analisis_previo.duracion_minutos, null);
    });
  });

  describe('fetchLinkedScoreboard', () => {
    it('busca primero por partido_abierto_id y luego por reserva_id', async () => {
      const calls = [];
      const pgPool = {
        query: async (sql, params) => {
          calls.push({ sql, params });
          if (/partido_abierto_id = \$1/i.test(sql)) {
            return { rows: [] };
          }
          if (/reserva_id = \$1/i.test(sql) && /scoreboard_partidos/i.test(sql)) {
            return { rows: [baseScoreboardRow] };
          }
          return { rows: [] };
        },
      };

      const row = await fetchLinkedScoreboard(pgPool, { partidoId: 42, reservaId: 501 });

      assert.equal(row.id, 'sb-uuid-1');
      assert.equal(calls.length, 2);
      assert.equal(calls[0].params[0], 42);
      assert.equal(calls[1].params[0], 501);
    });
  });
});
