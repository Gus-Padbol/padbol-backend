import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PRICE_SOURCES,
  resolveReservaBasePrice,
  resolveLegacySedePrice,
} from '../src/pricing/resolveReservaBasePrice.js';
import { calculateSurgePrice } from '../src/surge.js';

const SEDE_ID = 1;

const LA_MECA_SEDE = {
  id: SEDE_ID,
  nombre: 'La Meca',
  timezone: 'America/Argentina/Buenos_Aires',
  cantidad_canchas: 2,
  precio_60min: 25000,
  precio_90min: 30000,
  precio_120min: 35000,
  precio_turno: null,
  precio_por_reserva: null,
};

const LA_MECA_DURACIONES = [
  { id: 10, sede_id: SEDE_ID, duracion_minutos: 60, precio: 22000, activo: true, deporte: null },
  { id: 11, sede_id: SEDE_ID, duracion_minutos: 90, precio: 30000, activo: true, deporte: null },
  { id: 12, sede_id: SEDE_ID, duracion_minutos: 120, precio: 40000, activo: true, deporte: null },
];

function createPricingMock({
  sede = LA_MECA_SEDE,
  duraciones = LA_MECA_DURACIONES,
  franjas = [],
  surgeConfig = null,
  reservas = [],
} = {}) {
  const supabaseAdmin = {
    from(table) {
      const api = {
        _filters: {},
        _or: null,
        select() { return api; },
        eq(col, val) {
          this._filters[col] = val;
          return api;
        },
        or(expr) {
          this._or = expr;
          return api;
        },
        is(col, val) {
          this._filters[col] = val;
          return api;
        },
        order() { return api; },
        insert() {
          return Promise.resolve({ error: null });
        },
        maybeSingle() {
          if (table === 'sedes') {
            const id = Number(this._filters.id);
            if (Number(sede.id) === id) {
              return Promise.resolve({ data: sede, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          }
          if (table === 'surge_config') {
            if (surgeConfig && Number(surgeConfig.sede_id) === Number(this._filters.sede_id)) {
              const dep = this._filters.deporte;
              if (!dep || surgeConfig.deporte === dep) {
                return Promise.resolve({ data: surgeConfig, error: null });
              }
            }
            return Promise.resolve({ data: null, error: null });
          }
          return Promise.resolve({ data: null, error: null });
        },
        then(resolve, reject) {
          try {
            if (table === 'sedes_duraciones') {
              let rows = [...duraciones];
              if (this._filters.sede_id != null) {
                rows = rows.filter((r) => Number(r.sede_id) === Number(this._filters.sede_id));
              }
              if (this._filters.duracion_minutos != null) {
                rows = rows.filter((r) => Number(r.duracion_minutos) === Number(this._filters.duracion_minutos));
              }
              if (this._filters.activo === true) {
                rows = rows.filter((r) => r.activo !== false);
              }
              return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
            }
            if (table === 'franjas_precio') {
              let rows = [...franjas];
              if (this._filters.sede_id != null) {
                rows = rows.filter((r) => Number(r.sede_id) === Number(this._filters.sede_id));
              }
              if (this._filters.deporte != null) {
                rows = rows.filter((r) => r.deporte === this._filters.deporte);
              }
              if (this._filters.activo === true) {
                rows = rows.filter((r) => r.activo !== false);
              }
              return Promise.resolve({ data: rows, error: null }).then(resolve, reject);
            }
            if (table === 'reservas') {
              return Promise.resolve({ data: reservas, error: null }).then(resolve, reject);
            }
            if (table === 'canchas' || table === 'cancha') {
              return Promise.resolve({ data: [], error: null }).then(resolve, reject);
            }
            if (table === 'surge_historial') {
              return Promise.resolve({ error: null }).then(resolve, reject);
            }
            return Promise.resolve({ data: [], error: null }).then(resolve, reject);
          } catch (err) {
            return Promise.reject(err).then(resolve, reject);
          }
        },
      };
      return api;
    },
  };
  return supabaseAdmin;
}

describe('resolveReservaBasePrice — prioridad sedes_duraciones vs legacy', () => {
  it('sedes_duraciones base NULL gana sobre columnas legacy (La Meca 60 → 22000)', async () => {
    const supabaseAdmin = createPricingMock();
    const result = await resolveReservaBasePrice(supabaseAdmin, {
      sedeId: SEDE_ID,
      sede: LA_MECA_SEDE,
      duracionMinutos: 60,
      deporte: 'padbol',
    });

    assert.equal(result.precio, 22000);
    assert.equal(result.source, PRICE_SOURCES.SEDES_DURACIONES_BASE);
    assert.equal(result.legacyField, null);
  });

  it('sedes_duraciones deporte específico gana sobre base NULL', async () => {
    const supabaseAdmin = createPricingMock({
      duraciones: [
        { id: 1, sede_id: SEDE_ID, duracion_minutos: 60, precio: 22000, activo: true, deporte: null },
        { id: 2, sede_id: SEDE_ID, duracion_minutos: 60, precio: 18000, activo: true, deporte: 'padel' },
      ],
    });

    const result = await resolveReservaBasePrice(supabaseAdmin, {
      sedeId: SEDE_ID,
      sede: LA_MECA_SEDE,
      duracionMinutos: 60,
      deporte: 'padel',
    });

    assert.equal(result.precio, 18000);
    assert.equal(result.source, PRICE_SOURCES.SEDES_DURACIONES_DEPORTE);
  });

  it('franja_precio gana sobre sedes_duraciones', async () => {
    const slot = '2026-07-10T18:00:00-03:00';
    const supabaseAdmin = createPricingMock({
      franjas: [{
        id: 99,
        sede_id: SEDE_ID,
        deporte: 'padbol',
        activo: true,
        dia_semana: 5,
        hora_inicio: '17:00',
        hora_fin: '23:00',
        precio_60min: 50000,
        precio_90min: 60000,
        precio_120min: 70000,
      }],
    });

    const result = await resolveReservaBasePrice(supabaseAdmin, {
      sedeId: SEDE_ID,
      sede: LA_MECA_SEDE,
      duracionMinutos: 60,
      deporte: 'padbol',
      slotInicio: slot,
    });

    assert.equal(result.precio, 50000);
    assert.equal(result.source, PRICE_SOURCES.FRANJA_PRECIO);
    assert.equal(result.franja_id, 99);
  });

  it('fallback legacy funciona si no hay sedes_duraciones', async () => {
    const supabaseAdmin = createPricingMock({ duraciones: [] });
    const result = await resolveReservaBasePrice(supabaseAdmin, {
      sedeId: SEDE_ID,
      sede: LA_MECA_SEDE,
      duracionMinutos: 60,
      deporte: 'padbol',
    });

    assert.equal(result.precio, 25000);
    assert.equal(result.source, PRICE_SOURCES.LEGACY_SEDE);
    assert.equal(result.legacyField, 'precio_60min');
  });

  it('duración custom 75 funciona si existe en sedes_duraciones', async () => {
    const supabaseAdmin = createPricingMock({
      duraciones: [
        { id: 20, sede_id: SEDE_ID, duracion_minutos: 75, precio: 28000, activo: true, deporte: null },
      ],
    });

    const result = await resolveReservaBasePrice(supabaseAdmin, {
      sedeId: SEDE_ID,
      sede: LA_MECA_SEDE,
      duracionMinutos: 75,
      deporte: 'padbol',
    });

    assert.equal(result.precio, 28000);
    assert.equal(result.source, PRICE_SOURCES.SEDES_DURACIONES_BASE);
  });

  it('duración custom sin precio no devuelve precio válido silencioso', async () => {
    const supabaseAdmin = createPricingMock({ duraciones: [] });
    const result = await resolveReservaBasePrice(supabaseAdmin, {
      sedeId: SEDE_ID,
      sede: LA_MECA_SEDE,
      duracionMinutos: 75,
      deporte: 'padbol',
    });

    assert.equal(result.precio, 0);
    assert.equal(result.source, PRICE_SOURCES.NONE);
  });
});

describe('resolveLegacySedePrice', () => {
  it('usa precio_turno para 90 si no hay columna precio_90min', () => {
    const legacy = resolveLegacySedePrice(
      { precio_90min: null, precio_turno: 31000 },
      90,
    );
    assert.equal(legacy.precio, 31000);
    assert.equal(legacy.legacyField, 'precio_turno');
  });
});

describe('calculateSurgePrice — integración MEJ-04', () => {
  it('usa sedes_duraciones sin romper respuesta sin surge activo', async () => {
    const supabaseAdmin = createPricingMock({ surgeConfig: null });
    const result = await calculateSurgePrice(supabaseAdmin, SEDE_ID, 'padbol', 60);

    assert.equal(result.precio, 22000);
    assert.equal(result.precio_base, 22000);
    assert.equal(result.surge_activo, false);
    assert.equal(result.precio_metadata.source, PRICE_SOURCES.SEDES_DURACIONES_BASE);
  });

  it('lanza 400 si duración sin precio configurado (no cobra 0)', async () => {
    const supabaseAdmin = createPricingMock({ duraciones: [] });
    const sedeSinLegacy = {
      ...LA_MECA_SEDE,
      precio_60min: null,
      precio_90min: null,
      precio_120min: null,
    };
    const mock = createPricingMock({ duraciones: [], sede: sedeSinLegacy });

    await assert.rejects(
      () => calculateSurgePrice(mock, SEDE_ID, 'padbol', 75),
      (err) => {
        assert.equal(err.status, 400);
        assert.match(err.message, /No hay precio configurado/);
        return true;
      },
    );
  });

  it('franja activa retorna sin surge', async () => {
    const slot = '2026-07-10T18:00:00-03:00';
    const supabaseAdmin = createPricingMock({
      franjas: [{
        id: 5,
        sede_id: SEDE_ID,
        deporte: 'padbol',
        activo: true,
        dia_semana: 5,
        hora_inicio: '17:00',
        hora_fin: '23:00',
        precio_60min: 45000,
        precio_90min: 55000,
        precio_120min: 65000,
      }],
    });

    const result = await calculateSurgePrice(supabaseAdmin, SEDE_ID, 'padbol', 60, {
      slot_inicio: slot,
    });

    assert.equal(result.precio, 45000);
    assert.equal(result.franja_activa, true);
    assert.equal(result.surge_activo, false);
  });
});
