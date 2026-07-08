import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PADCOINS_CAMPAIGN_STATUSES,
  PADCOINS_CAMPAIGN_TYPES,
} from '../src/padcoins/padcoinsCampaignsConfig.js';
import {
  canReadPadcoinsCampaign,
  canWritePadcoinsCampaign,
  createPadcoinsCampaign,
  evaluateCampaignHighImpact,
  activatePadcoinsCampaign,
  pausePadcoinsCampaign,
} from '../src/padcoins/padcoinsCampaignsService.js';
import {
  applyCampaignToPadcoinsEarn,
  isCampaignEligibleForContext,
  resolveActiveCampaignForReserva,
} from '../src/padcoins/padcoinsCampaignResolverService.js';
import { PADCOINS_RESERVATION_CALC_MODE } from '../src/padcoins/padcoinsGlobalConfigService.js';

const USER_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const CAMPAIGN_ID = '11111111-2222-3333-4444-555555555555';
const BENEFIT_ID = '22222222-3333-4444-5555-666666666666';
const NOW = new Date('2026-07-10T15:00:00.000Z');

function futureRange() {
  return {
    start_at: '2026-07-01T00:00:00.000Z',
    end_at: '2026-12-31T23:59:59.999Z',
  };
}

function pastRange() {
  return {
    start_at: '2026-01-01T00:00:00.000Z',
    end_at: '2026-06-01T00:00:00.000Z',
  };
}

function buildCampaignStore(initial = []) {
  const campaigns = [...initial];
  const audit = [];
  const applications = [];

  return {
    campaigns,
    audit,
    applications,
    supabase: {
      from(table) {
        if (table === 'padcoins_campaigns') {
          const query = { filters: [], neq: null, limitN: null };

          const applyFilters = (rows) => {
            let result = [...rows];
            for (const [col, val] of query.filters) {
              result = result.filter((r) => r[col] === val || Number(r[col]) === Number(val));
            }
            if (query.neq) {
              result = result.filter((r) => r[query.neq.col] !== query.neq.val);
            }
            if (query.limitN != null) {
              result = result.slice(0, query.limitN);
            }
            return result;
          };

          return {
            select() { return this; },
            eq(col, val) {
              query.filters.push([col, val]);
              return this;
            },
            neq(col, val) {
              query.neq = { col, val };
              return this;
            },
            lte() { return this; },
            gte() { return this; },
            order() { return this; },
            limit(n) {
              query.limitN = n;
              return this;
            },
            maybeSingle: async () => {
              const rows = applyFilters(campaigns);
              return { data: rows[0] ?? null, error: null };
            },
            single: async () => {
              const rows = applyFilters(campaigns);
              return { data: rows[0] ?? null, error: null };
            },
            insert(payload) {
              const row = {
                ...payload,
                id: payload.id ?? CAMPAIGN_ID,
                created_at: NOW.toISOString(),
              };
              campaigns.push(row);
              return { select: () => ({ single: async () => ({ data: row, error: null }) }) };
            },
            update(payload) {
              return {
                eq(col, val) {
                  const idx = campaigns.findIndex((c) => c[col] === val || String(c[col]) === String(val));
                  if (idx >= 0) {
                    campaigns[idx] = { ...campaigns[idx], ...payload };
                  }
                  return {
                    select: () => ({
                      single: async () => ({ data: campaigns[idx] ?? null, error: null }),
                    }),
                  };
                },
              };
            },
            then(resolve) {
              resolve({ data: applyFilters(campaigns), error: null });
            },
          };
        }

        if (table === 'padcoins_campaign_audit_logs') {
          return {
            insert(payload) {
              audit.push(payload);
              return {
                select: () => ({
                  single: async () => ({ data: { id: 'audit-1', ...payload }, error: null }),
                }),
              };
            },
            select() { return this; },
            eq() { return this; },
            order() { return this; },
            limit: async () => ({ data: audit, error: null }),
          };
        }

        if (table === 'padcoins_campaign_applications') {
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
            limit() { return this; },
            maybeSingle: async () => {
              const match = applications.find((a) =>
                this._filters?.every(([col, val]) => a[col] === val || String(a[col]) === String(val)));
              return { data: match ?? null, error: null };
            },
            insert(payload) {
              applications.push({ id: `app-${applications.length + 1}`, ...payload });
              return {
                select: () => ({
                  single: async () => ({ data: applications[applications.length - 1], error: null }),
                }),
              };
            },
            then(resolve) {
              if (this._countOnly) {
                let rows = applications;
                for (const [col, val] of this._filters ?? []) {
                  rows = rows.filter((r) => r[col] === val || String(r[col]) === String(val));
                }
                resolve({ count: rows.length, data: null, error: null });
                return;
              }
              resolve({ data: applications, error: null });
            },
          };
        }

        if (table === 'premios_canjeables') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: {
                id: BENEFIT_ID,
                sede_id: 1,
                costo_padcoins: 400,
                activo: true,
              },
              error: null,
            }),
          };
        }

        throw new Error(`tabla inesperada: ${table}`);
      },
    },
  };
}

describe('padcoinsCampaigns — permisos', () => {
  it('Super Admin puede ver/editar cualquier sede', () => {
    assert.equal(canReadPadcoinsCampaign({ rol: 'super_admin' }, 99), true);
    assert.equal(canWritePadcoinsCampaign({ rol: 'super_admin' }, 99), true);
  });

  it('Admin Club solo su sede', () => {
    assert.equal(canReadPadcoinsCampaign({ rol: 'admin_club', sede_id: 2 }, 2), true);
    assert.equal(canReadPadcoinsCampaign({ rol: 'admin_club', sede_id: 2 }, 3), false);
  });

  it('Admin Nacional sin acceso', () => {
    assert.equal(canReadPadcoinsCampaign({ rol: 'admin_nacional', sede_id: 1 }, 1), false);
  });
});

describe('padcoinsCampaigns — high impact', () => {
  it('multiplicador alto marca high_impact sin bloquear', () => {
    const result = evaluateCampaignHighImpact({
      campaign_type: PADCOINS_CAMPAIGN_TYPES.MULTIPLIER,
      multiplier: 3,
      estimated_cost_reference: 100,
    });
    assert.equal(result.high_impact, true);
    assert.ok(result.reasons.includes('multiplier_alto'));
  });
});

describe('applyCampaignToPadcoinsEarn', () => {
  const reservationConfig = {
    padcoins_por_usd_equivalente: 100,
    modo_calculo_reserva: PADCOINS_RESERVATION_CALC_MODE.PERCENTAGE_PAID,
  };

  const reservaUsd = {
    monto_pagado: 50,
    moneda: 'USD',
    pago_estado: 'pagado',
  };

  it('campaña multiplicadora', async () => {
    const result = await applyCampaignToPadcoinsEarn(null, {
      basePadcoins: 250,
      baseAmountResult: { method: 'proportional' },
      campaign: {
        id: CAMPAIGN_ID,
        sede_id: 1,
        name: 'Doble',
        campaign_type: PADCOINS_CAMPAIGN_TYPES.MULTIPLIER,
        multiplier: 2,
      },
      reserva: reservaUsd,
      reservationConfig,
    });
    assert.equal(result.final_padcoins, 500);
    assert.equal(result.calculation_detail.multiplier, 2);
  });

  it('campaña con porcentaje override', async () => {
    const store = buildCampaignStore();
    const result = await applyCampaignToPadcoinsEarn(store.supabase, {
      basePadcoins: 250,
      baseAmountResult: { method: 'proportional' },
      campaign: {
        id: CAMPAIGN_ID,
        sede_id: 1,
        name: '10%',
        campaign_type: PADCOINS_CAMPAIGN_TYPES.PERCENTAGE_OVERRIDE,
        loyalty_percentage_override: 10,
      },
      reserva: reservaUsd,
      reservationConfig,
    });
    assert.equal(result.final_padcoins, 500);
  });

  it('campaña fija', async () => {
    const result = await applyCampaignToPadcoinsEarn(null, {
      basePadcoins: 30,
      campaign: {
        id: CAMPAIGN_ID,
        sede_id: 1,
        name: 'Fija',
        campaign_type: PADCOINS_CAMPAIGN_TYPES.FIXED_PADCOINS,
        fixed_padcoins: 150,
      },
      reserva: reservaUsd,
      reservationConfig,
    });
    assert.equal(result.final_padcoins, 150);
  });
});

describe('isCampaignEligibleForContext', () => {
  it('campaña fuera de fecha no aplica', async () => {
    const store = buildCampaignStore();
    const campaign = {
      id: CAMPAIGN_ID,
      status: PADCOINS_CAMPAIGN_STATUSES.ACTIVE,
      ...pastRange(),
      max_total_uses: null,
      max_uses_per_player: null,
      segment_config: {},
    };
    const result = await isCampaignEligibleForContext(store.supabase, campaign, {
      userId: USER_ID,
      now: NOW,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'out_of_date_window');
  });

  it('campaña pausada no aplica', async () => {
    const store = buildCampaignStore();
    const campaign = {
      id: CAMPAIGN_ID,
      status: PADCOINS_CAMPAIGN_STATUSES.PAUSED,
      ...futureRange(),
      segment_config: {},
    };
    const result = await isCampaignEligibleForContext(store.supabase, campaign, {
      userId: USER_ID,
      now: NOW,
    });
    assert.equal(result.eligible, false);
    assert.equal(result.reason, 'not_active');
  });
});

describe('padcoinsCampaignsService — CRUD y activación', () => {
  it('crear campaña high impact genera audit sin bloquear', async () => {
    const store = buildCampaignStore();
    const campaign = await createPadcoinsCampaign(store.supabase, {
      role: { rol: 'admin_club', sede_id: 1 },
      body: {
        sede_id: 1,
        name: 'Promo agresiva',
        campaign_type: PADCOINS_CAMPAIGN_TYPES.MULTIPLIER,
        multiplier: 3,
        ...futureRange(),
        estimated_cost_reference: 8000,
      },
      actor_user_id: USER_ID,
    });

    assert.equal(campaign.high_impact, true);
    assert.ok(store.audit.some((a) => a.action === 'high_impact_flagged'));
  });

  it('Admin Club no puede crear en otra sede', async () => {
    const store = buildCampaignStore();
    await assert.rejects(
      () => createPadcoinsCampaign(store.supabase, {
        role: { rol: 'admin_club', sede_id: 1 },
        body: {
          sede_id: 2,
          name: 'Ajena',
          campaign_type: PADCOINS_CAMPAIGN_TYPES.FIXED_PADCOINS,
          fixed_padcoins: 100,
          ...futureRange(),
        },
        actor_user_id: USER_ID,
      }),
      (err) => err.status === 403,
    );
  });

  it('activar campaña pausa otras activas de la sede', async () => {
    const store = buildCampaignStore([
      {
        id: 'aaaaaaa1-2222-3333-4444-555555555555',
        sede_id: 1,
        name: 'Vieja',
        campaign_type: PADCOINS_CAMPAIGN_TYPES.MULTIPLIER,
        multiplier: 2,
        status: PADCOINS_CAMPAIGN_STATUSES.ACTIVE,
        ...futureRange(),
        high_impact: false,
        segment_config: {},
      },
      {
        id: CAMPAIGN_ID,
        sede_id: 1,
        name: 'Nueva',
        campaign_type: PADCOINS_CAMPAIGN_TYPES.MULTIPLIER,
        multiplier: 1.5,
        status: PADCOINS_CAMPAIGN_STATUSES.DRAFT,
        ...futureRange(),
        high_impact: false,
        segment_config: {},
        created_by: USER_ID,
      },
    ]);

    const activated = await activatePadcoinsCampaign(store.supabase, CAMPAIGN_ID, {
      role: { rol: 'super_admin' },
      actor_user_id: USER_ID,
    });

    assert.equal(activated.status, PADCOINS_CAMPAIGN_STATUSES.ACTIVE);
    const old = store.campaigns.find((c) => c.id === 'aaaaaaa1-2222-3333-4444-555555555555');
    assert.equal(old.status, PADCOINS_CAMPAIGN_STATUSES.PAUSED);
  });
});

describe('resolveActiveCampaignForReserva', () => {
  it('resuelve campaña activa en ventana', async () => {
    const store = buildCampaignStore([
      {
        id: CAMPAIGN_ID,
        sede_id: 1,
        name: 'Activa',
        campaign_type: PADCOINS_CAMPAIGN_TYPES.MULTIPLIER,
        multiplier: 2,
        status: PADCOINS_CAMPAIGN_STATUSES.ACTIVE,
        ...futureRange(),
        high_impact: false,
        segment_config: {},
        updated_at: NOW.toISOString(),
      },
    ]);

    const campaign = await resolveActiveCampaignForReserva(store.supabase, {
      sedeId: 1,
      userId: USER_ID,
      reservaId: '99',
      now: NOW,
    });

    assert.ok(campaign);
    assert.equal(campaign.id, CAMPAIGN_ID);
  });
});
