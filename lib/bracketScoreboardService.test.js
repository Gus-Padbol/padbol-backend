import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ensureScoreboardForCompletedBracketPartido } from './torneos/bracketScoreboardService.js';

function resolveSingle(state, ctx) {
  if (ctx.table === 'partidos') {
    if (state.errors.partidoLoad) return { data: null, error: { message: 'partido load fail' } };
    const idFilter = ctx.filters.id;
    const match = state.partido && Number(state.partido.id) === Number(idFilter);
    return { data: match ? state.partido : null, error: null };
  }
  if (ctx.table === 'torneos') {
    return { data: state.torneo ?? null, error: null };
  }
  return { data: null, error: null };
}

function resolveQuery(state, ctx) {
  if (ctx.op === 'insert' && ctx.table === 'scoreboard_partidos') {
    if (state.errors.insert) return { data: null, error: { message: 'insert fail' } };
    const row = { id: state.nextScoreboardId, ...ctx.payload };
    state.inserted = row;
    return { data: [row], error: null };
  }
  if (ctx.op === 'update' && ctx.table === 'scoreboard_partidos') {
    if (state.errors.tokenUpdate) return { error: { message: 'token update fail' } };
    state.tokenUpdate = { id: ctx.filters.id, patch: ctx.payload };
    return { error: null };
  }
  if (ctx.op === 'select' && ctx.table === 'scoreboard_partidos') {
    if (state.errors.existingLookup) return { data: null, error: { message: 'lookup fail' } };
    const target = ctx.filters.partido_torneo_id;
    const data = state.scoreboards.filter(
      (sb) => Number(sb.partido_torneo_id) === Number(target),
    );
    return { data, error: null };
  }
  if (ctx.op === 'select' && ctx.table === 'equipos') {
    const ids = (ctx.filters.id ?? []).map(Number);
    const data = state.equipos.filter((eq) => ids.includes(Number(eq.id)));
    return { data, error: null };
  }
  return { data: [], error: null };
}

function createMock(initial = {}) {
  const state = {
    partido: initial.partido ?? null,
    scoreboards: initial.scoreboards ? [...initial.scoreboards] : [],
    torneo: initial.torneo ?? null,
    equipos: initial.equipos ? [...initial.equipos] : [],
    errors: initial.errors ?? {},
    nextScoreboardId: initial.nextScoreboardId ?? 'sb-new-1',
    inserted: null,
    tokenUpdate: null,
  };

  const supabaseAdmin = {
    from(table) {
      const ctx = { table, op: 'select', filters: {}, payload: null };
      const builder = {
        select() { return builder; },
        insert(payload) { ctx.op = 'insert'; ctx.payload = payload; return builder; },
        update(payload) { ctx.op = 'update'; ctx.payload = payload; return builder; },
        eq(col, val) { ctx.filters[col] = val; return builder; },
        in(col, vals) { ctx.filters[col] = vals; return builder; },
        limit() { return Promise.resolve(resolveQuery(state, ctx)); },
        maybeSingle() { return Promise.resolve(resolveSingle(state, ctx)); },
        then(onFulfilled, onRejected) {
          return Promise.resolve(resolveQuery(state, ctx)).then(onFulfilled, onRejected);
        },
      };
      return builder;
    },
  };

  return { supabaseAdmin, state };
}

const BASE_PARTIDO = {
  id: 47,
  torneo_id: 28,
  sede_id: 1,
  cancha: 'DEMO Bracket',
  estado: 'pendiente',
  equipo_a_id: 71,
  equipo_b_id: 74,
};

const BASE_EQUIPOS = [
  { id: 71, nombre: 'Demo Bracket A', jugadores: [] },
  { id: 74, nombre: 'Demo Bracket D', jugadores: [] },
];

const BASE_TORNEO = { id: 28, nombre: 'DEMO | Bracket', sede_id: 1 };

const stubDeps = {
  buildScoreboardInsertRow: ({ partido }) => ({
    partido_torneo_id: partido.id,
    torneo_id: partido.torneo_id,
    sede_id: partido.sede_id,
    estado: 'pendiente',
  }),
  persistControlTokenForScoreboard: async () => ({ controlToken: 'tok-abc-123' }),
};

describe('ensureScoreboardForCompletedBracketPartido', () => {
  it('failed si partido no existe', async () => {
    const { supabaseAdmin } = createMock({ partido: null });
    const result = await ensureScoreboardForCompletedBracketPartido(
      supabaseAdmin,
      { partidoId: 47 },
      stubDeps,
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'partido_not_found');
  });

  it('skipped si partido incompleto (slot null)', async () => {
    const { supabaseAdmin } = createMock({
      partido: { ...BASE_PARTIDO, equipo_b_id: null },
    });
    const result = await ensureScoreboardForCompletedBracketPartido(
      supabaseAdmin,
      { partidoId: 47 },
      stubDeps,
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'partido_incompleto');
  });

  it('skipped si estado finalizado', async () => {
    const { supabaseAdmin } = createMock({
      partido: { ...BASE_PARTIDO, estado: 'finalizado' },
    });
    const result = await ensureScoreboardForCompletedBracketPartido(
      supabaseAdmin,
      { partidoId: 47 },
      stubDeps,
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'estado_no_apto');
  });

  it('skipped si estado en_curso', async () => {
    const { supabaseAdmin } = createMock({
      partido: { ...BASE_PARTIDO, estado: 'en_curso' },
    });
    const result = await ensureScoreboardForCompletedBracketPartido(
      supabaseAdmin,
      { partidoId: 47 },
      stubDeps,
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'estado_no_apto');
  });

  it('skipped si ya existe scoreboard activo (no duplica)', async () => {
    const { supabaseAdmin, state } = createMock({
      partido: { ...BASE_PARTIDO },
      scoreboards: [{ id: 'sb-existing', partido_torneo_id: 47, estado: 'pendiente' }],
    });
    const result = await ensureScoreboardForCompletedBracketPartido(
      supabaseAdmin,
      { partidoId: 47 },
      stubDeps,
    );
    assert.equal(result.status, 'skipped');
    assert.equal(result.reason, 'scoreboard_existente');
    assert.equal(result.scoreboard_id, 'sb-existing');
    assert.equal(state.inserted, null);
  });

  it('crea scoreboard si el partido quedó completo y no hay scoreboard activo', async () => {
    const { supabaseAdmin, state } = createMock({
      partido: { ...BASE_PARTIDO },
      torneo: { ...BASE_TORNEO },
      equipos: BASE_EQUIPOS,
      nextScoreboardId: 'sb-created-1',
    });
    const result = await ensureScoreboardForCompletedBracketPartido(
      supabaseAdmin,
      { partidoId: 47 },
      stubDeps,
    );
    assert.equal(result.status, 'created');
    assert.equal(result.reason, 'scoreboard_creado');
    assert.equal(result.scoreboard_id, 'sb-created-1');
    assert.equal(result.control_token, 'tok-abc-123');
    assert.equal(state.inserted.partido_torneo_id, 47);
  });

  it('crea scoreboard aunque exista uno terminado previo (no lo cuenta como activo)', async () => {
    const { supabaseAdmin, state } = createMock({
      partido: { ...BASE_PARTIDO },
      torneo: { ...BASE_TORNEO },
      equipos: BASE_EQUIPOS,
      scoreboards: [{ id: 'sb-old', partido_torneo_id: 47, estado: 'terminado' }],
      nextScoreboardId: 'sb-created-2',
    });
    const result = await ensureScoreboardForCompletedBracketPartido(
      supabaseAdmin,
      { partidoId: 47 },
      stubDeps,
    );
    assert.equal(result.status, 'created');
    assert.equal(result.scoreboard_id, 'sb-created-2');
    assert.equal(state.inserted.partido_torneo_id, 47);
  });

  it('failed si falla el insert del scoreboard', async () => {
    const { supabaseAdmin } = createMock({
      partido: { ...BASE_PARTIDO },
      torneo: { ...BASE_TORNEO },
      equipos: BASE_EQUIPOS,
      errors: { insert: true },
    });
    const result = await ensureScoreboardForCompletedBracketPartido(
      supabaseAdmin,
      { partidoId: 47 },
      stubDeps,
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'scoreboard_insert_failed');
  });

  it('failed si falla la búsqueda de scoreboards existentes', async () => {
    const { supabaseAdmin } = createMock({
      partido: { ...BASE_PARTIDO },
      errors: { existingLookup: true },
    });
    const result = await ensureScoreboardForCompletedBracketPartido(
      supabaseAdmin,
      { partidoId: 47 },
      stubDeps,
    );
    assert.equal(result.status, 'failed');
    assert.equal(result.reason, 'scoreboard_lookup_failed');
  });

  it('crea scoreboard aunque falle la emisión del token (control_token null)', async () => {
    const { supabaseAdmin } = createMock({
      partido: { ...BASE_PARTIDO },
      torneo: { ...BASE_TORNEO },
      equipos: BASE_EQUIPOS,
      nextScoreboardId: 'sb-created-3',
    });
    const result = await ensureScoreboardForCompletedBracketPartido(
      supabaseAdmin,
      { partidoId: 47 },
      {
        ...stubDeps,
        persistControlTokenForScoreboard: async () => { throw new Error('token boom'); },
      },
    );
    assert.equal(result.status, 'created');
    assert.equal(result.scoreboard_id, 'sb-created-3');
    assert.equal(result.control_token, undefined);
  });
});
