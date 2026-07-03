import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { generarKnockoutDesdeGrupos } from './torneos/generarKnockoutDesdeGruposService.js';
import { buildClasificacion } from './torneos/clasificacionService.js';

const TORNEO_ID = 99;

// Partido de grupo finalizado con resultado (goles_a/goles_b = sets ganados, legacy interno).
function gm(id, grupo, a, b, winner) {
  const winA = winner === a;
  return {
    id,
    torneo_id: TORNEO_ID,
    grupo,
    estado: 'finalizado',
    equipo_a_id: a,
    equipo_b_id: b,
    ganador_equipo_id: winner,
    resultado: { goles_a: winA ? 2 : 0, goles_b: winA ? 0 : 2 },
  };
}

// Grupo A (1,2,3,4): standings 1°=1, 2°=2. Grupo B (5,6,7,8): 1°=5, 2°=6.
function groupPartidos() {
  return [
    gm(1, 'A', 1, 2, 1), gm(2, 'A', 1, 3, 1), gm(3, 'A', 1, 4, 1),
    gm(4, 'A', 2, 3, 2), gm(5, 'A', 2, 4, 2), gm(6, 'A', 3, 4, 3),
    gm(7, 'B', 5, 6, 5), gm(8, 'B', 5, 7, 5), gm(9, 'B', 5, 8, 5),
    gm(10, 'B', 6, 7, 6), gm(11, 'B', 6, 8, 6), gm(12, 'B', 7, 8, 7),
  ];
}

const EQUIPOS = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ id: n, nombre: `Equipo ${n}` }));

function resolveSingle(state, ctx) {
  if (ctx.table === 'torneos') {
    if (state.errors.torneo) return { data: null, error: { message: 'torneo load fail' } };
    return { data: state.torneo, error: null };
  }
  return { data: null, error: null };
}

function resolveQuery(state, ctx) {
  if (ctx.table === 'equipos') return { data: state.equipos, error: null };
  if (ctx.table === 'partidos' && ctx.op === 'select') return { data: state.partidos, error: null };
  if (ctx.table === 'partidos' && ctx.op === 'insert') {
    if (state.errors.insert) return { data: null, error: { message: 'insert fail' } };
    const rows = ctx.payload.map((r, i) => ({ ...r, id: 1000 + i }));
    state.inserted = rows;
    return { data: rows, error: null };
  }
  if (ctx.table === 'partidos' && ctx.op === 'update') {
    state.updates.push({ id: ctx.filters.id, ...ctx.payload });
    return { error: null };
  }
  if (ctx.table === 'torneos') return { data: state.torneo, error: null };
  return { data: [], error: null };
}

function createMock(initial = {}) {
  const has = (key) => Object.prototype.hasOwnProperty.call(initial, key);
  const state = {
    torneo: has('torneo')
      ? initial.torneo
      : { id: TORNEO_ID, nombre: 'DEMO GK', sede_id: 1, tipo_torneo: 'grupos_knockout' },
    equipos: initial.equipos ?? EQUIPOS,
    partidos: initial.partidos ?? groupPartidos(),
    errors: initial.errors ?? {},
    inserted: null,
    updates: [],
  };

  const supabaseAdmin = {
    from(table) {
      const ctx = { table, op: 'select', filters: {}, payload: null };
      const builder = {
        select() { return builder; },
        insert(payload) { ctx.op = 'insert'; ctx.payload = payload; return builder; },
        update(payload) { ctx.op = 'update'; ctx.payload = payload; return builder; },
        eq(col, val) { ctx.filters[col] = val; return builder; },
        maybeSingle() { return Promise.resolve(resolveSingle(state, ctx)); },
        then(onF, onR) { return Promise.resolve(resolveQuery(state, ctx)).then(onF, onR); },
      };
      return builder;
    },
  };

  return { supabaseAdmin, state };
}

describe('generarKnockoutDesdeGrupos', () => {
  it('crea 3 partidos para 2 grupos x 4', async () => {
    const { supabaseAdmin } = createMock();
    const result = await generarKnockoutDesdeGrupos(supabaseAdmin, TORNEO_ID);
    assert.equal(result.ok, true);
    assert.equal(result.torneo_id, TORNEO_ID);
    assert.equal(result.formato, 'grupos_knockout');
    assert.equal(result.total, 3);
    assert.equal(result.partidos.length, 3);
  });

  it('cruces: semifinal 1 = 1A vs 2B, semifinal 2 = 1B vs 2A', async () => {
    const { supabaseAdmin } = createMock();
    const { partidos } = await generarKnockoutDesdeGrupos(supabaseAdmin, TORNEO_ID);
    const semi1 = partidos.find((p) => p.bracket_round === 1 && p.bracket_position === 1);
    const semi2 = partidos.find((p) => p.bracket_round === 1 && p.bracket_position === 2);
    // 1A=1, 2B=6, 1B=5, 2A=2
    assert.equal(semi1.equipo_a_id, 1);
    assert.equal(semi1.equipo_b_id, 6);
    assert.equal(semi2.equipo_a_id, 5);
    assert.equal(semi2.equipo_b_id, 2);
  });

  it('final vacía y links A/B correctos', async () => {
    const { supabaseAdmin } = createMock();
    const { partidos } = await generarKnockoutDesdeGrupos(supabaseAdmin, TORNEO_ID);
    const semi1 = partidos.find((p) => p.bracket_round === 1 && p.bracket_position === 1);
    const semi2 = partidos.find((p) => p.bracket_round === 1 && p.bracket_position === 2);
    const final = partidos.find((p) => p.bracket_round === 2);

    assert.equal(final.equipo_a_id, null);
    assert.equal(final.equipo_b_id, null);
    assert.ok(final.partido_siguiente_id == null);

    assert.equal(semi1.partido_siguiente_id, final.id);
    assert.equal(semi1.partido_siguiente_slot, 'A');
    assert.equal(semi2.partido_siguiente_id, final.id);
    assert.equal(semi2.partido_siguiente_slot, 'B');
  });

  it('partidos knockout con grupo null, ronda integer, sin fase/es_final', async () => {
    const { supabaseAdmin } = createMock();
    const { partidos } = await generarKnockoutDesdeGrupos(supabaseAdmin, TORNEO_ID);
    for (const p of partidos) {
      assert.equal(p.grupo, null);
      assert.equal(typeof p.ronda, 'number');
      assert.equal(p.ronda, p.bracket_round);
      assert.ok(!('fase' in p));
      assert.ok(!('es_final' in p));
    }
  });

  it('devuelve clasificados 1A/2A/1B/2B', async () => {
    const { supabaseAdmin } = createMock();
    const { clasificados } = await generarKnockoutDesdeGrupos(supabaseAdmin, TORNEO_ID);
    assert.deepEqual(
      clasificados.map((c) => ({ grupo: c.grupo, posicion: c.posicion, equipo_id: c.equipo_id })),
      [
        { grupo: 'A', posicion: 1, equipo_id: 1 },
        { grupo: 'A', posicion: 2, equipo_id: 2 },
        { grupo: 'B', posicion: 1, equipo_id: 5 },
        { grupo: 'B', posicion: 2, equipo_id: 6 },
      ],
    );
  });

  it('no contamina la tabla de grupos (partidos knockout excluidos)', async () => {
    const { supabaseAdmin } = createMock();
    const { partidos: knockoutPartidos } = await generarKnockoutDesdeGrupos(supabaseAdmin, TORNEO_ID);

    // La tabla recalculada con grupos + knockout debe mantener las mismas posiciones de grupo.
    const clasificacion = buildClasificacion({
      equipos: EQUIPOS,
      partidos: [...groupPartidos(), ...knockoutPartidos],
      tipoTorneo: 'grupos_knockout',
      scope: 'all',
    });
    assert.deepEqual(clasificacion.grupos.A.map((r) => r.equipo_id), [1, 2, 3, 4]);
    assert.deepEqual(clasificacion.grupos.B.map((r) => r.equipo_id), [5, 6, 7, 8]);
    // Los knockout (grupo null) no suman partidos considerados de más.
    assert.equal(clasificacion.metadata.partidos_considerados, 12);
  });

  it('tipo inválido → error 400', async () => {
    const { supabaseAdmin } = createMock({
      torneo: { id: TORNEO_ID, nombre: 'X', sede_id: 1, tipo_torneo: 'knockout' },
    });
    await assert.rejects(
      () => generarKnockoutDesdeGrupos(supabaseAdmin, TORNEO_ID),
      (err) => err.code === 'grupos_knockout_tipo_invalido' && err.status === 400,
    );
  });

  it('grupos incompletos → error 409', async () => {
    const partidos = groupPartidos();
    partidos[0].estado = 'pendiente';
    const { supabaseAdmin } = createMock({ partidos });
    await assert.rejects(
      () => generarKnockoutDesdeGrupos(supabaseAdmin, TORNEO_ID),
      (err) => err.code === 'grupos_incompletos' && err.status === 409,
    );
  });

  it('llave existente → error 409 (idempotencia)', async () => {
    const partidos = [
      ...groupPartidos(),
      { id: 500, torneo_id: TORNEO_ID, grupo: null, estado: 'pendiente', bracket_round: 1, bracket_position: 1 },
    ];
    const { supabaseAdmin, state } = createMock({ partidos });
    await assert.rejects(
      () => generarKnockoutDesdeGrupos(supabaseAdmin, TORNEO_ID),
      (err) => err.code === 'llave_existente' && err.status === 409,
    );
    assert.equal(state.inserted, null);
  });

  it('torneo inexistente → error 404', async () => {
    const { supabaseAdmin } = createMock({ torneo: null });
    await assert.rejects(
      () => generarKnockoutDesdeGrupos(supabaseAdmin, TORNEO_ID),
      (err) => err.code === 'torneo_not_found' && err.status === 404,
    );
  });

  it('id inválido → error 400', async () => {
    const { supabaseAdmin } = createMock();
    await assert.rejects(
      () => generarKnockoutDesdeGrupos(supabaseAdmin, 0),
      (err) => err.code === 'torneo_id_invalido' && err.status === 400,
    );
  });
});
