import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertPadcoinsAlertasSuperAdminAccess,
  buildPadcoinsAlert,
  evaluateAjustesManualesAlert,
  evaluateCanjesSospechososAlert,
  evaluateReservasPadcoinsAlert,
  getPadcoinsAlertSeverity,
  listPadcoinsAlertasAdmin,
  PADCOINS_ALERT_SEVERITIES,
  PADCOINS_ALERT_TYPES,
  parsePadcoinsAlertasPagination,
} from '../src/padcoins/padcoinsAlertsService.js';

const USER_A = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const USER_B = 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff';
const PERIODO = {
  desde: '2026-07-01T00:00:00.000Z',
  hasta: '2026-07-07T23:59:59.999Z',
  dias: 7,
};

function buildAdjust(id, monto, userId = USER_A, descripcion = 'Ajuste admin') {
  return {
    id,
    user_id: userId,
    tipo: 'adjust',
    monto,
    referencia_tipo: 'bonus_admin',
    descripcion,
    created_at: '2026-07-06T10:00:00.000Z',
    sede_id: 1,
  };
}

describe('padcoinsAlertsService — acceso', () => {
  it('Super Admin puede consultar alertas', () => {
    assert.doesNotThrow(() => {
      assertPadcoinsAlertasSuperAdminAccess({ rol: 'super_admin', sede_id: null });
    });
  });

  it('Admin Club recibe 403', () => {
    assert.throws(
      () => assertPadcoinsAlertasSuperAdminAccess({ rol: 'admin_club', sede_id: 1 }),
      /Solo super_admin/,
    );
  });

  it('Admin Nacional recibe 403', () => {
    assert.throws(
      () => assertPadcoinsAlertasSuperAdminAccess({ rol: 'admin_nacional', sede_id: null }),
      /Solo super_admin/,
    );
  });
});

describe('padcoinsAlertsService — severidad', () => {
  it('ajustes excesivos alta por volumen', () => {
    const severidad = getPadcoinsAlertSeverity(
      PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS,
      { count: 15, total_monto: 6000, max_repeat_user_count: 2 },
    );
    assert.equal(severidad, PADCOINS_ALERT_SEVERITIES.ALTA);
  });

  it('canjes sospechosos media por repetición', () => {
    const severidad = getPadcoinsAlertSeverity(
      PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS,
      { count: 10, count_24h: 5, low_cost_count: 2, repeat_user_count: 4 },
    );
    assert.equal(severidad, PADCOINS_ALERT_SEVERITIES.MEDIA);
  });
});

describe('padcoinsAlertsService — detectores', () => {
  it('ajuste manual excesivo genera alerta', () => {
    const movimientos = Array.from({ length: 6 }, (_, i) => buildAdjust(`a${i}`, 300, i % 2 === 0 ? USER_A : USER_B));
    const alertas = evaluateAjustesManualesAlert(movimientos, {
      sedeId: 1,
      sedeNombre: 'La Meca',
      periodo: PERIODO,
    });

    const abusive = alertas.find((a) => a.tipo_alerta === PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS);
    assert.ok(abusive);
    assert.equal(abusive.metricas.count, 6);
    assert.equal(abusive.metricas.total_monto, 1800);
    assert.ok(['media', 'alta'].includes(abusive.severidad));
  });

  it('campaña identificada reduce alerta abusiva', () => {
    const movimientos = [
      ...Array.from({ length: 4 }, (_, i) => buildAdjust(`a${i}`, 200, i % 2 === 0 ? USER_A : USER_B)),
      buildAdjust('camp1', 500, USER_A, 'Campaña marketing verano'),
    ];
    const alertas = evaluateAjustesManualesAlert(movimientos, {
      sedeId: 1,
      sedeNombre: 'La Meca',
      periodo: PERIODO,
    });

    const campania = alertas.find((a) => a.tipo_alerta === PADCOINS_ALERT_TYPES.CAMPANIA_IDENTIFICADA);
    const abusive = alertas.find((a) => a.tipo_alerta === PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS);
    assert.ok(campania);
    assert.equal(abusive, undefined);
  });

  it('canjes masivos generan alerta', () => {
    const now = new Date('2026-07-06T12:00:00.000Z');
    const canjes = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i}`,
      user_id: i < 4 ? USER_A : USER_B,
      monto_padcoins: 50,
      estado: 'pendiente',
      created_at: '2026-07-06T10:00:00.000Z',
      premios_canjeables: { nombre: 'Premio barato', costo_padcoins: 50 },
    }));

    const alertas = evaluateCanjesSospechososAlert(canjes, {
      sedeId: 1,
      sedeNombre: 'La Meca',
      periodo: PERIODO,
      now,
    });

    assert.equal(alertas.length, 1);
    assert.equal(alertas[0].tipo_alerta, PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS);
    assert.equal(alertas[0].metricas.count_24h, 10);
    assert.equal(alertas[0].metricas.low_cost_count, 10);
  });

  it('sede sin actividad anormal no genera alerta abusiva', () => {
    const movimientos = [
      {
        id: 'e1',
        user_id: USER_A,
        tipo: 'earn',
        monto: 100,
        referencia_tipo: 'reserva',
        referencia_id: '10',
        created_at: '2026-07-06T10:00:00.000Z',
      },
      buildAdjust('a1', 50, USER_A, 'Ajuste puntual'),
    ];

    const alertasAjustes = evaluateAjustesManualesAlert(movimientos, {
      sedeId: 1,
      sedeNombre: 'La Meca',
      periodo: PERIODO,
    });
    const alertasReservas = evaluateReservasPadcoinsAlert(movimientos, {
      sedeId: 1,
      sedeNombre: 'La Meca',
      periodo: PERIODO,
    });

    assert.equal(
      alertasAjustes.find((a) => a.tipo_alerta === PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS),
      undefined,
    );
    assert.equal(alertasReservas.length, 0);
  });

  it('earn sin referencia clara genera alerta reservas poco creíble', () => {
    const movimientos = Array.from({ length: 4 }, (_, i) => ({
      id: `u${i}`,
      user_id: USER_A,
      tipo: 'earn',
      monto: 200,
      referencia_tipo: null,
      referencia_id: null,
      created_at: '2026-07-06T10:00:00.000Z',
    }));

    const alertas = evaluateReservasPadcoinsAlert(movimientos, {
      sedeId: 1,
      sedeNombre: 'La Meca',
      periodo: PERIODO,
    });

    assert.equal(alertas.length, 1);
    assert.equal(alertas[0].tipo_alerta, PADCOINS_ALERT_TYPES.RESERVAS_PADCOINS_POCO_CREIBLE);
    assert.equal(alertas[0].metricas.unclear_count, 4);
  });
});

describe('padcoinsAlertsService — listado global', () => {
  it('filtro por sede funciona', async () => {
    const manyAdjustsSede1 = Array.from({ length: 6 }, (_, i) => buildAdjust(`s1-${i}`, 400, USER_A));
    const alertasSede1 = evaluateAjustesManualesAlert(manyAdjustsSede1, {
      sedeId: 1,
      sedeNombre: 'La Meca',
      periodo: PERIODO,
    });

    const filtered = alertasSede1.filter((a) => Number(a.sede_id) === 1);
    assert.ok(filtered.length >= 1);
    assert.ok(filtered.every((a) => Number(a.sede_id) === 1));
  });

  it('paginación funciona', () => {
    const pagination = parsePadcoinsAlertasPagination({ page: 2, limit: 5 });
    assert.deepEqual(pagination, { limit: 5, offset: 5, page: 2 });
  });

  it('buildPadcoinsAlert incluye recomendación', () => {
    const alert = buildPadcoinsAlert({
      tipoAlerta: PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS,
      severidad: PADCOINS_ALERT_SEVERITIES.MEDIA,
      sedeId: 1,
      sedeNombre: 'La Meca',
      metricas: { count: 10 },
      periodo: PERIODO,
    });

    assert.equal(alert.tipo_alerta, PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS);
    assert.ok(alert.recomendacion);
    assert.ok(alert.descripcion);
  });
});

describe('padcoinsAlertsService — listPadcoinsAlertasAdmin integración mock', () => {
  it('Super Admin lista alertas calculadas sin mutar saldo', async () => {
    let insertCalled = false;
    const adjusts = Array.from({ length: 7 }, (_, i) => buildAdjust(`adj-${i}`, 250, USER_A));

    const supabaseAdmin = {
      from(table) {
        if (table === 'padcoins_movimientos') {
          return {
            select() { return this; },
            eq(_col, sedeId) {
              return {
                gte() {
                  return {
                    lte: async () => ({ data: adjusts, error: null }),
                  };
                },
              };
            },
            not() { return this; },
            gte() { return this; },
            lte: async () => ({ data: [{ sede_id: 1 }], error: null }),
            insert() { insertCalled = true; return this; },
          };
        }
        if (table === 'padcoins_canjes') {
          return {
            select() { return this; },
            eq() { return this; },
            gte() { return this; },
            lte: async () => ({ data: [], error: null }),
          };
        }
        if (table === 'sedes') {
          return {
            select() { return this; },
            in: async () => ({ data: [{ id: 1, nombre: 'La Meca' }], error: null }),
          };
        }
        return {
          insert() { insertCalled = true; return this; },
        };
      },
    };

    const result = await listPadcoinsAlertasAdmin(supabaseAdmin, {
      role: { rol: 'super_admin', sede_id: null },
      query: { sede_id: 1 },
    });

    assert.ok(result.alertas.length >= 1);
    assert.equal(insertCalled, false);
    assert.ok(result.nota.includes('tiempo real'));
  });
});
