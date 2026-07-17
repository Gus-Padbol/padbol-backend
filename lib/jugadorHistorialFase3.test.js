import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoPrivateLeak,
  containsEmpateSignal,
  filterHistorialEvents,
  mapAsistenciaEstadoPublico,
  paginateHistorialEvents,
  parseHistorialTipos,
  tryNormalizeAsistenciaEvent,
  tryNormalizeRankingCasualEvent,
} from './jugadorHistorialDomain.js';
import {
  fetchAsistenciaHistorialEvents,
  fetchRankingCasualHistorialEvents,
  getJugadorHistorial,
} from './jugadorHistorialService.js';

const U1 = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const U2 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';

test('1. Normalización correcta de evento ranking_casual', () => {
  const r = tryNormalizeRankingCasualEvent({
    id: 39,
    user_id: U1,
    match_id: '53',
    reward_type: 'ranking',
    amount: 3,
    status: 'credited',
    created_at: '2026-07-13T22:00:06.974Z',
    metadata: { rp: 3, outcome: 'win', mode: 'manual' },
  }, { sede_id: 1, deporte: 'padbol' });
  assert.equal(r.ok, true);
  assert.equal(r.event.id, 'ranking_casual:39');
  assert.equal(r.event.tipo, 'ranking_casual');
  assert.equal(r.event.titulo, 'Ranking Casual');
  assert.equal(r.event.referencia.tipo, 'partido');
  assert.equal(r.event.referencia.id, '53');
  assert.equal(r.event.payload.rp_delta, 3);
  assert.equal(r.event.payload.resultado, 'victoria');
  assert.equal(r.event.payload.deporte, 'padbol');
  assert.equal(r.event.sede_id, 1);
});

test('2. Normalización correcta de asistencia confirmada', () => {
  const r = tryNormalizeAsistenciaEvent({
    id: 10,
    match_id: '59',
    attendance_status: 'confirmed',
    attendance_confirmed_at: '2026-07-11T12:00:00.000Z',
    attendance_responded_at: '2026-07-11T12:00:00.000Z',
    created_at: '2026-07-10T10:00:00.000Z',
  }, { sede_id: 2, deporte: 'padbol', fecha_partido: '2026-07-11T20:00:00.000Z' });
  assert.equal(r.ok, true);
  assert.equal(r.event.payload.estado, 'confirmada');
  assert.equal(r.event.id, 'asistencia:10');
  assert.equal(r.event.referencia.id, '59');
  assert.equal(r.event.occurred_at, '2026-07-11T12:00:00.000Z');
});

test('3. Normalización correcta de asistencia rechazada', () => {
  const r = tryNormalizeAsistenciaEvent({
    id: 11,
    match_id: '60',
    attendance_status: 'denied',
    attendance_responded_at: '2026-07-12T09:00:00.000Z',
    created_at: '2026-07-10T10:00:00.000Z',
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.payload.estado, 'rechazada');
});

test('4. Normalización correcta de asistencia pendiente', () => {
  const r = tryNormalizeAsistenciaEvent({
    id: 12,
    match_id: '61',
    attendance_status: 'pending',
    created_at: '2026-07-10T10:00:00.000Z',
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.payload.estado, 'pendiente');
  assert.equal(r.event.occurred_at, '2026-07-10T10:00:00.000Z');
});

test('5. Normalización correcta de asistencia vencida', () => {
  const r = tryNormalizeAsistenciaEvent({
    id: 13,
    match_id: '62',
    attendance_status: 'excluded',
    attendance_response_source: 'system_timeout',
    attendance_responded_at: '2026-07-13T23:00:00.000Z',
    updated_at: '2026-07-13T23:00:00.000Z',
    created_at: '2026-07-10T10:00:00.000Z',
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.payload.estado, 'vencida');
  assert.ok(r.event.payload.expirado_en);
});

test('6. Normalización correcta de asistencia cancelada', () => {
  const r = tryNormalizeAsistenciaEvent({
    id: 14,
    match_id: '63',
    attendance_status: 'excluded',
    attendance_response_source: 'admin',
    attendance_responded_at: '2026-07-13T12:00:00.000Z',
    created_at: '2026-07-10T10:00:00.000Z',
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.payload.estado, 'cancelada');
});

function createFase3Mock({
  rewards = [],
  participants = [],
  partidosAbiertos = [],
  failTable = null,
  trackTables = null,
} = {}) {
  return {
    from(table) {
      if (trackTables) trackTables.add(table);
      const state = { filters: {}, inValues: null, inStatus: null, limit: null };
      const api = {
        select() { return api; },
        eq(col, val) { state.filters[col] = val; return api; },
        in(col, vals) {
          if (col === 'status') state.inStatus = vals;
          else state.inValues = { col, vals };
          return api;
        },
        order() { return api; },
        limit(n) { state.limit = n; return api; },
        then(resolve) {
          Promise.resolve().then(() => {
            if (failTable === table) {
              return { data: null, error: { message: 'boom fase3', code: 'XX' } };
            }
            if (table === 'match_reward_events') {
              let rows = [...rewards];
              if (state.filters.user_id) {
                rows = rows.filter((r) => r.user_id === state.filters.user_id);
              }
              if (state.filters.reward_type) {
                rows = rows.filter((r) => r.reward_type === state.filters.reward_type);
              }
              if (state.inStatus) {
                const set = new Set(state.inStatus);
                rows = rows.filter((r) => set.has(r.status));
              }
              return { data: rows.slice(0, state.limit || rows.length), error: null };
            }
            if (table === 'match_participants') {
              let rows = [...participants];
              if (state.filters.user_id) {
                rows = rows.filter((r) => r.user_id === state.filters.user_id);
              }
              return { data: rows.slice(0, state.limit || rows.length), error: null };
            }
            if (table === 'partidos_abiertos') {
              let rows = [...partidosAbiertos];
              if (state.inValues?.col === 'id') {
                const set = new Set(state.inValues.vals.map(String));
                rows = rows.filter((p) => set.has(String(p.id)));
              }
              return { data: rows, error: null };
            }
            if (table === 'rankings_leaderboard') {
              assert.fail('no se debe consultar rankings_leaderboard');
            }
            return { data: [], error: null };
          }).then(resolve);
        },
      };
      return api;
    },
  };
}

test('7. Ranking Casual solo devuelve eventos del usuario autenticado', async () => {
  const db = createFase3Mock({
    rewards: [
      {
        id: 1, user_id: U1, match_id: '1', reward_type: 'ranking', amount: 3,
        status: 'credited', created_at: '2026-07-01T00:00:00Z', metadata: { outcome: 'win', rp: 3 },
      },
      {
        id: 2, user_id: U2, match_id: '2', reward_type: 'ranking', amount: 3,
        status: 'credited', created_at: '2026-07-01T00:00:00Z', metadata: { outcome: 'win', rp: 3 },
      },
    ],
  });
  const { events } = await fetchRankingCasualHistorialEvents(db, { id: U1 }, { sourceLimit: 50 });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.evento_id, '1');
});

test('8. Asistencia solo devuelve registros del usuario autenticado', async () => {
  const db = createFase3Mock({
    participants: [
      {
        id: 1, user_id: U1, match_id: '10', attendance_status: 'confirmed',
        attendance_confirmed_at: '2026-07-01T12:00:00Z', created_at: '2026-07-01T10:00:00Z',
      },
      {
        id: 2, user_id: U2, match_id: '10', attendance_status: 'confirmed',
        attendance_confirmed_at: '2026-07-01T12:00:00Z', created_at: '2026-07-01T10:00:00Z',
      },
    ],
  });
  const { events } = await fetchAsistenciaHistorialEvents(db, { id: U1 }, { sourceLimit: 50 });
  assert.equal(events.length, 1);
  assert.equal(events[0].payload.participante_id, '1');
});

test('9. No devuelve asistencia de otros participantes', async () => {
  const db = createFase3Mock({
    participants: [
      {
        id: 99, user_id: U2, match_id: '10', attendance_status: 'denied',
        attendance_responded_at: '2026-07-01T12:00:00Z', created_at: '2026-07-01T10:00:00Z',
      },
    ],
  });
  const { events } = await fetchAsistenciaHistorialEvents(db, { id: U1 }, { sourceLimit: 50 });
  assert.equal(events.length, 0);
});

test('10. Ledger duplicado no genera eventos duplicados', async () => {
  const row = {
    id: 7, user_id: U1, match_id: '1', reward_type: 'ranking', amount: 3,
    status: 'credited', created_at: '2026-07-01T00:00:00Z', metadata: { outcome: 'win', rp: 3 },
  };
  const db = createFase3Mock({ rewards: [row, { ...row }] });
  const { events } = await fetchRankingCasualHistorialEvents(db, { id: U1 }, { sourceLimit: 50 });
  assert.equal(events.length, 1);
});

test('11. Dos eventos legítimos del mismo partido se conservan', () => {
  const a = tryNormalizeRankingCasualEvent({
    id: 1, match_id: '53', reward_type: 'ranking', amount: 3, status: 'credited',
    created_at: '2026-07-01T00:00:00Z', metadata: { outcome: 'win', rp: 3 },
  });
  const b = tryNormalizeRankingCasualEvent({
    id: 2, match_id: '53', reward_type: 'ranking', amount: 3, status: 'reversed',
    created_at: '2026-07-02T00:00:00Z', metadata: { outcome: 'win', rp: 3 },
  });
  assert.equal(a.ok, true);
  assert.equal(b.ok, true);
  assert.notEqual(a.event.id, b.event.id);
  assert.equal(a.event.payload.partido_id, b.event.payload.partido_id);
});

test('12. Reversión real de RP se conserva', () => {
  const r = tryNormalizeRankingCasualEvent({
    id: 50, match_id: '53', reward_type: 'ranking', amount: 3, status: 'reversed',
    created_at: '2026-07-02T00:00:00Z', metadata: { outcome: 'win', rp: 3, mode: 'manual' },
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.payload.rp_delta, -3);
  assert.equal(r.event.payload.motivo, 'reversion');
  assert.match(r.event.resumen, /Reversión/i);
});

test('13. No se inventa rp_anterior', () => {
  const r = tryNormalizeRankingCasualEvent({
    id: 1, match_id: '1', reward_type: 'ranking', amount: 3, status: 'credited',
    created_at: '2026-07-01T00:00:00Z',
    metadata: { outcome: 'win', rp: 3, puntos_totales: 12 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.payload.rp_anterior, null);
});

test('14. No se inventa rp_nuevo', () => {
  const r = tryNormalizeRankingCasualEvent({
    id: 1, match_id: '1', reward_type: 'ranking', amount: 3, status: 'credited',
    created_at: '2026-07-01T00:00:00Z',
    metadata: { outcome: 'win', rp: 3, puntos_totales: 12 },
  });
  assert.equal(r.ok, true);
  assert.equal(r.event.payload.rp_nuevo, null);
});

test('15. No se reconstruye historial desde rankings_leaderboard', async () => {
  const tracked = new Set();
  const db = createFase3Mock({
    rewards: [{
      id: 1, user_id: U1, match_id: '1', reward_type: 'ranking', amount: 3,
      status: 'credited', created_at: '2026-07-01T00:00:00Z', metadata: { outcome: 'win', rp: 3 },
    }],
    trackTables: tracked,
  });
  await fetchRankingCasualHistorialEvents(db, { id: U1 }, { sourceLimit: 20 });
  assert.equal(tracked.has('rankings_leaderboard'), false);
  assert.equal(tracked.has('match_reward_events'), true);
});

test('16. Registro Ranking sin fecha válida se excluye', () => {
  const r = tryNormalizeRankingCasualEvent({
    id: 1, match_id: '1', reward_type: 'ranking', amount: 3, status: 'credited',
    metadata: { outcome: 'win', rp: 3 },
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sin_fecha');
});

test('17. Registro asistencia sin fecha válida se excluye', () => {
  const r = tryNormalizeAsistenciaEvent({
    id: 1, match_id: '1', attendance_status: 'confirmed',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sin_fecha');
});

test('18. Estado de asistencia desconocido se excluye', () => {
  assert.equal(mapAsistenciaEstadoPublico({ attendance_status: 'weird_status' }), null);
  const r = tryNormalizeAsistenciaEvent({
    id: 1, match_id: '1', attendance_status: 'weird_status', created_at: '2026-07-01T00:00:00Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'estado_desconocido');
});

test('19. No aparecen textos ni estados de empate', () => {
  const r = tryNormalizeRankingCasualEvent({
    id: 1, match_id: '1', reward_type: 'ranking', amount: 3, status: 'credited',
    created_at: '2026-07-01T00:00:00Z', metadata: { outcome: 'win', rp: 3 },
  });
  assert.equal(r.ok, true);
  assert.equal(/\bempate\b|\bempatado\b|\bempataron\b/.test(JSON.stringify(r.event).toLowerCase()), false);

  const emp = tryNormalizeRankingCasualEvent({
    id: 2, match_id: '1', reward_type: 'ranking', amount: 0, status: 'credited',
    created_at: '2026-07-01T00:00:00Z', metadata: { outcome: 'empate', rp: 0 },
  });
  assert.equal(emp.ok, false);
  assert.equal(containsEmpateSignal({ outcome: 'empate' }), true);
});

test('20-22. Filtros tipos ranking_casual / asistencia / combinado', () => {
  assert.deepEqual(parseHistorialTipos('ranking_casual'), ['ranking_casual']);
  assert.deepEqual(parseHistorialTipos('asistencia'), ['asistencia']);
  assert.deepEqual(
    parseHistorialTipos('reserva,ranking_casual,asistencia'),
    ['reserva', 'ranking_casual', 'asistencia'],
  );
});

test('23-25. Filtros fecha y sede sobre eventos fase 3', () => {
  const rk = tryNormalizeRankingCasualEvent({
    id: 1, match_id: '1', reward_type: 'ranking', amount: 3, status: 'credited',
    created_at: '2026-06-01T00:00:00Z', metadata: { outcome: 'win', rp: 3 },
  }, { sede_id: 5 }).event;
  const as = tryNormalizeAsistenciaEvent({
    id: 2, match_id: '2', attendance_status: 'confirmed',
    attendance_confirmed_at: '2026-07-01T00:00:00Z', created_at: '2026-06-15T00:00:00Z',
  }, { sede_id: 5 }).event;
  const filtered = filterHistorialEvents([rk, as], {
    tipos: ['ranking_casual', 'asistencia'],
    fecha_desde: '2026-06-15T00:00:00.000Z',
    fecha_hasta: '2026-07-15T00:00:00.000Z',
    sede_id: 5,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].tipo, 'asistencia');
});

test('26-27. Cursor estable con igual fecha y segunda página sin duplicados', () => {
  const events = [1, 2, 3].map((n) => tryNormalizeRankingCasualEvent({
    id: n, match_id: String(n), reward_type: 'ranking', amount: 3, status: 'credited',
    created_at: '2026-05-01T12:00:00.000Z', metadata: { outcome: 'win', rp: 3 },
  }).event);
  const sorted = filterHistorialEvents(events);
  const page1 = paginateHistorialEvents(sorted, 2);
  const page2 = paginateHistorialEvents(
    filterHistorialEvents(sorted, {
      cursor: { occurred_at: page1.items[1].occurred_at, id: page1.items[1].id },
    }),
    2,
  );
  assert.equal(page1.items.length, 2);
  assert.equal(page2.items.length, 1);
  const ids = [...page1.items, ...page2.items].map((i) => i.id);
  assert.equal(new Set(ids).size, 3);
});

test('28. Fuente Ranking vacía no rompe el endpoint', async () => {
  const db = createFase3Mock({ rewards: [] });
  const result = await getJugadorHistorial(db, { id: U1 }, { tipos: 'ranking_casual' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items, []);
});

test('29. Fuente asistencia vacía no rompe el endpoint', async () => {
  const db = createFase3Mock({ participants: [] });
  const result = await getJugadorHistorial(db, { id: U1 }, { tipos: 'asistencia' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items, []);
});

test('30. Error de consulta Ranking devuelve respuesta controlada', async () => {
  const db = createFase3Mock({ failTable: 'match_reward_events' });
  await assert.rejects(
    () => getJugadorHistorial(db, { id: U1 }, { tipos: 'ranking_casual' }),
    (err) => String(err.message).includes('boom'),
  );
});

test('31. Error de consulta asistencia devuelve respuesta controlada', async () => {
  const db = createFase3Mock({ failTable: 'match_participants' });
  await assert.rejects(
    () => getJugadorHistorial(db, { id: U1 }, { tipos: 'asistencia' }),
    (err) => String(err.message).includes('boom'),
  );
});

test('32. Campos internos y privados quedan excluidos', () => {
  const r = tryNormalizeRankingCasualEvent({
    id: 1, match_id: '1', reward_type: 'ranking', amount: 3, status: 'credited',
    created_at: '2026-07-01T00:00:00Z',
    source_key: 'secret|key',
    metadata: {
      outcome: 'win',
      rp: 3,
      movimiento_id: 'uuid',
      stats_delta: { empatados: 0 },
    },
  });
  assert.equal(r.ok, true);
  assert.equal(assertNoPrivateLeak(r.event), true);
  const blob = JSON.stringify(r.event);
  assert.equal(blob.includes('source_key'), false);
  assert.equal(blob.includes('movimiento_id'), false);
  assert.equal(blob.includes('stats_delta'), false);
  assert.equal(blob.includes('empatados'), false);

  const a = tryNormalizeAsistenciaEvent({
    id: 1, match_id: '1', attendance_status: 'confirmed',
    attendance_confirmed_at: '2026-07-01T00:00:00Z',
    attendance_denial_reason: 'secreto',
    created_at: '2026-07-01T00:00:00Z',
  });
  assert.equal(a.ok, true);
  assert.equal(JSON.stringify(a.event).includes('denial'), false);
  assert.equal(assertNoPrivateLeak(a.event), true);
});
