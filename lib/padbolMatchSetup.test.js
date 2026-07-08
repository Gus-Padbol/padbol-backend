import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PADBOL_MATCH_SETUP_STEPS,
  PADBOL_MATCH_SUGGESTED_PREMIOS,
} from '../src/setup/padbolMatchSetupConfig.js';
import {
  canReadPadbolMatchSetup,
  canWritePadbolMatchSetup,
  getSetupStatus,
  initializePadCoinsSetupForSede,
  validateSetupForSede,
} from '../src/setup/padbolMatchSetupService.js';

const SEDE_ID = 1;
const OTHER_SEDE_ID = 2;
const ADMIN_USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

function buildSetupStore({
  sedeId = SEDE_ID,
  sedeNombre = 'Sede Test',
  padcoinsConfig = null,
  premios = [],
  canchas = [],
  admins = [],
  setupStatus = null,
} = {}) {
  const padcoinsRows = padcoinsConfig ? [padcoinsConfig] : [];
  const premioRows = [...premios];
  const canchaRows = [...canchas];
  const adminRows = [...admins];
  const setupRows = setupStatus ? [setupStatus] : [];

  const supabase = {
    from(table) {
      if (table === 'sedes') {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle: async () => ({
            data: { id: sedeId, nombre: sedeNombre },
            error: null,
          }),
        };
      }

      if (table === 'padcoins_sede_config') {
        const query = { sedeFilter: null };

        return {
          select() { return this; },
          eq(col, val) {
            if (col === 'sede_id') query.sedeFilter = Number(val);
            return this;
          },
          maybeSingle: async () => {
            const row = padcoinsRows.find((r) => Number(r.sede_id) === Number(query.sedeFilter ?? sedeId));
            return { data: row ?? null, error: null };
          },
          upsert(payload) {
            const idx = padcoinsRows.findIndex((r) => Number(r.sede_id) === Number(payload.sede_id));
            const row = {
              id: payload.id ?? `cfg-${payload.sede_id}`,
              created_at: new Date().toISOString(),
              fecha_inicio: null,
              fecha_fin: null,
              rule_overrides: {},
              ...payload,
            };
            if (idx >= 0) {
              padcoinsRows[idx] = { ...padcoinsRows[idx], ...row };
            } else {
              padcoinsRows.push(row);
            }
            return {
              select() { return this; },
              single: async () => ({ data: row, error: null }),
            };
          },
        };
      }

      if (table === 'padcoins_global_config') {
        return {
          select() { return this; },
          eq() { return this; },
          order: async () => ({ data: [], error: null }),
        };
      }

      if (table === 'premios_canjeables') {
        const query = { sedeFilter: null, activoFilter: null };

        return {
          select() { return this; },
          eq(col, val) {
            if (col === 'sede_id') query.sedeFilter = Number(val);
            if (col === 'activo') query.activoFilter = val;
            return this;
          },
          order() { return this; },
          insert(payload) {
            const row = {
              id: `premio-${premioRows.length + 1}`,
              created_at: new Date().toISOString(),
              updated_at: new Date().toISOString(),
              activo: true,
              ...payload,
            };
            premioRows.push(row);
            return {
              select() { return this; },
              single: async () => ({ data: row, error: null }),
            };
          },
          then(resolve) {
            let rows = [...premioRows];
            if (query.sedeFilter != null) {
              rows = rows.filter((r) => Number(r.sede_id) === query.sedeFilter);
            }
            if (query.activoFilter != null) {
              rows = rows.filter((r) => r.activo === query.activoFilter);
            }
            resolve({ data: rows, error: null });
          },
        };
      }

      if (table === 'canchas') {
        return {
          select(_cols, opts) {
            this._countOnly = opts?.head === true;
            return this;
          },
          eq(col, val) {
            if (col === 'sede_id') this._sedeId = Number(val);
            return this;
          },
          then(resolve) {
            const rows = canchaRows.filter((r) => Number(r.sede_id) === this._sedeId);
            if (this._countOnly) {
              resolve({ count: rows.length, data: null, error: null });
              return;
            }
            resolve({ data: rows, error: null });
          },
        };
      }

      if (table === 'user_roles') {
        return {
          select(_cols, opts) {
            this._countOnly = opts?.head === true;
            return this;
          },
          eq(col, val) {
            this._filters = this._filters ?? [];
            this._filters.push([col, val]);
            return this;
          },
          then(resolve) {
            let rows = [...adminRows];
            for (const [col, val] of this._filters ?? []) {
              rows = rows.filter((r) => r[col] === val || Number(r[col]) === Number(val));
            }
            if (this._countOnly) {
              resolve({ count: rows.length, data: null, error: null });
              return;
            }
            resolve({ data: rows, error: null });
          },
        };
      }

      if (table === 'padbol_match_setup_status') {
        const query = { sedeFilter: null };

        return {
          select() { return this; },
          eq(col, val) {
            if (col === 'sede_id') query.sedeFilter = Number(val);
            return this;
          },
          maybeSingle: async () => {
            const row = setupRows.find((r) => Number(r.sede_id) === query.sedeFilter);
            return { data: row ?? null, error: null };
          },
          upsert(payload) {
            const idx = setupRows.findIndex((r) => Number(r.sede_id) === Number(payload.sede_id));
            const row = {
              id: `setup-${payload.sede_id}`,
              created_at: new Date().toISOString(),
              ...payload,
            };
            if (idx >= 0) {
              setupRows[idx] = { ...setupRows[idx], ...row };
            } else {
              setupRows.push(row);
            }
            return {
              select() { return this; },
              single: async () => ({ data: row, error: null }),
            };
          },
        };
      }

      throw new Error(`tabla inesperada: ${table}`);
    },
  };

  return {
    supabase,
    padcoinsRows,
    premioRows,
    setupRows,
  };
}

describe('padbolMatchSetup — permisos', () => {
  it('Super Admin puede leer y escribir cualquier sede', () => {
    assert.equal(canReadPadbolMatchSetup({ rol: 'super_admin' }, 99), true);
    assert.equal(canWritePadbolMatchSetup({ rol: 'super_admin' }, 99), true);
  });

  it('Admin Club solo puede leer su sede', () => {
    assert.equal(canReadPadbolMatchSetup({ rol: 'admin_club', sede_id: 1 }, 1), true);
    assert.equal(canReadPadbolMatchSetup({ rol: 'admin_club', sede_id: 1 }, 2), false);
    assert.equal(canWritePadbolMatchSetup({ rol: 'admin_club', sede_id: 1 }, 1), false);
  });

  it('Admin Nacional sin acceso', () => {
    assert.equal(canReadPadbolMatchSetup({ rol: 'admin_nacional', sede_id: 1 }, 1), false);
    assert.equal(canWritePadbolMatchSetup({ rol: 'admin_nacional', sede_id: 1 }, 1), false);
  });
});

describe('initializePadCoinsSetupForSede', () => {
  it('sede sin configuración PadCoins crea config activa y 5%', async () => {
    const store = buildSetupStore({
      padcoinsConfig: null,
      admins: [{ role: 'admin_club', sede_id: SEDE_ID, email: 'admin@test.com' }],
      canchas: [{ id: 1, sede_id: SEDE_ID }],
      premios: [{ id: 'p1', sede_id: SEDE_ID, nombre: 'Premio', activo: true, costo_padcoins: 100 }],
    });

    const result = await initializePadCoinsSetupForSede(store.supabase, SEDE_ID, {
      actor_user_id: ADMIN_USER_ID,
    });

    assert.equal(result.ok, true);
    assert.ok(result.summary.created.includes('padcoins_sede_config'));
    assert.ok(result.summary.created.includes('porcentaje_devolucion_reserva_5'));
    assert.equal(result.padcoins.activo, true);
    assert.equal(result.padcoins.porcentaje_efectivo, 5);
    assert.equal(store.padcoinsRows.length, 1);
    assert.equal(store.padcoinsRows[0].activo, true);
  });

  it('inicialización idempotente no duplica config existente', async () => {
    const store = buildSetupStore({
      padcoinsConfig: {
        id: 'cfg-existing',
        sede_id: SEDE_ID,
        activo: true,
        descripcion: 'Ya existe',
        rule_overrides: { porcentaje_devolucion_reserva: 5 },
      },
      admins: [{ role: 'admin_club', sede_id: SEDE_ID, email: 'admin@test.com' }],
      canchas: [{ id: 1, sede_id: SEDE_ID }],
      premios: [{ id: 'p1', sede_id: SEDE_ID, nombre: 'Premio', activo: true, costo_padcoins: 100 }],
    });

    const result = await initializePadCoinsSetupForSede(store.supabase, SEDE_ID, {
      actor_user_id: ADMIN_USER_ID,
    });

    assert.ok(result.summary.already_existed.includes('padcoins_sede_config'));
    assert.ok(result.summary.already_existed.includes('porcentaje_devolucion_reserva_5'));
    assert.equal(store.padcoinsRows.length, 1);
    assert.ok(!result.summary.created.includes('padcoins_sede_config'));
  });

  it('seed_beneficios crea sugeridos sin duplicar', async () => {
    const store = buildSetupStore({
      padcoinsConfig: {
        id: 'cfg-1',
        sede_id: SEDE_ID,
        activo: true,
        rule_overrides: {},
      },
      premios: [{
        id: 'p-existing',
        sede_id: SEDE_ID,
        nombre: PADBOL_MATCH_SUGGESTED_PREMIOS[0].nombre,
        activo: true,
        costo_padcoins: 150,
      }],
      admins: [{ role: 'admin_club', sede_id: SEDE_ID, email: 'admin@test.com' }],
      canchas: [{ id: 1, sede_id: SEDE_ID }],
    });

    const result = await initializePadCoinsSetupForSede(store.supabase, SEDE_ID, {
      actor_user_id: ADMIN_USER_ID,
      seed_beneficios: true,
    });

    const createdPremios = result.summary.created.filter((x) => x.startsWith('premio:'));
    assert.equal(createdPremios.length, PADBOL_MATCH_SUGGESTED_PREMIOS.length - 1);
    assert.equal(store.premioRows.length, PADBOL_MATCH_SUGGESTED_PREMIOS.length);
  });
});

describe('validateSetupForSede', () => {
  it('devuelve faltantes cuando la sede no está lista', async () => {
    const store = buildSetupStore({
      padcoinsConfig: {
        id: 'cfg-1',
        sede_id: SEDE_ID,
        activo: false,
        rule_overrides: {},
      },
      admins: [],
      canchas: [],
      premios: [],
    });

    const validation = await validateSetupForSede(store.supabase, SEDE_ID);

    assert.equal(validation.ok, false);
    assert.ok(validation.missing.includes(PADBOL_MATCH_SETUP_STEPS.ADMIN_SEDE_CONFIGURADO));
    assert.ok(validation.missing.includes(PADBOL_MATCH_SETUP_STEPS.PADCOINS_ACTIVADO));
    assert.ok(validation.missing.includes(PADBOL_MATCH_SETUP_STEPS.BENEFICIOS_INICIALES_CONFIGURADOS));
    assert.ok(validation.missing.includes(PADBOL_MATCH_SETUP_STEPS.RESERVA_VISIBLE_PARA_JUGADOR));
    assert.ok(validation.next_actions.length > 0);
    assert.equal(validation.checklist_completo, false);
    assert.ok(validation.persisted);
  });

  it('devuelve completo si todo está listo', async () => {
    const store = buildSetupStore({
      padcoinsConfig: {
        id: 'cfg-1',
        sede_id: SEDE_ID,
        activo: true,
        rule_overrides: { porcentaje_devolucion_reserva: 5 },
      },
      admins: [{ role: 'admin_club', sede_id: SEDE_ID, email: 'admin@test.com' }],
      canchas: [{ id: 1, sede_id: SEDE_ID }],
      premios: [{ id: 'p1', sede_id: SEDE_ID, nombre: 'Beneficio', activo: true, costo_padcoins: 200 }],
    });

    const validation = await validateSetupForSede(store.supabase, SEDE_ID);

    assert.equal(validation.ok, true);
    assert.deepEqual(validation.missing, []);
    assert.equal(validation.checklist_completo, true);
    assert.equal(validation.checklist.every((item) => item.status === 'ok'), true);
    assert.ok(validation.checklist.some((item) => item.key === PADBOL_MATCH_SETUP_STEPS.PADCOINS_DEFAULT_5_CONFIGURADO));
  });
});

describe('getSetupStatus', () => {
  it('respeta sede_id en live flags', async () => {
    const store = buildSetupStore({
      sedeId: OTHER_SEDE_ID,
      padcoinsConfig: {
        id: 'cfg-2',
        sede_id: OTHER_SEDE_ID,
        activo: true,
        rule_overrides: {},
      },
      admins: [{ role: 'admin_club', sede_id: OTHER_SEDE_ID, email: 'admin2@test.com' }],
      canchas: [{ id: 2, sede_id: OTHER_SEDE_ID }],
      premios: [{ id: 'p2', sede_id: OTHER_SEDE_ID, nombre: 'Otro', activo: true, costo_padcoins: 100 }],
    });

    const result = await getSetupStatus(store.supabase, OTHER_SEDE_ID);

    assert.equal(result.sede_id, OTHER_SEDE_ID);
    assert.equal(result.live.padcoins_activado, true);
    assert.equal(result.checklist_completo, true);
  });
});
