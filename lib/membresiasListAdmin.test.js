/**
 * Tests — paginación server-side y filtros reales de GET /api/admin/membresias.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { requireAuthenticatedUser, requireAdminUser } from './authAccess.js';
import {
  MEMBRESIA_ESTADOS,
  MEMBRESIAS_LIST_DEFAULT_LIMIT,
  MEMBRESIAS_LIST_MAX_LIMIT,
  assertAdminSedeScope,
  assertMembresiaListItemSafe,
  buildMembresiaJugadorSearchOrFilter,
  buildMembresiasPagination,
  escapeMembresiaIlike,
  mapJugadorResumenMembresia,
  mapMembresiaPublica,
  parseMembresiasListQuery,
  shouldMarkExpired,
} from './membresiasDomain.js';
import { createMembresiasSedeService } from '../src/membresias/membresiasService.js';

function createMockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function roleDeps(roleRow) {
  return {
    getAuthenticatedUser: async () => ({ user: { id: 'u-1', email: 'a@b.com' } }),
    fetchUserRoleRowForAuthUser: async () => roleRow,
    legacySuperAdminEmails: [],
  };
}

/**
 * Mock supabase con conteo de queries y datos en memoria.
 */
function createSupabaseMock(seed = {}) {
  const tables = {
    membresias_sede: [...(seed.membresias_sede || [])],
    membresia_planes: [...(seed.membresia_planes || [])],
    jugadores_perfil: [...(seed.jugadores_perfil || [])],
  };
  const tracker = { queries: [], fromCalls: [] };

  function makeBuilder(table) {
    const state = {
      filtersEq: {},
      filtersIn: {},
      filtersIlike: {},
      orFilter: null,
      orderCol: null,
      ascending: false,
      rangeFrom: null,
      rangeTo: null,
      limit: null,
      wantCount: false,
      patch: null,
    };

    const applyFilters = (rows) => {
      let out = [...rows];
      for (const [col, val] of Object.entries(state.filtersEq)) {
        out = out.filter((r) => String(r[col]) === String(val));
      }
      for (const [col, vals] of Object.entries(state.filtersIn)) {
        const set = new Set(vals.map(String));
        out = out.filter((r) => set.has(String(r[col])));
      }
      for (const [col, pattern] of Object.entries(state.filtersIlike)) {
        const needle = String(pattern).replace(/%/g, '').toLowerCase();
        out = out.filter((r) => String(r[col] || '').toLowerCase().includes(needle));
      }
      if (state.orFilter) {
        const parts = String(state.orFilter).split(',').map((p) => p.trim());
        out = out.filter((r) => parts.some((part) => {
          const m = part.match(/^(\w+)\.ilike\."%(.+)%"$/);
          if (!m) return false;
          const [, col, raw] = m;
          return String(r[col] || '').toLowerCase().includes(String(raw).toLowerCase());
        }));
      }
      return out;
    };

    const builder = {
      select(_cols, opts) {
        if (opts?.count === 'exact') state.wantCount = true;
        return builder;
      },
      eq(col, val) {
        state.filtersEq[col] = val;
        return builder;
      },
      in(col, vals) {
        state.filtersIn[col] = vals;
        return builder;
      },
      ilike(col, pattern) {
        state.filtersIlike[col] = pattern;
        return builder;
      },
      or(filter) {
        state.orFilter = filter;
        return builder;
      },
      order(col, { ascending } = {}) {
        state.orderCol = col;
        state.ascending = Boolean(ascending);
        return builder;
      },
      range(from, to) {
        state.rangeFrom = from;
        state.rangeTo = to;
        return builder;
      },
      limit(n) {
        state.limit = n;
        return builder;
      },
      update(patch) {
        state.patch = patch;
        return builder;
      },
      maybeSingle() {
        return builder.then((res) => {
          const rows = res.data || [];
          return { data: rows[0] ?? null, error: null };
        });
      },
      single() {
        return builder.maybeSingle();
      },
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => {
            let rows = applyFilters(tables[table] || []);
            if (state.orderCol) {
              const col = state.orderCol;
              rows.sort((a, b) => {
                const av = a[col];
                const bv = b[col];
                if (av === bv) return 0;
                if (av == null) return 1;
                if (bv == null) return -1;
                return av > bv ? 1 : -1;
              });
              if (!state.ascending) rows.reverse();
            }
            const total = rows.length;
            if (state.patch) {
              const updated = [];
              for (const row of rows) {
                Object.assign(row, state.patch);
                updated.push({ ...row });
              }
              return { data: updated, error: null, count: updated.length };
            }
            if (state.rangeFrom != null && state.rangeTo != null) {
              rows = rows.slice(state.rangeFrom, state.rangeTo + 1);
            } else if (state.limit != null) {
              rows = rows.slice(0, state.limit);
            }
            return {
              data: rows.map((r) => ({ ...r })),
              error: null,
              count: state.wantCount ? total : null,
            };
          })
          .then(resolve, reject);
      },
    };
    return builder;
  }

  return {
    supabaseAdmin: {
      from(table) {
        tracker.fromCalls.push(table);
        return makeBuilder(table);
      },
    },
    tracker,
    tables,
  };
}

function seedData() {
  const planes = [
    { id: 1, sede_id: 10, nombre: 'Gold', precio: 1000, moneda: 'ARS', duracion_tipo: 'mensual', beneficios: { descuento_porcentual: 10 } },
    { id: 2, sede_id: 10, nombre: 'Silver', precio: 500, moneda: 'ARS', duracion_tipo: 'mensual', beneficios: {} },
    { id: 3, sede_id: 20, nombre: 'OtherSede', precio: 1, moneda: 'ARS', duracion_tipo: 'mensual', beneficios: {} },
  ];
  const perfiles = [
    { user_id: 'u-ana', nombre: 'Ana', apellido: 'Lopez', username: 'ana_l', alias: 'anita', email: 'ana@club.com' },
    { user_id: 'u-bob', nombre: 'Bob', apellido: 'Diaz', username: 'bobd', apodo: 'bobby', email: 'bob@club.com' },
    { user_id: 'u-cara', nombre: 'Cara', apellido: 'Ruiz', username: 'cara', alias: 'carita', email: 'cara@other.com' },
  ];
  const now = Date.now();
  const membresias = [];
  for (let i = 1; i <= 40; i += 1) {
    const user = i % 3 === 0 ? 'u-bob' : i % 2 === 0 ? 'u-ana' : 'u-cara';
    const planId = i % 2 === 0 ? 1 : 2;
    const estado = i % 5 === 0 ? 'suspendida' : i % 7 === 0 ? 'cancelada' : 'activa';
    membresias.push({
      id: i,
      user_id: user,
      email: perfiles.find((p) => p.user_id === user)?.email || null,
      sede_id: 10,
      plan_id: planId,
      estado,
      origen: 'manual',
      inicio: new Date(now - i * 86400000).toISOString(),
      vencimiento: new Date(now + (60 + i) * 86400000).toISOString(),
      renovacion_automatica: false,
      created_at: new Date(now - i * 3600000).toISOString(),
      updated_at: new Date(now - i * 3600000).toISOString(),
    });
  }
  // Membresía de otra sede (no debe filtrarse en sede 10)
  membresias.push({
    id: 999,
    user_id: 'u-cara',
    email: 'cara@other.com',
    sede_id: 20,
    plan_id: 3,
    estado: 'activa',
    origen: 'manual',
    inicio: new Date().toISOString(),
    vencimiento: new Date(now + 86400000 * 30).toISOString(),
    renovacion_automatica: false,
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  });
  return { membresia_planes: planes, jugadores_perfil: perfiles, membresias_sede: membresias };
}

describe('auth / scope membresías list', () => {
  it('1. sin JWT → 401', async () => {
    const res = createMockRes();
    const user = await requireAuthenticatedUser({}, res, async () => ({
      user: null,
      status: 401,
      error: 'Se requiere Authorization Bearer token',
    }));
    assert.equal(user, null);
    assert.equal(res.statusCode, 401);
  });

  it('2. rol no autorizado → 403', async () => {
    const res = createMockRes();
    const auth = await requireAdminUser({}, res, roleDeps({ role: 'jugador', sede_id: null }));
    assert.equal(auth, null);
    assert.equal(res.statusCode, 403);
  });

  it('3. admin_club solo ve su sede', () => {
    assert.equal(assertAdminSedeScope({ rol: 'admin_club', sede_id: 10 }, 10), null);
  });

  it('4. super_admin puede filtrar por sede', () => {
    assert.equal(assertAdminSedeScope({ rol: 'super_admin', sede_id: null }, 10), null);
  });

  it('5. admin_club no puede forzar otra sede', () => {
    assert.equal(assertAdminSedeScope({ rol: 'admin_club', sede_id: 10 }, 20)?.status, 403);
  });
});

describe('parseMembresiasListQuery', () => {
  it('6. page default = 1', () => {
    assert.equal(parseMembresiasListQuery({}).page, 1);
  });

  it('7. limit default = 15', () => {
    assert.equal(parseMembresiasListQuery({}).limit, MEMBRESIAS_LIST_DEFAULT_LIMIT);
    assert.equal(MEMBRESIAS_LIST_DEFAULT_LIMIT, 15);
  });

  it('8. limit máximo = 100', () => {
    assert.equal(parseMembresiasListQuery({ limit: '100' }).limit, 100);
    assert.equal(MEMBRESIAS_LIST_MAX_LIMIT, 100);
  });

  it('9. page inválido → 400', () => {
    assert.throws(() => parseMembresiasListQuery({ page: '0' }), (e) => e.status === 400);
    assert.throws(() => parseMembresiasListQuery({ page: 'abc' }), (e) => e.status === 400);
  });

  it('10. limit inválido → 400', () => {
    assert.throws(() => parseMembresiasListQuery({ limit: '0' }), (e) => e.status === 400);
    assert.throws(() => parseMembresiasListQuery({ limit: '101' }), (e) => e.status === 400);
  });

  it('30. sort inválido → 400', () => {
    assert.throws(() => parseMembresiasListQuery({ sort: 'password' }), (e) => e.status === 400);
  });

  it('31. direction inválida → 400', () => {
    assert.throws(() => parseMembresiasListQuery({ direction: 'sideways' }), (e) => e.status === 400);
  });
});

describe('listMembresiasAdmin paginación y filtros', () => {
  it('11–13. páginas, sin repetición, fuera de rango vacío', async () => {
    const { supabaseAdmin, tracker } = createSupabaseMock(seedData());
    const svc = createMembresiasSedeService({ supabaseAdmin });
    const role = { rol: 'super_admin', sede_id: null };

    const p1 = await svc.listMembresiasAdmin(role, {
      sedeId: 10,
      page: 1,
      limit: 15,
      tracker,
    });
    assert.equal(p1.membresias.length, 15);
    assert.equal(p1.pagination.page, 1);

    const p2 = await svc.listMembresiasAdmin(role, {
      sedeId: 10,
      page: 2,
      limit: 15,
    });
    assert.equal(p2.membresias.length, 15);
    const ids1 = new Set(p1.membresias.map((m) => m.id));
    for (const m of p2.membresias) assert.ok(!ids1.has(m.id));

    const pFar = await svc.listMembresiasAdmin(role, {
      sedeId: 10,
      page: 99,
      limit: 15,
    });
    assert.deepEqual(pFar.membresias, []);
    assert.ok(pFar.pagination.total > 0);
  });

  it('14–20. totals y flags de pagination', async () => {
    const { supabaseAdmin } = createSupabaseMock(seedData());
    const svc = createMembresiasSedeService({ supabaseAdmin });
    const role = { rol: 'admin_club', sede_id: 10 };

    const all = await svc.listMembresiasAdmin(role, { sedeId: 10, page: 1, limit: 100 });
    assert.equal(all.pagination.total, 40);
    assert.equal(all.pagination.total_pages, 1);
    assert.equal(all.pagination.has_next, false);
    assert.equal(all.pagination.has_previous, false);

    const byEstado = await svc.listMembresiasAdmin(role, {
      sedeId: 10,
      estado: 'suspendida',
      page: 1,
      limit: 15,
    });
    assert.ok(byEstado.pagination.total > 0);
    assert.ok(byEstado.membresias.every((m) => m.estado === 'suspendida'));

    const byPlan = await svc.listMembresiasAdmin(role, {
      sedeId: 10,
      plan_id: 1,
      page: 1,
      limit: 15,
    });
    assert.ok(byPlan.pagination.total > 0);
    assert.ok(byPlan.membresias.every((m) => Number(m.plan_id) === 1));

    const p1 = await svc.listMembresiasAdmin(role, { sedeId: 10, page: 1, limit: 15 });
    assert.equal(p1.pagination.has_next, true);
    assert.equal(p1.pagination.has_previous, false);
    const p2 = await svc.listMembresiasAdmin(role, { sedeId: 10, page: 2, limit: 15 });
    assert.equal(p2.pagination.has_previous, true);
  });

  it('21–22. estado y plan_id server-side', async () => {
    const { supabaseAdmin } = createSupabaseMock(seedData());
    const svc = createMembresiasSedeService({ supabaseAdmin });
    const role = { rol: 'super_admin', sede_id: null };
    const r = await svc.listMembresiasAdmin(role, {
      sedeId: 10,
      estado: 'cancelada',
      plan_id: 2,
      page: 1,
      limit: 50,
    });
    for (const m of r.membresias) {
      assert.equal(m.estado, 'cancelada');
      assert.equal(Number(m.plan_id), 2);
    }
  });

  it('23–27. búsqueda q por nombre/alias/email y sin filtrar otra sede', async () => {
    const { supabaseAdmin } = createSupabaseMock(seedData());
    const svc = createMembresiasSedeService({ supabaseAdmin });
    const role = { rol: 'admin_club', sede_id: 10 };

    const byName = await svc.listMembresiasAdmin(role, { sedeId: 10, q: 'Ana', page: 1, limit: 50 });
    assert.ok(byName.pagination.total > 0);
    assert.ok(byName.membresias.every((m) => m.user_id === 'u-ana'));

    const byAlias = await svc.listMembresiasAdmin(role, { sedeId: 10, q: 'bobby', page: 1, limit: 50 });
    assert.ok(byAlias.pagination.total > 0);
    assert.ok(byAlias.membresias.every((m) => m.user_id === 'u-bob'));

    const byEmail = await svc.listMembresiasAdmin(role, {
      sedeId: 10,
      q: 'ana@club.com',
      page: 1,
      limit: 50,
    });
    assert.ok(byEmail.pagination.total > 0);

    const none = await svc.listMembresiasAdmin(role, {
      sedeId: 10,
      q: 'zzzz-no-existe',
      page: 1,
      limit: 15,
    });
    assert.equal(none.pagination.total, 0);
    assert.deepEqual(none.membresias, []);

    // Cara existe en sede 10 y 20; q no debe devolver la de sede 20
    const cara = await svc.listMembresiasAdmin(role, { sedeId: 10, q: 'Cara', page: 1, limit: 100 });
    assert.ok(cara.membresias.every((m) => Number(m.sede_id) === 10));
    assert.ok(!cara.membresias.some((m) => Number(m.id) === 999));
  });

  it('28–29. orden created_at desc/asc', async () => {
    const { supabaseAdmin } = createSupabaseMock(seedData());
    const svc = createMembresiasSedeService({ supabaseAdmin });
    const role = { rol: 'super_admin', sede_id: null };
    const desc = await svc.listMembresiasAdmin(role, {
      sedeId: 10,
      sort: 'created_at',
      direction: 'desc',
      page: 1,
      limit: 5,
    });
    for (let i = 1; i < desc.membresias.length; i += 1) {
      // created_at no viaja en DTO público; ids en seed: menor id = más reciente
      assert.ok(desc.membresias[i - 1].id <= desc.membresias[i].id);
    }
    const asc = await svc.listMembresiasAdmin(role, {
      sedeId: 10,
      sort: 'created_at',
      direction: 'asc',
      page: 1,
      limit: 5,
    });
    for (let i = 1; i < asc.membresias.length; i += 1) {
      assert.ok(asc.membresias[i - 1].id >= asc.membresias[i].id);
    }
  });

  it('32–35. no N+1; queries constantes con 1 / 15 / 100', async () => {
    async function measure(n) {
      const seed = seedData();
      // Asegurar al menos n filas en sede 10
      while (seed.membresias_sede.filter((m) => m.sede_id === 10).length < n) {
        const i = seed.membresias_sede.length + 1;
        seed.membresias_sede.push({
          id: 1000 + i,
          user_id: 'u-ana',
          email: 'ana@club.com',
          sede_id: 10,
          plan_id: 1,
          estado: 'activa',
          origen: 'manual',
          inicio: new Date().toISOString(),
          vencimiento: new Date(Date.now() + 86400000).toISOString(),
          renovacion_automatica: false,
          created_at: new Date(Date.now() - i).toISOString(),
          updated_at: new Date().toISOString(),
        });
      }
      const { supabaseAdmin, tracker } = createSupabaseMock(seed);
      const svc = createMembresiasSedeService({ supabaseAdmin });
      const result = await svc.listMembresiasAdmin(
        { rol: 'super_admin', sede_id: null },
        { sedeId: 10, page: 1, limit: n, tracker },
      );
      assert.equal(result.membresias.length, Math.min(n, result.pagination.total));
      // Sin q ni expire: membresias_page + planes_batch + jugadores_batch = 3 labels
      // fromCalls: membresias_sede + membresia_planes + jugadores_perfil = 3
      assert.deepEqual(tracker.queries, ['membresias_page', 'planes_batch', 'jugadores_batch']);
      assert.equal(tracker.fromCalls.length, 3);
      assert.equal(tracker.fromCalls.filter((t) => t === 'membresia_planes').length, 1);
      assert.equal(tracker.fromCalls.filter((t) => t === 'jugadores_perfil').length, 1);
      return tracker.queries.length;
    }

    const q1 = await measure(1);
    const q15 = await measure(15);
    const q100 = await measure(100);
    assert.equal(q1, q15);
    assert.equal(q15, q100);
    assert.equal(q1, 3);
  });

  it('36–37. enrich plan y jugador', async () => {
    const { supabaseAdmin } = createSupabaseMock(seedData());
    const svc = createMembresiasSedeService({ supabaseAdmin });
    const result = await svc.listMembresiasAdmin(
      { rol: 'super_admin', sede_id: null },
      { sedeId: 10, page: 1, limit: 5 },
    );
    assert.ok(result.membresias[0].plan?.nombre);
    assert.ok(result.membresias[0].jugador?.user_id);
    assert.ok(result.membresias[0].jugador?.nombre || result.membresias[0].jugador?.email);
  });

  it('38–39. no documentos ni tokens', () => {
    const item = mapMembresiaPublica(
      {
        id: 1,
        user_id: 'u',
        sede_id: 1,
        plan_id: 1,
        estado: 'activa',
        origen: 'manual',
        inicio: null,
        vencimiento: null,
        renovacion_automatica: false,
      },
      { id: 1, sede_id: 1, nombre: 'P', precio: 1, moneda: 'ARS', duracion_tipo: 'mensual', beneficios: {} },
      mapJugadorResumenMembresia({ user_id: 'u', nombre: 'A', email: 'a@b.com' }),
    );
    assert.equal(assertMembresiaListItemSafe(item), true);
  });

  it('40–41. contrato membresias + pagination aditiva', async () => {
    const { supabaseAdmin } = createSupabaseMock(seedData());
    const svc = createMembresiasSedeService({ supabaseAdmin });
    const result = await svc.listMembresiasAdmin(
      { rol: 'super_admin', sede_id: null },
      { sedeId: 10 },
    );
    assert.ok(Array.isArray(result.membresias));
    assert.ok(result.pagination);
    assert.equal(typeof result.pagination.total, 'number');
  });

  it('42. fuente vacía no rompe', async () => {
    const { supabaseAdmin } = createSupabaseMock({
      membresias_sede: [],
      membresia_planes: [],
      jugadores_perfil: [],
    });
    const svc = createMembresiasSedeService({ supabaseAdmin });
    const result = await svc.listMembresiasAdmin(
      { rol: 'admin_club', sede_id: 10 },
      { sedeId: 10 },
    );
    assert.deepEqual(result.membresias, []);
    assert.equal(result.pagination.total, 0);
  });

  it('43–44. errores de count/consulta controlados', async () => {
    const broken = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          in() { return this; },
          order() { return this; },
          range() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: null, error: null });
          },
          then(resolve) {
            return Promise.resolve({
              data: null,
              error: { message: 'db down', code: 'PGRST000' },
              count: null,
            }).then(resolve);
          },
        };
      },
    };
    const svc = createMembresiasSedeService({ supabaseAdmin: broken });
    await assert.rejects(
      () => svc.listMembresiasAdmin(
        { rol: 'super_admin', sede_id: null },
        { sedeId: 10, page: 1, limit: 15 },
      ),
      (e) => Boolean(e && (e.status === 503 || e.message || e.code)),
    );
  });

  it('plan_id de otra sede → 400', async () => {
    const { supabaseAdmin } = createSupabaseMock(seedData());
    const svc = createMembresiasSedeService({ supabaseAdmin });
    await assert.rejects(
      () => svc.listMembresiasAdmin(
        { rol: 'admin_club', sede_id: 10 },
        { sedeId: 10, plan_id: 3 },
      ),
      (e) => e.status === 400,
    );
  });
});

describe('compatibilidad dominio y anti-empate', () => {
  it('45–47. estados reales y vencimiento lazy intactos', () => {
    assert.ok(MEMBRESIA_ESTADOS.includes('activa'));
    assert.ok(MEMBRESIA_ESTADOS.includes('vencida'));
    assert.equal(
      shouldMarkExpired({
        estado: 'activa',
        vencimiento: new Date(Date.now() - 1000).toISOString(),
      }),
      true,
    );
  });

  it('48. no introduce empate', () => {
    const item = mapMembresiaPublica({
      id: 1,
      user_id: 'u',
      sede_id: 1,
      plan_id: 1,
      estado: 'activa',
      origen: 'manual',
      inicio: null,
      vencimiento: null,
      renovacion_automatica: false,
    });
    assert.ok(!JSON.stringify(item).toLowerCase().includes('empate'));
  });

  it('ilike escape y filtro de búsqueda', () => {
    assert.ok(escapeMembresiaIlike('a%b').includes('\\%'));
    assert.ok(buildMembresiaJugadorSearchOrFilter('ana').includes('nombre.ilike'));
  });

  it('pagination meta', () => {
    const p = buildMembresiasPagination({ page: 2, limit: 15, total: 40 });
    assert.equal(p.total_pages, 3);
    assert.equal(p.has_next, true);
    assert.equal(p.has_previous, true);
  });
});
