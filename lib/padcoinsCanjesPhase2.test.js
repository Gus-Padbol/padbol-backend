import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildCanjeQrPayload,
  encodeCanjeQrData,
} from '../src/padcoins/padcoinsCanjeQrService.js';
import {
  computePeriodStartIso,
} from '../src/padcoins/padcoinsCanjeLimitsService.js';
import {
  resolveCanjeExpiresAt,
} from '../src/padcoins/padcoinsCanjeExpiryService.js';
import {
  PADCOINS_CANJE_NOTIFICATION_TRANSITIONS,
  notifyPadcoinsCanjeAprobadoPlayer,
  notifyPadcoinsCanjeVencidoPlayer,
} from '../src/padcoins/padcoinsCanjesNotificationService.js';
import {
  aprobarCanjePadcoins,
  cancelarCanjePadcoins,
  canjearPremioPadcoins,
  entregarCanjePadcoins,
  getCanjePadcoinsForPlayer,
  validarCanjePadcoinsAdmin,
} from '../src/padcoins/padcoinsCanjesService.js';
import {
  mapPremioCanjeablePublico,
  resolvePremioImagenUrl,
} from '../src/padcoins/premiosCanjeablesService.js';
import { PADCOINS_PREMIO_IMAGEN_FALLBACK } from '../src/padcoins/padcoinsCanjesConfig.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const OTHER_USER = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
const ADMIN_ID = 'cccccccc-cccc-cccc-cccc-cccccccccccc';
const SEDE_ID = 1;
const SEDE_OTHER = 2;
const PREMIO_ID = 'premio-uuid-1';

function buildPhase2Store({
  disponible = 1000,
  premioOverrides = {},
  initialCanjes = [],
} = {}) {
  let saldoDisponible = disponible;
  let historicoTotal = disponible;
  const movimientos = [];
  const canjes = [...initialCanjes];
  const notifications = [];

  const premio = {
    id: PREMIO_ID,
    sede_id: SEDE_ID,
    nombre: 'Bebida post partido',
    descripcion: 'Gaseosa 500ml',
    imagen_url: null,
    costo_padcoins: 150,
    stock_disponible: 10,
    stock_total: 10,
    activo: true,
    fecha_inicio: null,
    fecha_fin: null,
    limite_usuario_cantidad: null,
    limite_usuario_periodo: null,
    limite_global_cantidad: null,
    limite_global_periodo: null,
    canje_validez_dias: 7,
    ...premioOverrides,
  };

  const deps = {
    skipNotifications: false,
    createNotificacionIfAbsent(_supabase, payload) {
      const key = payload?.data?.dedupe_key;
      if (key) {
        const dup = notifications.some(
          (n) => n.data?.dedupe_key === key && n.user_id === payload.user_id,
        );
        if (dup) return { created: false, duplicate: true, notificacion: null };
      }
      notifications.push(payload);
      return { created: true, duplicate: false, notificacion: { id: `n-${notifications.length}` } };
    },
  };

  const supabase = {
    premio,
    canjes,
    movimientos,
    notifications,
    saldoDisponible: () => saldoDisponible,
    from(table) {
      if (table === 'padcoins_saldo') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({
            data: {
              id: 'saldo-1',
              user_id: USER_ID,
              disponible: saldoDisponible,
              historico_total: historicoTotal,
            },
            error: null,
          }),
          insert: async () => ({ data: {}, error: null }),
          update(payload) {
            saldoDisponible = payload.disponible;
            if (payload.historico_total != null) historicoTotal = payload.historico_total;
            return {
              eq() { return this; },
              select() { return this; },
              single: async () => ({
                data: {
                  id: 'saldo-1',
                  user_id: USER_ID,
                  disponible: saldoDisponible,
                  historico_total: historicoTotal,
                },
                error: null,
              }),
            };
          },
        };
      }

      if (table === 'padcoins_movimientos') {
        const state = { filters: [] };
        return {
          select() { return this; },
          eq(col, val) {
            state.filters.push([col, val]);
            return this;
          },
          limit() { return this; },
          maybeSingle: async () => {
            const found = movimientos.find(
              (m) => state.filters.every(([k, v]) => m[k] === v || String(m[k]) === String(v)),
            );
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
        let premioQueryId = null;
        let stockMatch = null;
        return {
          select() { return this; },
          eq(_col, val) {
            if (_col === 'id') premioQueryId = val;
            if (_col === 'stock_disponible') stockMatch = val;
            return this;
          },
          maybeSingle: async () => ({
            data: premioQueryId === premio.id ? { ...premio } : null,
            error: null,
          }),
          update(payload) {
            const updatePayload = payload;
            return {
              eq(_col, val) {
                if (_col === 'id') premioQueryId = val;
                if (_col === 'stock_disponible') stockMatch = val;
                return this;
              },
              select() { return this; },
              maybeSingle: async () => {
                if (premioQueryId !== premio.id) return { data: null, error: null };
                if (stockMatch != null && premio.stock_disponible !== stockMatch) {
                  return { data: null, error: null };
                }
                Object.assign(premio, updatePayload);
                return { data: { id: premio.id, stock_disponible: premio.stock_disponible }, error: null };
              },
            };
          },
        };
      }

      if (table === 'padcoins_canjes') {
        const state = { filters: [], pendingUpdate: null, pendingInsert: null };

        const applyFilters = (rows) => {
          let filtered = [...rows];
          for (const [op, col, val] of state.filters) {
            if (op === 'eq') filtered = filtered.filter((r) => r[col] === val || String(r[col]) === String(val));
            if (op === 'in') filtered = filtered.filter((r) => val.includes(r[col]));
            if (op === 'neq') filtered = filtered.filter((r) => r[col] !== val);
            if (op === 'lte' && col === 'expires_at') {
              filtered = filtered.filter((r) => r.expires_at && r.expires_at <= val);
            }
            if (op === 'gte' && col === 'created_at') {
              filtered = filtered.filter((r) => r.created_at >= val);
            }
          }
          return filtered;
        };

        const handlePendingInsert = () => {
          const row = {
            ...state.pendingInsert,
            updated_at: state.pendingInsert.updated_at ?? state.pendingInsert.created_at,
          };
          canjes.push(row);
          state.pendingInsert = null;
          return row;
        };

        const api = {
          select(_cols, opts = {}) {
            state.headOnly = opts.head === true;
            state.countExact = opts.count === 'exact';
            return api;
          },
          eq(col, val) { state.filters.push(['eq', col, val]); return api; },
          in(col, val) { state.filters.push(['in', col, val]); return api; },
          neq(col, val) { state.filters.push(['neq', col, val]); return api; },
          lte(col, val) { state.filters.push(['lte', col, val]); return api; },
          gte(col, val) { state.filters.push(['gte', col, val]); return api; },
          order() { return api; },
          limit(n) { state.limit = n; return api; },
          insert(payload) {
            state.pendingInsert = payload;
            return api;
          },
          update(payload) {
            state.pendingUpdate = payload;
            return api;
          },
          maybeSingle: async () => {
            if (state.pendingUpdate) {
              let filtered = applyFilters(canjes);
              const row = filtered[0];
              if (!row) return { data: null, error: null };
              for (const [op, col, val] of state.filters) {
                if (op === 'in' && col === 'estado' && !val.includes(row.estado)) {
                  return { data: null, error: null };
                }
                if (op === 'eq' && col === 'estado' && row.estado !== val) {
                  return { data: null, error: null };
                }
              }
              Object.assign(row, state.pendingUpdate);
              row.premios_canjeables = { nombre: premio.nombre, descripcion: premio.descripcion, imagen_url: premio.imagen_url };
              return { data: { ...row }, error: null };
            }

            let filtered = applyFilters(canjes);
            filtered.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
            const row = filtered[0] ?? null;
            if (!row) return { data: null, error: null };
            return {
              data: {
                ...row,
                premios_canjeables: { nombre: premio.nombre, descripcion: premio.descripcion, imagen_url: premio.imagen_url },
              },
              error: null,
            };
          },
          single: async () => {
            if (state.pendingInsert) {
              const row = handlePendingInsert();
              return { data: row, error: null };
            }
            const result = await api.maybeSingle();
            if (!result.data) throw new Error('single expected row');
            return result;
          },
          range(from, to) {
            let filtered = applyFilters(canjes);
            filtered.sort((a, b) => String(b.created_at).localeCompare(String(a.created_at)));
            if (state.limit) filtered = filtered.slice(0, state.limit);
            const slice = filtered.slice(from, to + 1).map((row) => ({
              ...row,
              premios_canjeables: { nombre: premio.nombre, descripcion: premio.descripcion, imagen_url: premio.imagen_url },
            }));
            return Promise.resolve({
              data: slice,
              error: null,
              count: state.headOnly ? filtered.length : filtered.length,
            });
          },
          then(resolve, reject) {
            if (state.pendingInsert) {
              const row = handlePendingInsert();
              return Promise.resolve({ data: row, error: null }).then(resolve, reject);
            }

            if (state.pendingUpdate) {
              return api.maybeSingle().then(resolve, reject);
            }

            let filtered = applyFilters(canjes);
            if (state.limit) filtered = filtered.slice(0, state.limit);
            if (state.headOnly || state.countExact) {
              return Promise.resolve({ count: filtered.length, error: null, data: null }).then(resolve, reject);
            }
            return Promise.resolve({ data: filtered, error: null }).then(resolve, reject);
          },
        };

        return api;
      }

      if (table === 'user_roles') {
        return {
          select() { return this; },
          eq() { return this; },
          async then(resolve) {
            resolve({ data: [{ user_id: ADMIN_ID }], error: null });
          },
        };
      }

      throw new Error(`unexpected table ${table}`);
    },
  };

  return { supabase, deps, premio, canjes, movimientos, notifications };
}

describe('padcoinsCanjesPhase2 — beneficio imagen', () => {
  it('usa fallback visual sin imagen_url', () => {
    assert.equal(resolvePremioImagenUrl({ imagen_url: null }), PADCOINS_PREMIO_IMAGEN_FALLBACK);
    const mapped = mapPremioCanjeablePublico({ id: PREMIO_ID, sede_id: 1, nombre: 'X', costo_padcoins: 10, imagen_url: null });
    assert.equal(mapped.imagen_url, PADCOINS_PREMIO_IMAGEN_FALLBACK);
  });

  it('expone imagen_url cuando existe', () => {
    const url = 'https://cdn.example/beneficio.png';
    const mapped = mapPremioCanjeablePublico({
      id: PREMIO_ID,
      sede_id: 1,
      nombre: 'X',
      costo_padcoins: 10,
      imagen_url: url,
    });
    assert.equal(mapped.imagen_url, url);
  });
});

describe('padcoinsCanjesPhase2 — QR payload', () => {
  it('incluye canje, usuario, sede, beneficio y código sin datos sensibles extra', () => {
    const payload = buildCanjeQrPayload({
      canje: {
        id: 'canje-1',
        codigo: 'PC-ABCDEF012345',
        sede_id: SEDE_ID,
        premio_id: PREMIO_ID,
        user_id: USER_ID,
      },
      premioNombre: 'Bebida',
    });

    assert.equal(payload.type, 'padcoins_canje');
    assert.equal(payload.codigo, 'PC-ABCDEF012345');
    assert.equal(payload.sede_id, SEDE_ID);
    assert.equal(payload.premio_id, PREMIO_ID);
    assert.equal(payload.user_id, USER_ID);
    assert.equal(payload.premio_nombre, 'Bebida');
    assert.ok(encodeCanjeQrData(payload));
    assert.equal(JSON.parse(Buffer.from(encodeCanjeQrData(payload), 'base64url').toString()).canje_id, 'canje-1');
  });
});

describe('padcoinsCanjesPhase2 — flujo canje', () => {
  it('canje pendiente con expires_at y QR', async () => {
    const { supabase, deps } = buildPhase2Store();
    const result = await canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps);

    assert.equal(result.canje.estado, 'pendiente');
    assert.ok(result.canje.expires_at);
    assert.ok(result.qr_payload);
    assert.equal(result.codigo.startsWith('PC-'), true);
  });

  it('aprobación pendiente → aprobado', async () => {
    const { supabase, deps, canjes } = buildPhase2Store();
    const created = await canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps);
    const approved = await aprobarCanjePadcoins(supabase, created.canje.id, ADMIN_ID, deps);

    assert.equal(approved.estado, 'aprobado');
    assert.ok(approved.aprobado_at);
    assert.equal(canjes[0].estado, 'aprobado');
  });

  it('entrega desde aprobado', async () => {
    const { supabase, deps } = buildPhase2Store();
    const created = await canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps);
    await aprobarCanjePadcoins(supabase, created.canje.id, ADMIN_ID, deps);
    const delivered = await entregarCanjePadcoins(supabase, created.canje.id, ADMIN_ID, deps);

    assert.equal(delivered.estado, 'entregado');
    assert.ok(delivered.entregado_at);
  });

  it('compat V1: entrega directa desde pendiente', async () => {
    const { supabase, deps } = buildPhase2Store();
    const created = await canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps);
    const delivered = await entregarCanjePadcoins(supabase, created.canje.id, ADMIN_ID, deps);
    assert.equal(delivered.estado, 'entregado');
  });

  it('cancelación devuelve saldo una sola vez', async () => {
    const { supabase, deps, movimientos } = buildPhase2Store({ disponible: 500 });
    const before = supabase.saldoDisponible();
    const created = await canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps);
    assert.ok(supabase.saldoDisponible() < before);

    await cancelarCanjePadcoins(supabase, created.canje.id, ADMIN_ID, 'test', deps);
    assert.equal(supabase.saldoDisponible(), before);

    const refunds = movimientos.filter((m) => m.tipo === 'reverse' && m.monto > 0);
    assert.equal(refunds.length, 1);
  });

  it('transición inválida entregado → cancelado rechazada', async () => {
    const { supabase, deps } = buildPhase2Store();
    const created = await canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps);
    await entregarCanjePadcoins(supabase, created.canje.id, ADMIN_ID, deps);

    await assert.rejects(
      () => cancelarCanjePadcoins(supabase, created.canje.id, ADMIN_ID, null, deps),
      /no cancelable/,
    );
  });

  it('aprobar canje entregado rechazado', async () => {
    const { supabase, deps } = buildPhase2Store();
    const created = await canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps);
    await entregarCanjePadcoins(supabase, created.canje.id, ADMIN_ID, deps);

    await assert.rejects(
      () => aprobarCanjePadcoins(supabase, created.canje.id, ADMIN_ID, deps),
      /no aprobable/,
    );
  });
});

describe('padcoinsCanjesPhase2 — vencimiento', () => {
  it('canje vencido no entregable y devuelve PadCoins', async () => {
    const expiredAt = new Date(Date.now() - 60_000).toISOString();
    const { supabase, deps, movimientos } = buildPhase2Store({ disponible: 500 });
    const created = await canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps);
    const before = supabase.saldoDisponible();

    const row = supabase.canjes.find((c) => c.id === created.canje.id);
    row.expires_at = expiredAt;

    await assert.rejects(
      () => entregarCanjePadcoins(supabase, created.canje.id, ADMIN_ID, deps),
      /no entregable/,
    );

    assert.equal(row.estado, 'vencido');
    assert.ok(supabase.saldoDisponible() > before);
    assert.equal(movimientos.filter((m) => m.tipo === 'reverse').length, 1);
  });
});

describe('padcoinsCanjesPhase2 — límites', () => {
  it('rechaza canje cuando supera límite diario por usuario', async () => {
    const periodStart = computePeriodStartIso('dia');
    const { supabase, deps } = buildPhase2Store({
      premioOverrides: {
        limite_usuario_cantidad: 1,
        limite_usuario_periodo: 'dia',
      },
      initialCanjes: [{
        id: 'old-1',
        user_id: USER_ID,
        sede_id: SEDE_ID,
        premio_id: PREMIO_ID,
        monto_padcoins: 150,
        estado: 'entregado',
        codigo: 'PC-OLD000000001',
        created_at: periodStart,
        expires_at: null,
      }],
    });

    await assert.rejects(
      () => canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps),
      /Límite de canje por jugador/,
    );
  });

  it('rechaza canje cuando supera límite global', async () => {
    const { supabase, deps } = buildPhase2Store({
      premioOverrides: {
        limite_global_cantidad: 1,
        limite_global_periodo: 'total',
      },
      initialCanjes: [{
        id: 'old-global',
        user_id: OTHER_USER,
        sede_id: SEDE_ID,
        premio_id: PREMIO_ID,
        monto_padcoins: 150,
        estado: 'entregado',
        codigo: 'PC-OLD000000002',
        created_at: '2026-01-01T00:00:00.000Z',
        expires_at: null,
      }],
    });

    await assert.rejects(
      () => canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps),
      /Límite global/,
    );
  });

  it('stock agotado rechazado antes de descontar', async () => {
    const { supabase, deps } = buildPhase2Store({
      premioOverrides: { stock_disponible: 0, stock_total: 0 },
    });

    await assert.rejects(
      () => canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps),
      /Stock del premio agotado|Premio no disponible/,
    );
    assert.equal(supabase.saldoDisponible(), 1000);
  });
});

describe('padcoinsCanjesPhase2 — acceso y validación admin', () => {
  it('detalle solo para dueño autenticado', async () => {
    const { supabase, deps } = buildPhase2Store();
    const created = await canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps);

    const own = await getCanjePadcoinsForPlayer(supabase, created.canje.id, USER_ID, deps);
    assert.equal(own.id, created.canje.id);

    await assert.rejects(
      () => getCanjePadcoinsForPlayer(supabase, created.canje.id, OTHER_USER, deps),
      /No autorizado/,
    );
  });

  it('validar por código devuelve flags operativos', async () => {
    const { supabase, deps } = buildPhase2Store();
    const created = await canjearPremioPadcoins(supabase, USER_ID, PREMIO_ID, deps);
    const validation = await validarCanjePadcoinsAdmin(supabase, { codigo: created.codigo }, deps);

    assert.equal(validation.canje.codigo, created.codigo);
    assert.equal(validation.aprobable, true);
    assert.equal(validation.entregable, true);
    assert.ok(validation.canje.qr_payload);
  });
});

describe('padcoinsCanjesPhase2 — notificaciones', () => {
  it('aprobado y vencido dedupe por transición', async () => {
    const notifications = [];
    const deps = {
      createNotificacionIfAbsent(_s, payload) {
        const key = payload.data.dedupe_key;
        if (notifications.some((n) => n.data.dedupe_key === key && n.user_id === payload.user_id)) {
          return { created: false, duplicate: true };
        }
        notifications.push(payload);
        return { created: true, duplicate: false };
      },
    };

    const canje = {
      id: 'canje-n1',
      user_id: USER_ID,
      sede_id: SEDE_ID,
      premio_id: PREMIO_ID,
      codigo: 'PC-NOTIF000001',
      estado: 'aprobado',
    };

    await notifyPadcoinsCanjeAprobadoPlayer({}, canje, { premioNombre: 'Bebida' }, deps);
    await notifyPadcoinsCanjeAprobadoPlayer({}, canje, { premioNombre: 'Bebida' }, deps);
    await notifyPadcoinsCanjeVencidoPlayer({}, { ...canje, estado: 'vencido' }, { premioNombre: 'Bebida' }, deps);
    await notifyPadcoinsCanjeVencidoPlayer({}, { ...canje, estado: 'vencido' }, { premioNombre: 'Bebida' }, deps);

    assert.equal(notifications.length, 2);
    assert.ok(notifications.some((n) => n.data.transition === PADCOINS_CANJE_NOTIFICATION_TRANSITIONS.PLAYER_APROBADO));
    assert.ok(notifications.some((n) => n.data.transition === PADCOINS_CANJE_NOTIFICATION_TRANSITIONS.PLAYER_VENCIDO));
  });
});

describe('padcoinsCanjesPhase2 — utilidades', () => {
  it('resolveCanjeExpiresAt respeta validez del beneficio', () => {
    const createdAt = '2026-07-01T12:00:00.000Z';
    const expires = resolveCanjeExpiresAt({ createdAt, validezDias: 7 });
    assert.equal(expires, '2026-07-08T12:00:00.000Z');
  });
});
