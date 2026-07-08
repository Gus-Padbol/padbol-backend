import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  PADCOINS_CAMPAIGN_STATUSES,
  PADCOINS_CAMPAIGN_TYPES,
} from '../src/padcoins/padcoinsCampaignsConfig.js';
import {
  buildCampaignTypeLabel,
  buildPlayerCampaignDisplay,
  buildPlayerCampaignPayload,
  getActiveCampaignForSedePlayer,
  DEFAULT_DISPLAY,
} from '../src/padcoins/padcoinsCampaignPlayerService.js';

const CAMPAIGN_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_CAMPAIGN_ID = 'aaaaaaa1-2222-3333-4444-555555555555';
const NOW = new Date('2026-07-10T15:00:00.000Z');

const INTERNAL_FIELD_NAMES = [
  'estimated_cost_reference',
  'segment_config',
  'created_by',
  'high_impact',
  'benefit_id',
  'loyalty_percentage_override',
  'fixed_padcoins',
  'multiplier',
  'status',
  'updated_at',
];

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

function buildPlayerCampaignStore({
  campaigns = [],
  sedeParticipa = true,
  sedeId = 1,
  applications = [],
} = {}) {
  const campaignRows = [...campaigns];
  const applicationRows = [...applications];

  return {
    campaigns: campaignRows,
    applications: applicationRows,
    supabase: {
      from(table) {
        if (table === 'padcoins_sede_config') {
          return {
            select() { return this; },
            eq() { return this; },
            maybeSingle: async () => ({
              data: sedeParticipa
                ? {
                  id: 'cfg-1',
                  sede_id: sedeId,
                  activo: true,
                  fecha_inicio: null,
                  fecha_fin: null,
                  rule_overrides: {},
                }
                : {
                  id: 'cfg-1',
                  sede_id: sedeId,
                  activo: false,
                  fecha_inicio: null,
                  fecha_fin: null,
                  rule_overrides: {},
                },
              error: null,
            }),
          };
        }

        if (table === 'padcoins_campaigns') {
          const query = { filters: [], limitN: null };

          const applyFilters = (rows) => {
            let result = [...rows];
            for (const [col, val] of query.filters) {
              result = result.filter((r) => r[col] === val || Number(r[col]) === Number(val));
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
            lte() { return this; },
            gte() { return this; },
            order() { return this; },
            limit(n) {
              query.limitN = n;
              return this;
            },
            maybeSingle: async () => {
              const rows = applyFilters(campaignRows);
              return { data: rows[0] ?? null, error: null };
            },
            then(resolve) {
              resolve({ data: applyFilters(campaignRows), error: null });
            },
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
            maybeSingle: async () => ({ data: null, error: null }),
            then(resolve) {
              if (this._countOnly) {
                let rows = applicationRows;
                for (const [col, val] of this._filters ?? []) {
                  rows = rows.filter((r) => r[col] === val || String(r[col]) === String(val));
                }
                resolve({ count: rows.length, data: null, error: null });
                return;
              }
              resolve({ data: applicationRows, error: null });
            },
          };
        }

        throw new Error(`tabla inesperada: ${table}`);
      },
    },
  };
}

function activeCampaignRow(overrides = {}) {
  return {
    id: CAMPAIGN_ID,
    sede_id: 1,
    name: 'Promo verano',
    description: 'Ganá PadCoins extra en esta sede.',
    campaign_type: PADCOINS_CAMPAIGN_TYPES.MULTIPLIER,
    multiplier: 3,
    status: PADCOINS_CAMPAIGN_STATUSES.ACTIVE,
    message_title: 'Campaña PadCoins activa',
    message_body: 'Esta sede tiene una campaña especial por tiempo limitado.',
    estimated_cost_reference: 5000,
    segment_config: { vip: true },
    created_by: 'admin-user',
    high_impact: true,
    benefit_id: null,
    max_total_uses: null,
    max_uses_per_player: null,
    ...futureRange(),
    updated_at: NOW.toISOString(),
    ...overrides,
  };
}

function collectObjectKeys(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const keys = [];
  for (const [key, value] of Object.entries(obj)) {
    keys.push(key);
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      keys.push(...collectObjectKeys(value));
    }
  }
  return keys;
}

function assertNoInternalFields(campaign) {
  const keys = collectObjectKeys(campaign);
  for (const field of INTERNAL_FIELD_NAMES) {
    assert.ok(!keys.includes(field), `no debe exponer ${field}`);
  }
}

describe('padcoinsCampaignPlayer — labels y display', () => {
  it('label multiplier x3', () => {
    assert.equal(
      buildCampaignTypeLabel({ campaign_type: PADCOINS_CAMPAIGN_TYPES.MULTIPLIER, multiplier: 3 }),
      'Triplica PadCoins',
    );
  });

  it('label percentage_override', () => {
    assert.equal(
      buildCampaignTypeLabel({ campaign_type: PADCOINS_CAMPAIGN_TYPES.PERCENTAGE_OVERRIDE }),
      'PadCoins extra',
    );
  });

  it('display usa mensajes de campaña con fallbacks', () => {
    const display = buildPlayerCampaignDisplay({
      campaign_type: PADCOINS_CAMPAIGN_TYPES.MULTIPLIER,
      multiplier: 2,
      message_title: 'Título custom',
      message_body: 'Texto custom',
    });
    assert.equal(display.banner_title, 'Título custom');
    assert.equal(display.banner_text, 'Texto custom');
    assert.equal(display.reservation_hint, DEFAULT_DISPLAY.reservation_hint);
    assert.equal(display.success_hint, DEFAULT_DISPLAY.success_hint);
    assert.equal(display.label, 'Duplica PadCoins');
  });

  it('payload seguro no incluye campos internos', () => {
    const payload = buildPlayerCampaignPayload(activeCampaignRow());
    assertNoInternalFields(payload);
    assert.equal(payload.label, 'Triplica PadCoins');
    assert.ok(payload.display);
  });
});

describe('getActiveCampaignForSedePlayer', () => {
  it('devuelve active false si no hay campaña', async () => {
    const store = buildPlayerCampaignStore({ campaigns: [] });
    const result = await getActiveCampaignForSedePlayer(store.supabase, 1, { now: NOW });
    assert.equal(result.active, false);
    assert.equal(result.campaign, null);
  });

  it('devuelve campaña activa vigente', async () => {
    const store = buildPlayerCampaignStore({
      campaigns: [activeCampaignRow()],
    });

    const result = await getActiveCampaignForSedePlayer(store.supabase, 1, { now: NOW });

    assert.equal(result.active, true);
    assert.ok(result.campaign);
    assert.equal(result.campaign.id, CAMPAIGN_ID);
    assert.equal(result.campaign.sede_id, 1);
    assert.equal(result.campaign.name, 'Promo verano');
    assert.equal(result.campaign.label, 'Triplica PadCoins');
    assert.equal(result.campaign.display.banner_title, 'Campaña PadCoins activa');
    assert.equal(
      result.campaign.display.banner_text,
      'Esta sede tiene una campaña especial por tiempo limitado.',
    );
    assert.equal(result.campaign.display.reservation_hint, DEFAULT_DISPLAY.reservation_hint);
    assert.equal(result.campaign.display.success_hint, DEFAULT_DISPLAY.success_hint);
    assertNoInternalFields(result.campaign);
  });

  it('no devuelve campaña pausada', async () => {
    const store = buildPlayerCampaignStore({
      campaigns: [
        activeCampaignRow({
          status: PADCOINS_CAMPAIGN_STATUSES.PAUSED,
        }),
      ],
    });

    const result = await getActiveCampaignForSedePlayer(store.supabase, 1, { now: NOW });
    assert.equal(result.active, false);
    assert.equal(result.campaign, null);
  });

  it('no devuelve campaña fuera de fecha', async () => {
    const store = buildPlayerCampaignStore({
      campaigns: [
        activeCampaignRow({
          ...pastRange(),
        }),
      ],
    });

    const result = await getActiveCampaignForSedePlayer(store.supabase, 1, { now: NOW });
    assert.equal(result.active, false);
    assert.equal(result.campaign, null);
  });

  it('respeta sede_id', async () => {
    const store = buildPlayerCampaignStore({
      campaigns: [
        activeCampaignRow({ sede_id: 2 }),
      ],
    });

    const result = await getActiveCampaignForSedePlayer(store.supabase, 1, { now: NOW });
    assert.equal(result.active, false);
    assert.equal(result.campaign, null);
  });

  it('no expone campaña de otra sede aunque esté activa', async () => {
    const store = buildPlayerCampaignStore({
      campaigns: [
        activeCampaignRow({ id: OTHER_CAMPAIGN_ID, sede_id: 2 }),
        activeCampaignRow({ sede_id: 1 }),
      ],
    });

    const result = await getActiveCampaignForSedePlayer(store.supabase, 1, { now: NOW });
    assert.equal(result.active, true);
    assert.equal(result.campaign.sede_id, 1);
    assert.equal(result.campaign.id, CAMPAIGN_ID);
  });

  it('active false si la sede no participa en PadCoins', async () => {
    const store = buildPlayerCampaignStore({
      campaigns: [activeCampaignRow()],
      sedeParticipa: false,
    });

    const result = await getActiveCampaignForSedePlayer(store.supabase, 1, { now: NOW });
    assert.equal(result.active, false);
    assert.equal(result.campaign, null);
  });
});
