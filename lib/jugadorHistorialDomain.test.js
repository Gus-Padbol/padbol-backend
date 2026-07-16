import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  JUGADOR_HISTORIAL_LIMIT_DEFAULT,
  JUGADOR_HISTORIAL_LIMIT_MAX,
  assertNoPrivateLeak,
  buildHistorialEvent,
  combineFechaHora,
  compareHistorialEventsDesc,
  decodeHistorialCursor,
  encodeHistorialCursor,
  filterHistorialEvents,
  isHistorialEventAfterCursor,
  normalizeLogroEvent,
  normalizeMembresiaEvent,
  normalizePadcoinsEvent,
  normalizePartidoEvent,
  normalizeReservaEvent,
  paginateHistorialEvents,
  parseHistorialLimit,
  parseHistorialTipos,
} from './jugadorHistorialDomain.js';
import {
  getJugadorHistorial,
  parseHistorialQuery,
} from './jugadorHistorialService.js';
import { mountJugadorHistorialRoutes } from '../routes/jugadorHistorial.js';

const U1 = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const U2 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';

test('14. limit por defecto', () => {
  assert.equal(parseHistorialLimit(undefined), JUGADOR_HISTORIAL_LIMIT_DEFAULT);
  assert.equal(parseHistorialLimit(''), JUGADOR_HISTORIAL_LIMIT_DEFAULT);
});

test('15. limit máximo', () => {
  assert.equal(parseHistorialLimit('999'), JUGADOR_HISTORIAL_LIMIT_MAX);
  assert.equal(parseHistorialLimit('50'), 50);
  assert.throws(() => parseHistorialLimit('0'), (e) => e.status === 400);
});

test('tipos inválidos → 400 si ninguno es válido', () => {
  assert.throws(() => parseHistorialTipos('torneo,ranking'), (e) => e.status === 400);
  assert.deepEqual(parseHistorialTipos('reserva,torneo'), ['reserva']);
});

test('3. Normalización correcta de reservas', () => {
  const ev = normalizeReservaEvent({
    id: 123,
    fecha: '2026-07-16',
    hora: '15:00',
    sede_id: 1,
    estado: 'confirmada',
    cancha: '1',
    created_at: '2026-07-01T00:00:00Z',
  });
  assert.equal(ev.id, 'reserva:123');
  assert.equal(ev.tipo, 'reserva');
  assert.equal(ev.occurred_at, '2026-07-16T15:00:00.000Z');
  assert.equal(ev.sede_id, 1);
  assert.equal(ev.visibilidad, 'privada');
  assert.equal(ev.referencia.id, '123');
  assert.equal(ev.payload.estado, 'confirmada');
});

test('23. Registro sin fecha válida se excluye (reserva)', () => {
  assert.equal(normalizeReservaEvent({ id: 1, estado: 'ok' }), null);
  assert.equal(combineFechaHora('bad', '10:00'), null);
});

test('4. Normalización correcta de partidos', () => {
  const ev = normalizePartidoEvent({
    id: 9,
    fecha: '2026-07-10',
    hora: '18:30',
    sede_id: 2,
    estado: 'finalizado',
    deporte: 'padbol',
  });
  assert.equal(ev.id, 'partido:9');
  assert.equal(ev.occurred_at, '2026-07-10T18:30:00.000Z');
  assert.equal(ev.payload.deporte, 'padbol');
});

test('5. Normalización correcta de PadCoins', () => {
  const ev = normalizePadcoinsEvent({
    id: 77,
    tipo: 'earn',
    monto: 50,
    created_at: '2026-07-16T12:00:00.000Z',
    sede_id: 1,
    referencia_tipo: 'reserva',
    referencia_id: '55',
    saldo_despues: 150,
  });
  assert.equal(ev.id, 'padcoins:77');
  assert.match(ev.resumen, /earn/);
  assert.equal(ev.payload.monto, 50);
  assert.equal(ev.payload.referencia_tipo, 'reserva');
});

test('6. Normalización correcta de membresías', () => {
  const ev = normalizeMembresiaEvent({
    id: 3,
    sede_id: 1,
    plan_id: 9,
    estado: 'activa',
    origen: 'manual',
    inicio: '2026-06-01T00:00:00.000Z',
    vencimiento: '2026-07-01T00:00:00.000Z',
    created_at: '2026-05-01T00:00:00.000Z',
  });
  assert.equal(ev.id, 'membresia:3');
  assert.equal(ev.occurred_at, '2026-06-01T00:00:00.000Z');
  assert.equal(ev.payload.estado, 'activa');
});

test('7. Normalización correcta de logros', () => {
  const ev = normalizeLogroEvent({
    id: 12,
    slug: 'primer_partido',
    desbloqueado_en: '2026-07-05T10:00:00.000Z',
  });
  assert.equal(ev.id, 'logro:12');
  assert.equal(ev.payload.slug, 'primer_partido');
});

test('22. Logros no desbloqueados no aparecen (sin fecha de unlock)', () => {
  assert.equal(normalizeLogroEvent({ id: 1, slug: 'x' }), null);
});

test('8. Orden cronológico descendente', () => {
  const a = buildHistorialEvent({
    tipo: 'reserva', refId: 1, occurred_at: '2026-01-01T00:00:00Z', titulo: 'A', resumen: 'A',
  });
  const b = buildHistorialEvent({
    tipo: 'reserva', refId: 2, occurred_at: '2026-02-01T00:00:00Z', titulo: 'B', resumen: 'B',
  });
  assert.ok(compareHistorialEventsDesc(b, a) < 0);
  const sorted = filterHistorialEvents([a, b]);
  assert.equal(sorted[0].id, 'reserva:2');
});

test('9. Desempate estable por id', () => {
  const a = buildHistorialEvent({
    tipo: 'partido', refId: 'a', occurred_at: '2026-01-01T00:00:00Z', titulo: 'A', resumen: 'A',
  });
  const b = buildHistorialEvent({
    tipo: 'partido', refId: 'b', occurred_at: '2026-01-01T00:00:00Z', titulo: 'B', resumen: 'B',
  });
  const sorted = filterHistorialEvents([a, b]);
  assert.equal(sorted[0].id, 'partido:b');
  assert.equal(sorted[1].id, 'partido:a');
});

test('10. Filtro por tipos', () => {
  const events = [
    normalizeReservaEvent({ id: 1, fecha: '2026-01-01', hora: '10:00', created_at: '2026-01-01T00:00:00Z' }),
    normalizePadcoinsEvent({ id: 2, monto: 1, tipo: 'earn', created_at: '2026-01-02T00:00:00Z' }),
  ];
  const filtered = filterHistorialEvents(events, { tipos: ['padcoins'] });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].tipo, 'padcoins');
});

test('11. Filtro fecha_desde', () => {
  const events = [
    normalizePadcoinsEvent({ id: 1, monto: 1, created_at: '2026-01-01T00:00:00Z' }),
    normalizePadcoinsEvent({ id: 2, monto: 1, created_at: '2026-03-01T00:00:00Z' }),
  ];
  const filtered = filterHistorialEvents(events, { fecha_desde: '2026-02-01T00:00:00.000Z' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'padcoins:2');
});

test('12. Filtro fecha_hasta', () => {
  const events = [
    normalizePadcoinsEvent({ id: 1, monto: 1, created_at: '2026-01-01T00:00:00Z' }),
    normalizePadcoinsEvent({ id: 2, monto: 1, created_at: '2026-03-01T00:00:00Z' }),
  ];
  const filtered = filterHistorialEvents(events, { fecha_hasta: '2026-02-01T00:00:00.000Z' });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'padcoins:1');
});

test('13. Filtro sede_id excluye eventos sin sede', () => {
  const events = [
    normalizeLogroEvent({ id: 1, slug: 'x', desbloqueado_en: '2026-01-01T00:00:00Z' }),
    normalizeReservaEvent({ id: 2, fecha: '2026-01-02', hora: '10:00', sede_id: 5, created_at: '2026-01-02T00:00:00Z' }),
  ];
  const filtered = filterHistorialEvents(events, { sede_id: 5 });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].id, 'reserva:2');
});

test('16. Cursor y segunda página sin duplicados', () => {
  const events = [1, 2, 3, 4, 5].map((n) => normalizePadcoinsEvent({
    id: n,
    monto: n,
    created_at: `2026-01-0${n}T00:00:00.000Z`,
  }));
  const sorted = filterHistorialEvents(events);
  const page1 = paginateHistorialEvents(sorted, 2);
  assert.equal(page1.items.length, 2);
  assert.equal(page1.pagination.has_more, true);
  assert.ok(page1.pagination.next_cursor);

  const cursor = decodeHistorialCursor(page1.pagination.next_cursor);
  const page2Events = filterHistorialEvents(sorted, { cursor });
  const page2 = paginateHistorialEvents(page2Events, 2);
  const ids1 = new Set(page1.items.map((i) => i.id));
  for (const item of page2.items) {
    assert.equal(ids1.has(item.id), false);
  }
  assert.ok(isHistorialEventAfterCursor(page2.items[0], cursor));
});

test('17. Exclusión de campos privados', () => {
  const ev = normalizeReservaEvent({
    id: 1,
    fecha: '2026-01-01',
    hora: '10:00',
    estado: 'confirmada',
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(assertNoPrivateLeak(ev), true);
  assert.equal('email' in ev.payload, false);
  assert.equal('qr_token' in ev.payload, false);
});

test('encode/decode cursor roundtrip', () => {
  const ev = normalizePadcoinsEvent({ id: 9, monto: 1, created_at: '2026-01-01T00:00:00.000Z' });
  const c = encodeHistorialCursor(ev);
  const d = decodeHistorialCursor(c);
  assert.equal(d.id, 'padcoins:9');
  assert.equal(d.occurred_at, ev.occurred_at);
});

function createMockSupabase({
  reservas = [],
  partidos = [],
  joins = [],
  padcoins = [],
  membresias = [],
  logros = [],
  failSource = null,
} = {}) {
  return {
    from(table) {
      const state = {
        table,
        filters: {},
        inValues: null,
        orFilter: null,
        limit: null,
        order: [],
        selectCols: '*',
      };
      const api = {
        select(cols) { state.selectCols = cols; return api; },
        eq(col, val) { state.filters[col] = val; return api; },
        or(expr) { state.orFilter = expr; return api; },
        in(col, vals) { state.inValues = { col, vals }; return api; },
        order(col, opts) { state.order.push({ col, opts }); return api; },
        limit(n) { state.limit = n; return api; },
        then(resolve, reject) {
          Promise.resolve()
            .then(() => {
              if (failSource && failSource === table) {
                return { data: null, error: { message: 'boom supabase', code: 'XX' } };
              }
              if (table === 'reservas') {
                let rows = [...reservas];
                if (state.orFilter) {
                  // keep all mock rows (filters applied conceptually by fixture)
                }
                if (state.limit != null) rows = rows.slice(0, state.limit);
                return { data: rows, error: null };
              }
              if (table === 'partidos_abiertos_jugadores') {
                let rows = joins.filter((j) => !state.filters.user_id || j.user_id === state.filters.user_id);
                if (state.limit != null) rows = rows.slice(0, state.limit);
                return { data: rows, error: null };
              }
              if (table === 'partidos_abiertos') {
                let rows = [...partidos];
                if (state.filters.capitan_user_id) {
                  rows = rows.filter((p) => p.capitan_user_id === state.filters.capitan_user_id);
                }
                if (state.inValues?.col === 'id') {
                  const set = new Set(state.inValues.vals.map(String));
                  rows = rows.filter((p) => set.has(String(p.id)));
                }
                if (state.limit != null) rows = rows.slice(0, state.limit);
                return { data: rows, error: null };
              }
              if (table === 'padcoins_movimientos') {
                let rows = padcoins.filter((r) => !state.filters.user_id || r.user_id === state.filters.user_id);
                if (state.limit != null) rows = rows.slice(0, state.limit);
                return { data: rows, error: null };
              }
              if (table === 'membresias_sede') {
                let rows = membresias.filter((r) => !state.filters.user_id || r.user_id === state.filters.user_id);
                if (state.limit != null) rows = rows.slice(0, state.limit);
                return { data: rows, error: null };
              }
              if (table === 'logros_jugador') {
                let rows = logros.filter((r) => !state.filters.user_id || r.user_id === state.filters.user_id);
                if (state.limit != null) rows = rows.slice(0, state.limit);
                return { data: rows, error: null };
              }
              return { data: [], error: null };
            })
            .then(resolve, reject);
        },
      };
      return api;
    },
  };
}

test('2. Solo datos del usuario autenticado', async () => {
  const db = createMockSupabase({
    reservas: [
      { id: 1, fecha: '2026-01-01', hora: '10:00', created_at: '2026-01-01T00:00:00Z', sede_id: 1 },
    ],
    padcoins: [
      { id: 10, user_id: U1, monto: 5, tipo: 'earn', created_at: '2026-01-02T00:00:00Z' },
      { id: 11, user_id: U2, monto: 99, tipo: 'earn', created_at: '2026-01-03T00:00:00Z' },
    ],
    logros: [
      { id: 1, user_id: U1, slug: 'a', desbloqueado_en: '2026-01-04T00:00:00Z' },
      { id: 2, user_id: U2, slug: 'b', desbloqueado_en: '2026-01-05T00:00:00Z' },
    ],
  });
  const result = await getJugadorHistorial(db, { id: U1, email: 'a@test.com' }, {});
  const ids = result.data.items.map((i) => i.id);
  assert.ok(ids.includes('padcoins:10'));
  assert.equal(ids.includes('padcoins:11'), false);
  assert.ok(ids.includes('logro:1'));
  assert.equal(ids.includes('logro:2'), false);
});

test('18. Fuente vacía sin romper el endpoint', async () => {
  const db = createMockSupabase({});
  const result = await getJugadorHistorial(db, { id: U1, email: 'a@test.com' }, {});
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items, []);
  assert.equal(result.data.pagination.has_more, false);
});

test('19. Error controlado de una consulta', async () => {
  const db = createMockSupabase({ failSource: 'padcoins_movimientos' });
  await assert.rejects(
    () => getJugadorHistorial(db, { id: U1 }, { tipos: 'padcoins' }),
    (err) => String(err.message).includes('boom'),
  );
});

test('20. Fallback legacy por email en reservas (or filter)', async () => {
  let sawOr = false;
  const db = {
    from(table) {
      const api = {
        select() { return api; },
        or(expr) { sawOr = String(expr).includes('email.eq'); return api; },
        eq() { return api; },
        in() { return api; },
        order() { return api; },
        limit() { return api; },
        then(resolve) {
          if (table === 'reservas') {
            resolve({
              data: [{ id: 5, fecha: '2026-01-01', hora: '09:00', created_at: '2026-01-01T00:00:00Z' }],
              error: null,
            });
          } else {
            resolve({ data: [], error: null });
          }
        },
      };
      return api;
    },
  };
  const result = await getJugadorHistorial(db, { id: U1, email: 'legacy@test.com' }, { tipos: 'reserva' });
  assert.equal(sawOr, true);
  assert.equal(result.data.items[0].id, 'reserva:5');
});

test('21. Un mismo partido no se duplica', async () => {
  const db = createMockSupabase({
    joins: [{ partido_id: 7, user_id: U1 }],
    partidos: [
      {
        id: 7,
        capitan_user_id: U1,
        fecha: '2026-01-01',
        hora: '10:00',
        sede_id: 1,
        estado: 'abierto',
        created_at: '2026-01-01T00:00:00Z',
      },
    ],
  });
  const result = await getJugadorHistorial(db, { id: U1 }, { tipos: 'partido' });
  assert.equal(result.data.items.filter((i) => i.id === 'partido:7').length, 1);
});

test('1. JWT ausente → 401', async () => {
  const app = express();
  const router = express.Router();
  mountJugadorHistorialRoutes(router, {
    supabaseAdmin: createMockSupabase({}),
    getAuthenticatedUser: async () => ({ user: null, status: 401, error: 'Se requiere Authorization Bearer token' }),
  });
  app.use('/api/jugador', router);

  const server = app.listen(0);
  const port = server.address().port;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/jugador/historial`);
    assert.equal(res.status, 401);
    const body = await res.json();
    assert.ok(body.error);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('parseHistorialQuery valida rango de fechas', () => {
  assert.throws(
    () => parseHistorialQuery({ fecha_desde: '2026-03-01', fecha_hasta: '2026-01-01' }),
    (e) => e.status === 400,
  );
});
