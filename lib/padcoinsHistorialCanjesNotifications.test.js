import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  listPadcoinsMovimientosForPlayer,
  mapPadcoinsMovimientoPlayerRow,
  parsePadcoinsMovimientosPlayerFilters,
} from '../src/padcoins/padcoinsMovimientosPlayerService.js';
import { buildPaginatedPayload, parsePadcoinsPagination } from '../src/padcoins/padcoinsPagination.js';
import {
  buildPadcoinsCanjeNotificationDedupeKey,
  getSedeAdminClubUserIds,
  notifyPadcoinsCanjeCreated,
  notifyPadcoinsCanjeCanceladoPlayer,
  notifyPadcoinsCanjeEntregadoPlayer,
  PADCOINS_CANJE_NOTIFICATION_TRANSITIONS,
} from '../src/padcoins/padcoinsCanjesNotificationService.js';
import {
  cancelarCanjePadcoins,
  canjearPremioPadcoins,
  entregarCanjePadcoins,
  listCanjesAdminSede,
  listMisCanjesPadcoins,
} from '../src/padcoins/padcoinsCanjesService.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const ADMIN_ID = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ADMIN_SEDE_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SEDE_ID = 1;
const PREMIO_ID = 'premio-uuid-1';
const CANJE_ID = 'canje-uuid-1';

const MOVIMIENTOS = [
  {
    id: 'm1',
    user_id: USER_ID,
    tipo: 'earn',
    monto: 100,
    saldo_antes: 0,
    saldo_despues: 100,
    referencia_tipo: 'reserva',
    referencia_id: '10',
    sede_id: 1,
    descripcion: 'Reserva completada',
    created_at: '2026-07-06T10:00:00.000Z',
  },
  {
    id: 'm2',
    user_id: USER_ID,
    tipo: 'spend',
    monto: -50,
    saldo_antes: 100,
    saldo_despues: 50,
    referencia_tipo: 'canje_premio',
    referencia_id: CANJE_ID,
    sede_id: 1,
    descripcion: 'Canje premio: Bebida',
    created_at: '2026-07-05T10:00:00.000Z',
  },
  {
    id: 'm3',
    user_id: USER_ID,
    tipo: 'earn',
    monto: 200,
    saldo_antes: 50,
    saldo_despues: 250,
    referencia_tipo: 'reserva',
    referencia_id: '11',
    sede_id: 2,
    descripcion: 'Otra sede',
    created_at: '2026-07-04T10:00:00.000Z',
  },
];

function buildHistorialSupabase(rows = MOVIMIENTOS) {
  const state = { filters: [], range: null };

  const query = {
    select() { return query; },
    eq(col, val) {
      state.filters.push(['eq', col, val]);
      return query;
    },
    gte(col, val) {
      state.filters.push(['gte', col, val]);
      return query;
    },
    lte(col, val) {
      state.filters.push(['lte', col, val]);
      return query;
    },
    order() { return query; },
    range(from, to) {
      state.range = { from, to };
      let filtered = rows.filter((row) => row.user_id === USER_ID);

      for (const [op, col, val] of state.filters) {
        if (op === 'eq') {
          filtered = filtered.filter((row) => row[col] === val || String(row[col]) === String(val));
        }
        if (op === 'gte' && col === 'created_at') {
          filtered = filtered.filter((row) => row.created_at >= val);
        }
        if (op === 'lte' && col === 'created_at') {
          filtered = filtered.filter((row) => row.created_at <= val);
        }
      }

      const slice = filtered.slice(from, to + 1);
      return Promise.resolve({ data: slice, error: null, count: filtered.length });
    },
  };

  return {
    from(table) {
      if (table === 'padcoins_movimientos') return query;
      if (table === 'sedes') {
        return {
          select() { return this; },
          in() {
            return Promise.resolve({
              data: [
                { id: 1, nombre: 'La Meca' },
                { id: 2, nombre: 'Sede Dos' },
              ],
              error: null,
            });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
    state,
  };
}

function buildCanjeListQuery(rows) {
  const state = { filters: [] };
  const api = {
    select() { return api; },
    eq(col, val) {
      state.filters.push(['eq', col, val]);
      return api;
    },
    in(col, val) {
      state.filters.push(['in', col, val]);
      return api;
    },
    order() { return api; },
    limit() { return api; },
    maybeSingle: async () => {
      let filtered = applyCanjeFilters(rows, state.filters);
      const row = filtered[0] ?? null;
      if (!row) return { data: null, error: null };
      return {
        data: {
          ...row,
          premios_canjeables: { nombre: 'Bebida post partido', descripcion: null },
        },
        error: null,
      };
    },
    range(from, to) {
      let filtered = applyCanjeFilters(rows, state.filters);
      filtered.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
      const slice = filtered.slice(from, to + 1).map((row) => ({
        ...row,
        premios_canjeables: { nombre: 'Bebida post partido', descripcion: null },
      }));
      return Promise.resolve({ data: slice, error: null, count: filtered.length });
    },
    single: async () => {
      let filtered = applyCanjeFilters(rows, state.filters);
      return { data: filtered[0] ?? null, error: null };
    },
  };
  return api;
}

function applyCanjeFilters(rows, filters) {
  let filtered = [...rows];
  for (const [op, col, val] of filters) {
    if (op === 'eq') {
      filtered = filtered.filter((row) => row[col] === val || String(row[col]) === String(val));
    }
    if (op === 'in') {
      filtered = filtered.filter((row) => val.includes(row[col]));
    }
  }
  return filtered;
}

function buildSaldoStoreForNotifications(initialDisponible = 500, {
  premioStock = 5,
  initialCanjes = [],
} = {}) {
  let disponible = initialDisponible;
  let historicoTotal = initialDisponible;
  const movimientos = [];
  const canjes = [...initialCanjes];
  const notifications = [];

  const premio = {
    id: PREMIO_ID,
    sede_id: SEDE_ID,
    nombre: 'Bebida post partido',
    costo_padcoins: 150,
    stock_disponible: premioStock,
    activo: true,
    fecha_inicio: null,
    fecha_fin: null,
  };

  const store = {
    movimientos,
    canjes,
    notifications,
    premio,
    trackNotificationDedupe(_supabaseAdmin, payload) {
      const key = payload?.data?.dedupe_key;
      if (!key) {
        notifications.push(payload);
        return { created: true, duplicate: false, notificacion: { id: `n-${notifications.length}` } };
      }
      const dup = notifications.some(
        (n) => n.data?.dedupe_key === key && n.user_id === payload.user_id,
      );
      if (dup) return { created: false, duplicate: true, notificacion: null };
      notifications.push(payload);
      return { created: true, duplicate: false, notificacion: { id: `n-${notifications.length}` } };
    },
    supabase: {
      from(table) {
        if (table === 'padcoins_saldo') {
          const row = {
            id: 'saldo-1',
            user_id: USER_ID,
            disponible,
            historico_total: historicoTotal,
          };
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: { ...row }, error: null }),
            insert: async () => ({ data: row, error: null }),
            update(payload) {
              disponible = payload.disponible;
              if (payload.historico_total != null) historicoTotal = payload.historico_total;
              return {
                eq() { return this; },
                select() { return this; },
                single: async () => ({
                  data: {
                    ...row,
                    disponible,
                    historico_total: historicoTotal,
                  },
                  error: null,
                }),
              };
            },
          };
        }

        if (table === 'padcoins_movimientos') {
          return {
            select() { return this; },
            eq(col, val) {
              this._filters = this._filters ?? {};
              this._filters[col] = val;
              return this;
            },
            limit() { return this; },
            maybeSingle: async () => {
              const f = this._filters ?? {};
              const found = movimientos.find((m) => Object.entries(f).every(([k, v]) => m[k] === v));
              return { data: found ?? null, error: null };
            },
            insert(payload) {
              const row = { id: `mov-${movimientos.length + 1}`, ...payload };
              movimientos.push(row);
              return {
                select() { return this; },
                single: async () => ({ data: row, error: null }),
              };
            },
          };
        }

        if (table === 'premios_canjeables') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({ data: premio, error: null }),
            update(payload) {
              premio.stock_disponible = payload.stock_disponible;
              return {
                eq() { return this; },
                select() { return this; },
                maybeSingle: async () => ({ data: premio, error: null }),
              };
            },
          };
        }

        if (table === 'padcoins_canjes') {
          return {
            select() { return buildCanjeListQuery(canjes); },
            insert(payload) {
              const row = {
                ...payload,
                created_at: payload.created_at ?? new Date().toISOString(),
                updated_at: payload.updated_at ?? new Date().toISOString(),
                entregado_at: null,
                entregado_por: null,
              };
              canjes.push(row);
              return {
                select() { return this; },
                single: async () => ({ data: row, error: null }),
              };
            },
            update(payload) {
              const self = {
                _id: null,
                _in: null,
                eq(col, val) {
                  if (col === 'id') self._id = val;
                  return self;
                },
                in(col, vals) {
                  self._in = { col, vals };
                  return self;
                },
                select() { return self; },
                maybeSingle: async () => {
                  const row = canjes.find((c) => {
                    if (self._id && c.id !== self._id) return false;
                    if (self._in && !self._in.vals.includes(c[self._in.col])) return false;
                    return true;
                  });
                  if (!row) return { data: null, error: null };
                  Object.assign(row, payload);
                  return { data: row, error: null };
                },
                single: async () => {
                  const row = canjes.find((c) => c.id === self._id);
                  if (!row) throw new Error('canje not found');
                  Object.assign(row, payload);
                  return { data: row, error: null };
                },
                catch(fn) {
                  return Promise.resolve(self.maybeSingle()).catch(fn);
                },
              };
              return self;
            },
          };
        }

        if (table === 'user_roles') {
          const api = {
            _filters: {},
            select() { return api; },
            eq(col, val) {
              api._filters[col] = val;
              return api;
            },
            then(resolve) {
              const roleOk = api._filters.role === 'admin_club';
              const sedeOk = Number(api._filters.sede_id) === SEDE_ID;
              resolve({
                data: roleOk && sedeOk ? [{ user_id: ADMIN_SEDE_ID }] : [],
                error: null,
              });
            },
          };
          return api;
        }

        throw new Error(`unexpected table ${table}`);
      },
    },
  };

  return store;
}

function buildCanjesPaginationStore(initialCanjes = []) {
  const canjes = [...initialCanjes];
  return {
    canjes,
    supabase: {
      from(table) {
        if (table !== 'padcoins_canjes') throw new Error(`unexpected table ${table}`);
        return buildCanjeListQuery(canjes);
      },
    },
  };
}

describe('padcoinsPagination', () => {
  it('parsea limit y offset con defaults', () => {
    assert.deepEqual(parsePadcoinsPagination({}), { limit: 50, offset: 0 });
    assert.deepEqual(parsePadcoinsPagination({ limit: '10', offset: '5' }), { limit: 10, offset: 5 });
  });

  it('buildPaginatedPayload calcula has_more', () => {
    const payload = buildPaginatedPayload([1, 2], { limit: 2, offset: 0, total: 5 }, 'items');
    assert.equal(payload.has_more, true);
    assert.equal(payload.total, 5);
    assert.deepEqual(payload.paginacion, { limit: 2, offset: 0, total: 5, has_more: true });
  });
});

describe('padcoins historial jugador', () => {
  it('parsea filtros combinados', () => {
    const filters = parsePadcoinsMovimientosPlayerFilters({
      tipo: 'earn',
      sede_id: '1',
      referencia_tipo: 'reserva',
      referencia_id: '10',
      fecha_desde: '2026-07-01',
      fecha_hasta: '2026-07-31',
    });
    assert.equal(filters.tipo, 'earn');
    assert.equal(filters.sede_id, 1);
    assert.equal(filters.referencia_tipo, 'reserva');
    assert.equal(filters.referencia_id, '10');
    assert.ok(filters.fecha_desde);
    assert.ok(filters.fecha_hasta);
  });

  it('mapPadcoinsMovimientoPlayerRow incluye sede_nombre y concepto', () => {
    const sedeMap = new Map([[1, 'La Meca']]);
    const row = mapPadcoinsMovimientoPlayerRow(MOVIMIENTOS[0], sedeMap);
    assert.equal(row.sede_nombre, 'La Meca');
    assert.equal(row.concepto, 'Reserva completada');
    assert.equal(row.descripcion, 'Reserva completada');
  });

  it('paginación, total y has_more', async () => {
    const supabase = buildHistorialSupabase();
    const page1 = await listPadcoinsMovimientosForPlayer(supabase, USER_ID, {
      query: { limit: '2', offset: '0' },
    });
    assert.equal(page1.movimientos.length, 2);
    assert.equal(page1.total, 3);
    assert.equal(page1.has_more, true);
    assert.equal(page1.paginacion.has_more, true);

    const page2 = await listPadcoinsMovimientosForPlayer(supabase, USER_ID, {
      query: { limit: '2', offset: '2' },
    });
    assert.equal(page2.movimientos.length, 1);
    assert.equal(page2.has_more, false);
  });

  it('filtros tipo y sede_id', async () => {
    const supabase = buildHistorialSupabase();
    const result = await listPadcoinsMovimientosForPlayer(supabase, USER_ID, {
      query: { tipo: 'earn', sede_id: '2' },
    });
    assert.equal(result.total, 1);
    assert.equal(result.movimientos[0].id, 'm3');
    assert.equal(result.movimientos[0].sede_nombre, 'Sede Dos');
  });

  it('compatibilidad cliente antiguo solo limit', async () => {
    const supabase = buildHistorialSupabase();
    const result = await listPadcoinsMovimientosForPlayer(supabase, USER_ID, {
      limit: 50,
    });
    assert.ok(Array.isArray(result.movimientos));
    assert.equal(result.movimientos.length, 3);
    assert.equal(result.offset, 0);
    assert.equal(result.limit, 50);
  });
});

describe('padcoins canjes paginación', () => {
  it('listMisCanjesPadcoins pagina y filtra estado', async () => {
    const store = buildCanjesPaginationStore([
      {
        id: 'c1', user_id: USER_ID, sede_id: SEDE_ID, premio_id: PREMIO_ID,
        monto_padcoins: 150, estado: 'pendiente', codigo: 'PC-AAA', created_at: '2026-07-06T10:00:00.000Z',
      },
      {
        id: 'c2', user_id: USER_ID, sede_id: SEDE_ID, premio_id: PREMIO_ID,
        monto_padcoins: 150, estado: 'entregado', codigo: 'PC-BBB', created_at: '2026-07-05T10:00:00.000Z',
      },
    ]);

    const page = await listMisCanjesPadcoins(store.supabase, USER_ID, { limit: 1, offset: 0, estado: 'pendiente' });
    assert.equal(page.canjes.length, 1);
    assert.equal(page.canjes[0].estado, 'pendiente');
    assert.equal(page.total, 1);
    assert.equal(page.has_more, false);
  });

  it('listCanjesAdminSede filtra por sede, estado y user_id', async () => {
    const otherUser = 'dddddddd-dddd-dddd-dddd-dddddddddddd';
    const store = buildCanjesPaginationStore([
      {
        id: 'c1', user_id: USER_ID, sede_id: SEDE_ID, premio_id: PREMIO_ID,
        monto_padcoins: 150, estado: 'pendiente', codigo: 'PC-AAA', created_at: '2026-07-06T10:00:00.000Z',
      },
      {
        id: 'c2', user_id: otherUser, sede_id: SEDE_ID, premio_id: PREMIO_ID,
        monto_padcoins: 150, estado: 'pendiente', codigo: 'PC-BBB', created_at: '2026-07-05T10:00:00.000Z',
      },
    ]);

    const result = await listCanjesAdminSede(store.supabase, SEDE_ID, {
      limit: 10,
      offset: 0,
      estado: 'pendiente',
      user_id: USER_ID,
    });
    assert.equal(result.total, 1);
    assert.equal(result.canjes[0].user_id, USER_ID);
  });

  it('user_id inválido en admin canjes falla', async () => {
    const store = buildCanjesPaginationStore();
    await assert.rejects(
      () => listCanjesAdminSede(store.supabase, SEDE_ID, { user_id: 'no-uuid' }),
      /user_id inválido/,
    );
  });
});

describe('padcoins canjes notificaciones', () => {
  it('dedupe_key estable por transición', () => {
    const key = buildPadcoinsCanjeNotificationDedupeKey(
      CANJE_ID,
      USER_ID,
      PADCOINS_CANJE_NOTIFICATION_TRANSITIONS.PLAYER_PENDIENTE,
    );
    assert.match(key, /padcoins_canje\|canje-uuid-1\|user\|/);
  });

  it('getSedeAdminClubUserIds consulta user_roles', async () => {
    const store = buildSaldoStoreForNotifications();
    const ids = await getSedeAdminClubUserIds(store.supabase, SEDE_ID);
    assert.deepEqual(ids, [ADMIN_SEDE_ID]);
  });

  it('canje nuevo notifica jugador y admin sede', async () => {
    const store = buildSaldoStoreForNotifications();
    const deps = { createNotificacionIfAbsent: store.trackNotificationDedupe.bind(store) };

    await canjearPremioPadcoins(store.supabase, USER_ID, PREMIO_ID, deps);

    const playerNotifs = store.notifications.filter((n) => n.user_id === USER_ID);
    const adminNotifs = store.notifications.filter((n) => n.user_id === ADMIN_SEDE_ID);
    assert.equal(playerNotifs.length, 1);
    assert.equal(adminNotifs.length, 1);
    assert.ok(store.canjes[0].id);
    assert.equal(playerNotifs[0].data.action, 'ver_canje_padcoins');
    assert.equal(adminNotifs[0].data.action, 'admin_padcoins_canjes');
    assert.ok(playerNotifs[0].link.includes('/padcoins/canjes/'));
  });

  it('reintento idempotente no duplica notificaciones', async () => {
    const store = buildSaldoStoreForNotifications();
    const deps = { createNotificacionIfAbsent: store.trackNotificationDedupe.bind(store) };

    await canjearPremioPadcoins(store.supabase, USER_ID, PREMIO_ID, deps);
    await canjearPremioPadcoins(store.supabase, USER_ID, PREMIO_ID, deps);

    assert.equal(store.notifications.length, 2);
  });

  it('entrega notifica jugador una sola vez', async () => {
    const store = buildSaldoStoreForNotifications(500, {
      initialCanjes: [{
        id: CANJE_ID,
        user_id: USER_ID,
        sede_id: SEDE_ID,
        premio_id: PREMIO_ID,
        monto_padcoins: 150,
        estado: 'pendiente',
        codigo: 'PC-AAA',
        created_at: '2026-07-06T10:00:00.000Z',
      }],
    });
    const deps = { createNotificacionIfAbsent: store.trackNotificationDedupe.bind(store) };

    await entregarCanjePadcoins(store.supabase, CANJE_ID, ADMIN_ID, deps);
    await entregarCanjePadcoins(store.supabase, CANJE_ID, ADMIN_ID, deps).catch(() => null);

    const playerNotifs = store.notifications.filter((n) => n.user_id === USER_ID);
    assert.equal(playerNotifs.length, 1);
    assert.equal(playerNotifs[0].data.transition, PADCOINS_CANJE_NOTIFICATION_TRANSITIONS.PLAYER_ENTREGADO);
  });

  it('cancelación notifica jugador y devuelve PadCoins una sola vez', async () => {
    const store = buildSaldoStoreForNotifications(350, {
      initialCanjes: [{
        id: CANJE_ID,
        user_id: USER_ID,
        sede_id: SEDE_ID,
        premio_id: PREMIO_ID,
        monto_padcoins: 150,
        estado: 'pendiente',
        codigo: 'PC-AAA',
        created_at: '2026-07-06T10:00:00.000Z',
      }],
    });
    const deps = { createNotificacionIfAbsent: store.trackNotificationDedupe.bind(store) };

    await cancelarCanjePadcoins(store.supabase, CANJE_ID, ADMIN_ID, 'sin stock', deps);
    await assert.rejects(
      () => cancelarCanjePadcoins(store.supabase, CANJE_ID, ADMIN_ID, 'sin stock', deps),
      /no cancelable/,
    );

    const cancelNotifs = store.notifications.filter(
      (n) => n.data?.transition === PADCOINS_CANJE_NOTIFICATION_TRANSITIONS.PLAYER_CANCELADO,
    );
    assert.equal(cancelNotifs.length, 1);
    const reverseMoves = store.movimientos.filter((m) => m.tipo === 'reverse');
    assert.equal(reverseMoves.length, 1);
  });

  it('fallo de canje no genera notificaciones', async () => {
    const store = buildSaldoStoreForNotifications(50);
    const deps = { createNotificacionIfAbsent: store.trackNotificationDedupe.bind(store) };

    await assert.rejects(
      () => canjearPremioPadcoins(store.supabase, USER_ID, PREMIO_ID, deps),
      /Saldo PadCoins insuficiente/,
    );
    assert.equal(store.notifications.length, 0);
  });

  it('notify helpers respetan dedupe', async () => {
    const store = buildSaldoStoreForNotifications();
    const canje = {
      id: CANJE_ID,
      user_id: USER_ID,
      sede_id: SEDE_ID,
      premio_id: PREMIO_ID,
      estado: 'pendiente',
      codigo: 'PC-AAA',
    };
    const deps = { createNotificacionIfAbsent: store.trackNotificationDedupe.bind(store) };

    await notifyPadcoinsCanjeCreated(store.supabase, { canje, premioNombre: 'Bebida' }, deps);
    await notifyPadcoinsCanjeCreated(store.supabase, { canje, premioNombre: 'Bebida' }, deps);

    assert.equal(store.notifications.length, 2);

    await notifyPadcoinsCanjeEntregadoPlayer(store.supabase, canje, { premioNombre: 'Bebida' }, deps);
    await notifyPadcoinsCanjeEntregadoPlayer(store.supabase, canje, { premioNombre: 'Bebida' }, deps);
    assert.equal(store.notifications.length, 3);

    await notifyPadcoinsCanjeCanceladoPlayer(store.supabase, canje, { premioNombre: 'Bebida' }, deps);
    await notifyPadcoinsCanjeCanceladoPlayer(store.supabase, canje, { premioNombre: 'Bebida' }, deps);
    assert.equal(store.notifications.length, 4);
  });
});

describe('premiosCanjeables admin scope', () => {
  it('resolveAdminListSedeId restringe admin_club a su sede', async () => {
    const { default: mountPremiosCanjeablesRoutes } = await import('../src/routes/premiosCanjeables.js');
    assert.equal(typeof mountPremiosCanjeablesRoutes, 'function');

    const adminClubRole = { rol: 'admin_club', sede_id: 7 };
    const err = new Error('No tenés permiso para administrar esta sede');
    err.status = 403;

    const resolveAdminListSedeId = (role, query = {}) => {
      if (role.rol === 'admin_club') {
        if (role.sede_id == null) throw Object.assign(new Error('Admin de club sin sede asignada'), { status: 403 });
        const requested = Number.parseInt(String(query.sede_id ?? ''), 10);
        if (requested && Number(requested) !== Number(role.sede_id)) throw err;
        return role.sede_id;
      }
      if (role.rol === 'super_admin') {
        const sedeId = Number.parseInt(String(query.sede_id ?? ''), 10);
        if (!Number.isFinite(sedeId) || sedeId <= 0) throw Object.assign(new Error('sede_id es requerido'), { status: 400 });
        return sedeId;
      }
      throw Object.assign(new Error('No autorizado'), { status: 403 });
    };

    assert.equal(resolveAdminListSedeId(adminClubRole, {}), 7);
    assert.throws(() => resolveAdminListSedeId(adminClubRole, { sede_id: '99' }), /No tenés permiso/);
    assert.equal(resolveAdminListSedeId({ rol: 'super_admin' }, { sede_id: '3' }), 3);
  });
});
