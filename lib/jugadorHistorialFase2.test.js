import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertNoPrivateLeak,
  containsEmpateSignal,
  filterHistorialEvents,
  normalizeHistorialSets,
  normalizeTorneoEvent,
  paginateHistorialEvents,
  parseHistorialTipos,
  resolveTorneoOccurredAt,
  tryNormalizeResultadoCasual,
  tryNormalizeResultadoTorneo,
} from './jugadorHistorialDomain.js';
import {
  fetchResultadoHistorialEvents,
  fetchTorneoHistorialEvents,
  getJugadorHistorial,
} from './jugadorHistorialService.js';

const U1 = 'aaaaaaaa-bbbb-cccc-dddd-111111111111';
const U2 = 'aaaaaaaa-bbbb-cccc-dddd-222222222222';

test('1. Normalización correcta de evento torneo', () => {
  const ev = normalizeTorneoEvent({
    torneo_id: 10,
    user_id: U1,
    inscrito_at: '2026-06-01T12:00:00.000Z',
    nombre: 'Open La Meca',
    sede_id: 1,
    deporte: 'padbol',
    estado_inscripcion: 'inscripto',
    equipo_id: 55,
    equipo_nombre: 'Los Pibes',
    posicion: 2,
  }, U1);
  assert.equal(ev.tipo, 'torneo');
  assert.equal(ev.id, `torneo:10:${U1}`);
  assert.equal(ev.referencia.tipo, 'torneo');
  assert.equal(ev.referencia.id, '10');
  assert.equal(ev.payload.equipo_nombre, 'Los Pibes');
  assert.equal(ev.payload.posicion, 2);
  assert.equal(ev.occurred_at, '2026-06-01T12:00:00.000Z');
});

test('25. Torneo sin fecha válida se excluye (inicio futuro sin inscripción)', () => {
  const future = new Date(Date.now() + 86400000).toISOString();
  assert.equal(resolveTorneoOccurredAt({ fecha_inicio: future }), null);
  assert.equal(normalizeTorneoEvent({
    torneo_id: 1,
    fecha_inicio: future,
  }, U1), null);
});

test('2. Normalización correcta de resultado casual', () => {
  const r = tryNormalizeResultadoCasual({
    id: 9,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 0 },
    resultado_json: { historial_sets: [{ set: 1, a: 6, b: 3 }, { set: 2, a: 6, b: 4 }] },
    sede_id: 1,
    deporte: 'padbol',
    fecha: '2026-07-01',
    hora: '20:00',
    confirmado_at: null,
    resultado_json_confirm: null,
  });
  // confirmado_at inside resultado_json
  const r2 = tryNormalizeResultadoCasual({
    id: 9,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 0 },
    resultado_json: {
      confirmado_at: '2026-07-01T23:00:00.000Z',
      historial_sets: [{ set: 1, a: 6, b: 3 }, { set: 2, a: 6, b: 4 }],
    },
    sede_id: 1,
    deporte: 'padbol',
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.event.id, 'resultado:casual:9');
  assert.equal(r2.event.referencia.tipo, 'partido');
  assert.equal(r2.event.payload.origen, 'casual');
  assert.equal(r2.event.payload.ganador, 'equipo1');
  assert.equal(r2.event.payload.sets.length, 2);
  assert.ok(!containsEmpateSignal(r2.event));
  assert.equal(r.ok, true); // fecha programada como fallback
});

test('3. Normalización correcta de resultado de torneo', () => {
  const equiposById = new Map([
    [1, { id: 1, nombre: 'Equipo A' }],
    [2, { id: 2, nombre: 'Equipo B' }],
  ]);
  const r = tryNormalizeResultadoTorneo({
    id: 100,
    torneo_id: 7,
    estado: 'finalizado',
    equipo_a_id: 1,
    equipo_b_id: 2,
    ganador_equipo_id: 1,
    resultado: { goles_a: 2, goles_b: 1, historial_sets: [{ a: 6, b: 4 }, { a: 3, b: 6 }, { a: 6, b: 2 }] },
    updated_at: '2026-07-10T18:00:00.000Z',
    sede_id: 3,
  }, { equiposById });
  assert.equal(r.ok, true);
  assert.equal(r.event.id, 'resultado:torneo:100');
  assert.equal(r.event.payload.origen, 'torneo');
  assert.equal(r.event.payload.ganador.equipo_id, '1');
  assert.equal(r.event.payload.sets.length, 3);
  assert.equal(r.event.payload.marcador.texto, '2-1');

  // Forma real en prod: ganador_id + sets con equipo_a/equipo_b + fecha_hora
  const prod = tryNormalizeResultadoTorneo({
    id: 22,
    torneo_id: 21,
    estado: 'finalizado',
    equipo_a_id: 57,
    equipo_b_id: 58,
    resultado: {
      sets: [{ equipo_a: 6, equipo_b: 3 }, { equipo_a: 6, equipo_b: 4 }],
      ganador_id: 57,
    },
    fecha_hora: '2026-05-19T18:00:00',
    sede_id: 1,
  }, {
    equiposById: new Map([
      [57, { id: 57, nombre: 'Locales' }],
      [58, { id: 58, nombre: 'Visitantes' }],
    ]),
  });
  assert.equal(prod.ok, true);
  assert.equal(prod.event.payload.ganador.equipo_id, '57');
  assert.equal(prod.event.payload.marcador.texto, '2-0');
  assert.equal(prod.event.payload.sets.length, 2);
  assert.equal(prod.event.payload.sets[0].a, 6);
});

test('7. Partido no finalizado no genera resultado', () => {
  const r = tryNormalizeResultadoCasual({
    id: 1,
    estado: 'abierto',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 0 },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'no_finalizado');
});

test('8. Partido cancelado no genera resultado', () => {
  const r = tryNormalizeResultadoCasual({
    id: 1,
    estado: 'cancelado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 0 },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'cancelado');
});

test('9. Resultado sin ganador no aparece', () => {
  const r = tryNormalizeResultadoCasual({
    id: 1,
    estado: 'finalizado',
    ganador: null,
    resultado: { equipo1: 2, equipo2: 0 },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'sin_ganador');
});

test('10. Resultado empatado legacy no aparece', () => {
  const r = tryNormalizeResultadoCasual({
    id: 1,
    estado: 'finalizado',
    ganador: 'empate',
    resultado: { equipo1: 1, equipo2: 1 },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'empate');

  const t = tryNormalizeResultadoTorneo({
    id: 2,
    estado: 'finalizado',
    equipo_a_id: 1,
    equipo_b_id: 2,
    resultado: { goles_a: 1, goles_b: 1 },
    created_at: '2026-01-01T00:00:00Z',
  });
  assert.equal(t.ok, false);
  assert.equal(t.reason, 'empate');
});

test('11. Padbol no devuelve estados ni textos de empate', () => {
  const r = tryNormalizeResultadoCasual({
    id: 3,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 1 },
    resultado_json: { confirmado_at: '2026-01-01T00:00:00Z' },
  });
  assert.equal(r.ok, true);
  const blob = JSON.stringify(r.event).toLowerCase();
  assert.equal(/\bempate\b|\bempatado\b|\bempataron\b/.test(blob), false);
  assert.equal(containsEmpateSignal({ ganador: 'empate' }), true);
  assert.equal(containsEmpateSignal({ ganador: 'equipo1' }), false);
});

test('12. Sets válidos se incluyen', () => {
  assert.equal(normalizeHistorialSets([{ a: 6, b: 4 }, { a: 6, b: 3 }]).length, 2);
});

test('13. Logs punto por punto no se incluyen', () => {
  const r = tryNormalizeResultadoCasual({
    id: 4,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 0 },
    resultado_json: {
      confirmado_at: '2026-01-01T00:00:00Z',
      historial_puntos: [{ score_a: 15, score_b: 0 }],
      historial_sets: [{ a: 6, b: 2 }],
    },
  });
  assert.equal(r.ok, true);
  assert.equal('historial_puntos' in r.event.payload, false);
  assert.equal(JSON.stringify(r.event).includes('historial_puntos'), false);
  assert.equal(r.event.payload.sets.length, 1);
});

test('14. Sin sets confiables devuelve array vacío', () => {
  const r = tryNormalizeResultadoCasual({
    id: 5,
    estado: 'finalizado',
    ganador: 'equipo2',
    resultado: { equipo1: 0, equipo2: 2 },
    resultado_json: { confirmado_at: '2026-01-01T00:00:00Z' },
  });
  assert.equal(r.ok, true);
  assert.deepEqual(r.event.payload.sets, []);
});

test('15-17. Filtros tipos torneo/resultado/combinado', () => {
  assert.deepEqual(parseHistorialTipos('torneo'), ['torneo']);
  assert.deepEqual(parseHistorialTipos('resultado'), ['resultado']);
  assert.deepEqual(
    parseHistorialTipos('reserva,resultado,torneo'),
    ['reserva', 'resultado', 'torneo'],
  );
});

test('18-20. Filtros fecha y sede sobre eventos fase 2', () => {
  const torneo = normalizeTorneoEvent({
    torneo_id: 1,
    inscrito_at: '2026-03-01T00:00:00Z',
    sede_id: 9,
    nombre: 'T',
  }, U1);
  const res = tryNormalizeResultadoCasual({
    id: 8,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 0 },
    resultado_json: { confirmado_at: '2026-04-01T00:00:00Z' },
    sede_id: 9,
  }).event;
  const filtered = filterHistorialEvents([torneo, res], {
    tipos: ['torneo', 'resultado'],
    fecha_desde: '2026-03-15T00:00:00.000Z',
    fecha_hasta: '2026-04-15T00:00:00.000Z',
    sede_id: 9,
  });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].tipo, 'resultado');
});

test('21-22. Cursor estable con misma fecha y sin duplicados', () => {
  const events = [1, 2, 3].map((n) => tryNormalizeResultadoCasual({
    id: n,
    estado: 'finalizado',
    ganador: 'equipo1',
    resultado: { equipo1: 2, equipo2: 0 },
    resultado_json: { confirmado_at: '2026-05-01T12:00:00.000Z' },
  }).event);
  const sorted = filterHistorialEvents(events);
  const page1 = paginateHistorialEvents(sorted, 2);
  const page2 = paginateHistorialEvents(
    filterHistorialEvents(sorted, {
      cursor: {
        occurred_at: page1.items[1].occurred_at,
        id: page1.items[1].id,
      },
    }),
    2,
  );
  assert.equal(page1.items.length, 2);
  assert.equal(page2.items.length, 1);
  assert.equal(page2.items[0].id, 'resultado:casual:1');
  const allIds = [...page1.items, ...page2.items].map((i) => i.id);
  assert.equal(new Set(allIds).size, 3);
});

test('24. Campos privados excluidos', () => {
  const ev = normalizeTorneoEvent({
    torneo_id: 1,
    inscrito_at: '2026-01-01T00:00:00Z',
    nombre: 'Open',
  }, U1);
  assert.equal(assertNoPrivateLeak(ev), true);
});

function createFase2Mock({
  jugadoresTorneo = [],
  equiposJugadores = [],
  equipos = [],
  tablaPuntos = [],
  torneos = [],
  partidosAbiertos = [],
  joins = [],
  partidosTorneo = [],
  failTable = null,
} = {}) {
  return {
    from(table) {
      const state = {
        filters: {},
        inValues: null,
        orFilter: null,
        notFilter: null,
        limit: null,
        eqEstado: null,
      };
      const api = {
        select() { return api; },
        eq(col, val) {
          state.filters[col] = val;
          if (col === 'estado') state.eqEstado = val;
          return api;
        },
        or(expr) { state.orFilter = expr; return api; },
        in(col, vals) { state.inValues = { col, vals }; return api; },
        not(col, op, val) { state.notFilter = { col, op, val }; return api; },
        order() { return api; },
        limit(n) { state.limit = n; return api; },
        then(resolve, reject) {
          Promise.resolve().then(() => {
            if (failTable === table) {
              return { data: null, error: { message: 'boom fase2', code: 'XX' } };
            }
            if (table === 'jugadores_torneo') {
              return { data: jugadoresTorneo, error: null };
            }
            if (table === 'equipos_jugadores') {
              let rows = equiposJugadores;
              if (state.filters.user_id) {
                rows = rows.filter((r) => r.user_id === state.filters.user_id);
              }
              return { data: rows, error: null };
            }
            if (table === 'equipos') {
              let rows = [...equipos];
              if (state.inValues?.col === 'id') {
                const set = new Set(state.inValues.vals.map(String));
                rows = rows.filter((e) => set.has(String(e.id)));
              }
              if (state.inValues?.col === 'torneo_id') {
                const set = new Set(state.inValues.vals.map(String));
                rows = rows.filter((e) => set.has(String(e.torneo_id)));
              }
              if (state.notFilter?.col === 'torneo_id') {
                rows = rows.filter((e) => e.torneo_id != null);
              }
              return { data: rows, error: null };
            }
            if (table === 'tabla_puntos') {
              return { data: tablaPuntos, error: null };
            }
            if (table === 'torneos') {
              let rows = [...torneos];
              if (state.inValues?.col === 'id') {
                const set = new Set(state.inValues.vals.map(String));
                rows = rows.filter((t) => set.has(String(t.id)));
              }
              return { data: rows, error: null };
            }
            if (table === 'partidos_abiertos_jugadores') {
              let rows = joins;
              if (state.filters.user_id) {
                rows = rows.filter((j) => j.user_id === state.filters.user_id);
              }
              return { data: rows, error: null };
            }
            if (table === 'partidos_abiertos') {
              let rows = [...partidosAbiertos];
              if (state.filters.capitan_user_id) {
                rows = rows.filter((p) => p.capitan_user_id === state.filters.capitan_user_id);
              }
              if (state.inValues?.col === 'id') {
                const set = new Set(state.inValues.vals.map(String));
                rows = rows.filter((p) => set.has(String(p.id)));
              }
              return { data: rows, error: null };
            }
            if (table === 'partidos') {
              let rows = [...partidosTorneo];
              if (state.eqEstado) {
                rows = rows.filter((p) => String(p.estado).toLowerCase() === String(state.eqEstado).toLowerCase());
              }
              if (state.orFilter) {
                const ids = [...state.orFilter.matchAll(/(\d+)/g)].map((m) => Number(m[1]));
                const set = new Set(ids);
                rows = rows.filter((p) => set.has(Number(p.equipo_a_id)) || set.has(Number(p.equipo_b_id)));
              }
              return { data: rows, error: null };
            }
            return { data: [], error: null };
          }).then(resolve, reject);
        },
      };
      return api;
    },
  };
}

test('4. Inscripción duplicada en varias fuentes → un solo evento torneo', async () => {
  const db = createFase2Mock({
    jugadoresTorneo: [{
      torneo_id: 10,
      created_at: '2026-06-01T00:00:00Z',
      estado: 'inscripto',
      torneos: { id: 10, nombre: 'Open', sede_id: 1, fecha_inicio: '2026-06-10', deporte: 'padbol' },
    }],
    equiposJugadores: [{ equipo_id: 55, user_id: U1, estado: 'aceptado', created_at: '2026-06-01T00:00:00Z' }],
    equipos: [{
      id: 55,
      nombre: 'Los Pibes',
      torneo_id: 10,
      jugadores: [{ user_id: U1 }],
    }],
    tablaPuntos: [{ equipo_id: 55, torneo_id: 10, posicion: 1 }],
  });
  const { events } = await fetchTorneoHistorialEvents(db, { id: U1, email: 'a@t.com' }, { sourceLimit: 50 });
  assert.equal(events.filter((e) => e.referencia.id === '10').length, 1);
  assert.equal(events[0].payload.equipo_nombre, 'Los Pibes');
  assert.equal(events[0].payload.posicion, 1);
});

test('5. Partido casual ajeno no aparece', async () => {
  const db = createFase2Mock({
    joins: [{ partido_id: 1, user_id: U2 }],
    partidosAbiertos: [{
      id: 1,
      estado: 'finalizado',
      ganador: 'equipo1',
      resultado: { equipo1: 2, equipo2: 0 },
      resultado_json: { confirmado_at: '2026-01-01T00:00:00Z' },
      capitan_user_id: U2,
    }],
  });
  const { events } = await fetchResultadoHistorialEvents(db, { id: U1 }, { sourceLimit: 50 });
  assert.equal(events.length, 0);
});

test('6. Partido de torneo ajeno no aparece', async () => {
  const db = createFase2Mock({
    equiposJugadores: [{ equipo_id: 99, user_id: U1, estado: 'aceptado' }],
    equipos: [{ id: 99, nombre: 'X', torneo_id: 1, jugadores: [{ user_id: U1 }] }],
    partidosTorneo: [{
      id: 500,
      torneo_id: 1,
      estado: 'finalizado',
      equipo_a_id: 1,
      equipo_b_id: 2,
      ganador_equipo_id: 1,
      resultado: { goles_a: 2, goles_b: 0 },
      updated_at: '2026-01-01T00:00:00Z',
    }],
    torneos: [{ id: 1, sede_id: 1, deporte: 'padbol' }],
  });
  const { events } = await fetchResultadoHistorialEvents(db, { id: U1 }, { sourceLimit: 50 });
  assert.equal(events.length, 0);
});

test('23. Fallback legacy por email en torneos', async () => {
  let sawEmailOr = false;
  const db = {
    from(table) {
      const api = {
        select() { return api; },
        or(expr) {
          if (table === 'jugadores_torneo' && String(expr).includes('email.eq')) sawEmailOr = true;
          return api;
        },
        eq() { return api; },
        in() { return api; },
        not() { return api; },
        order() { return api; },
        limit() { return api; },
        then(resolve) {
          if (table === 'jugadores_torneo') {
            resolve({
              data: [{
                torneo_id: 3,
                created_at: '2026-02-01T00:00:00Z',
                torneos: { id: 3, nombre: 'Legacy Cup', sede_id: 2, fecha_inicio: '2026-02-10' },
              }],
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
  const { events } = await fetchTorneoHistorialEvents(
    db,
    { id: U1, email: 'legacy@test.com' },
    { sourceLimit: 20 },
  );
  assert.equal(sawEmailOr, true);
  assert.equal(events[0].payload.nombre, 'Legacy Cup');
});

test('26. Fuentes vacías no rompen el endpoint', async () => {
  const db = createFase2Mock({});
  const result = await getJugadorHistorial(db, { id: U1, email: 'a@t.com' }, { tipos: 'torneo,resultado' });
  assert.equal(result.ok, true);
  assert.deepEqual(result.data.items, []);
});

test('27. Error de consulta controlado', async () => {
  const db = createFase2Mock({ failTable: 'jugadores_torneo' });
  await assert.rejects(
    () => getJugadorHistorial(db, { id: U1, email: 'a@t.com' }, { tipos: 'torneo' }),
    (err) => String(err.message).includes('boom'),
  );
});

test('resultado propio de torneo aparece', async () => {
  const db = createFase2Mock({
    equiposJugadores: [{ equipo_id: 1, user_id: U1, estado: 'aceptado' }],
    equipos: [{ id: 1, nombre: 'Nosotros', torneo_id: 7, jugadores: [{ user_id: U1 }] }],
    partidosTorneo: [{
      id: 77,
      torneo_id: 7,
      estado: 'finalizado',
      equipo_a_id: 1,
      equipo_b_id: 2,
      ganador_equipo_id: 1,
      resultado: { goles_a: 2, goles_b: 0, historial_sets: [{ a: 6, b: 1 }, { a: 6, b: 2 }] },
      updated_at: '2026-07-01T10:00:00.000Z',
    }],
    torneos: [{ id: 7, sede_id: 1, deporte: 'padbol' }],
  });
  // need equipo 2 name optional
  db._equipos2 = true;
  const result = await getJugadorHistorial(db, { id: U1 }, { tipos: 'resultado' });
  assert.equal(result.data.items.length, 1);
  assert.equal(result.data.items[0].id, 'resultado:torneo:77');
  assert.equal(result.data.items[0].payload.sets.length, 2);
});
