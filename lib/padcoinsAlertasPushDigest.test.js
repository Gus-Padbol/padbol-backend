import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  buildPadcoinsAlertasPushPayload,
  buildPadcoinsPushAlertHash,
  filterDedupedPadcoinsPushAlertas,
  filterPadcoinsAlertasForPushDigest,
  getSuperAdminUserIds,
  markPadcoinsPushAlertasAsSent,
  resetPadcoinsPushAlertDigestDedupeForTests,
  resolveSuperAdminPushRecipients,
  sendPadcoinsAlertasPushDigest,
  shouldSendPadcoinsAlertasPushDigest,
} from '../src/padcoins/padcoinsAlertasPushDigestService.js';
import { initPadcoinsAlertasCron } from '../src/cron/padcoinsAlertasCron.js';
import {
  PADCOINS_ALERT_SEVERITIES,
  PADCOINS_ALERT_TYPES,
} from '../src/padcoins/padcoinsAlertsService.js';

const ENV_KEYS = [
  'PADCOINS_ALERTAS_PUSH_ENABLED',
  'PADCOINS_ALERTAS_PUSH_MIN_SEVERITY',
  'PADCOINS_ALERTAS_PUSH_DEDUPE_HOURS',
  'PADCOINS_ALERTAS_PANEL_URL',
  'PADCOINS_ALERTAS_WHATSAPP_ENABLED',
  'PADCOINS_ALERTAS_DIGEST_CRON',
];

const SUPER_ADMIN_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const savedEnv = {};

function saveEnv() {
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
  }
}

function restoreEnv() {
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

function buildAlerta(overrides = {}) {
  return {
    id: '1:ajustes_manuales_excesivos:2026-07-01:2026-07-07',
    tipo_alerta: PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS,
    severidad: PADCOINS_ALERT_SEVERITIES.ALTA,
    sede_id: 1,
    sede_nombre: 'La Meca',
    descripcion: 'Uso anormal detectado.',
    recomendacion: 'Revisar actividad PadCoins de la sede.',
    periodo: { desde: '2026-07-01T00:00:00.000Z', hasta: '2026-07-07T23:59:59.999Z', dias: 7 },
    metricas: { count: 15 },
    movimientos_relacionados: [],
    calculado_en: '2026-07-07T12:00:00.000Z',
    ...overrides,
  };
}

beforeEach(() => {
  saveEnv();
  resetPadcoinsPushAlertDigestDedupeForTests();
});

afterEach(() => {
  restoreEnv();
  resetPadcoinsPushAlertDigestDedupeForTests();
});

describe('padcoinsAlertasPushDigestService — habilitación', () => {
  it('no envía si push disabled', async () => {
    process.env.PADCOINS_ALERTAS_PUSH_ENABLED = 'false';

    const pushCalls = [];
    const result = await sendPadcoinsAlertasPushDigest({
      supabaseAdmin: {},
      sendPushFn: async () => { pushCalls.push(true); },
      fetchAlertasFn: async () => [buildAlerta()],
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'push_disabled');
    assert.equal(pushCalls.length, 0);
    assert.equal(shouldSendPadcoinsAlertasPushDigest(), false);
  });
});

describe('padcoinsAlertasPushDigestService — destinatarios', () => {
  it('no envía si no hay super admins', async () => {
    process.env.PADCOINS_ALERTAS_PUSH_ENABLED = 'true';

    const result = await sendPadcoinsAlertasPushDigest({
      supabaseAdmin: {
        from(table) {
          if (table === 'user_roles') {
            return {
              select() { return this; },
              eq() { return Promise.resolve({ data: [], error: null }); },
            };
          }
          return {
            select() { return this; },
            in() { return Promise.resolve({ data: [], error: null }); },
          };
        },
      },
      fetchAlertasFn: async () => [buildAlerta()],
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_super_admins');
  });

  it('no envía si no hay tokens', async () => {
    process.env.PADCOINS_ALERTAS_PUSH_ENABLED = 'true';

    const result = await sendPadcoinsAlertasPushDigest({
      supabaseAdmin: {
        from(table) {
          if (table === 'user_roles') {
            return {
              select() { return this; },
              eq() { return Promise.resolve({
                data: [{ user_id: SUPER_ADMIN_ID, email: 'admin@padbol.com', role: 'super_admin' }],
                error: null,
              }); },
            };
          }
          return {
            select() { return this; },
            in() { return Promise.resolve({ data: [], error: null }); },
          };
        },
      },
      resolveTokensFn: async () => [],
      fetchAlertasFn: async () => [buildAlerta()],
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_push_tokens');
  });

  it('getSuperAdminUserIds combina user_roles y legacy emails', async () => {
    const ids = await getSuperAdminUserIds({
      from(table) {
        if (table === 'user_roles') {
          return {
            select() { return this; },
            eq() { return Promise.resolve({
              data: [{ user_id: SUPER_ADMIN_ID, role: 'super_admin' }],
              error: null,
            }); },
          };
        }
        if (table === 'jugadores_perfil') {
          return {
            select() { return this; },
            in() { return Promise.resolve({
              data: [{ user_id: 'bbbbbbbb-cccc-dddd-eeee-ffffffffffff', email: 'legacy@padbol.com' }],
              error: null,
            }); },
          };
        }
        return {};
      },
    }, { legacySuperAdminEmails: ['legacy@padbol.com'] });

    assert.deepEqual(ids.sort(), [
      SUPER_ADMIN_ID,
      'bbbbbbbb-cccc-dddd-eeee-ffffffffffff',
    ].sort());
  });

  it('resolveSuperAdminPushRecipients agrupa tokens por user', async () => {
    const rows = await resolveSuperAdminPushRecipients({}, [SUPER_ADMIN_ID], {
      resolveTokensFn: async () => ['ExponentPushToken[abc]'],
    });

    assert.equal(rows.length, 1);
    assert.equal(rows[0].user_id, SUPER_ADMIN_ID);
    assert.deepEqual(rows[0].tokens, ['ExponentPushToken[abc]']);
  });
});

describe('padcoinsAlertasPushDigestService — filtrado', () => {
  it('filtra baja/media y envía solo alta', () => {
    const alertas = [
      buildAlerta({ severidad: PADCOINS_ALERT_SEVERITIES.ALTA }),
      buildAlerta({
        tipo_alerta: PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS,
        severidad: PADCOINS_ALERT_SEVERITIES.MEDIA,
        sede_id: 2,
      }),
      buildAlerta({
        tipo_alerta: PADCOINS_ALERT_TYPES.CAMPANIA_IDENTIFICADA,
        severidad: PADCOINS_ALERT_SEVERITIES.BAJA,
        sede_id: 3,
      }),
    ];

    const filtered = filterPadcoinsAlertasForPushDigest(alertas);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].severidad, PADCOINS_ALERT_SEVERITIES.ALTA);
  });

  it('no envía si no hay alertas altas', async () => {
    process.env.PADCOINS_ALERTAS_PUSH_ENABLED = 'true';

    const pushCalls = [];
    const result = await sendPadcoinsAlertasPushDigest({
      supabaseAdmin: {},
      sendPushFn: async () => { pushCalls.push(true); },
      fetchAlertasFn: async () => [buildAlerta({ severidad: PADCOINS_ALERT_SEVERITIES.MEDIA })],
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_alerts');
    assert.equal(pushCalls.length, 0);
  });
});

describe('padcoinsAlertasPushDigestService — payload', () => {
  it('payload correcto para múltiples alertas', () => {
    const payload = buildPadcoinsAlertasPushPayload(
      [buildAlerta(), buildAlerta({ sede_id: 2, tipo_alerta: PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS })],
      {
        panelUrl: 'https://panel.test/alertas',
        totalCount: 3,
      },
    );

    assert.equal(payload.title, 'PadCoins: alerta crítica');
    assert.match(payload.body, /3 alertas críticas detectadas en Beneficios Padbol/);
    assert.equal(payload.data.type, 'padcoins_alertas');
    assert.equal(payload.data.severity, 'alta');
    assert.equal(payload.data.screen, 'admin_padcoins_alertas');
    assert.equal(payload.data.url, 'https://panel.test/alertas');
    assert.equal(payload.data.alert_count, '3');
    assert.doesNotMatch(payload.body, /dinero|cashback|fraude/i);
  });

  it('payload singular para una alerta', () => {
    const payload = buildPadcoinsAlertasPushPayload([buildAlerta()], { totalCount: 1 });
    assert.match(payload.body, /1 alerta crítica detectada/);
    assert.equal(payload.data.alert_count, '1');
  });
});

describe('padcoinsAlertasPushDigestService — dedupe', () => {
  it('dedupe evita reenvío', () => {
    const alerta = buildAlerta();
    assert.equal(buildPadcoinsPushAlertHash(alerta), '1:ajustes_manuales_excesivos');

    markPadcoinsPushAlertasAsSent([alerta], Date.now());
    const pending = filterDedupedPadcoinsPushAlertas([alerta], Date.now());
    assert.equal(pending.length, 0);
  });
});

describe('padcoinsAlertasPushDigestService — envío', () => {
  it('envía push a super admins con tokens', async () => {
    process.env.PADCOINS_ALERTAS_PUSH_ENABLED = 'true';

    const pushCalls = [];
    const result = await sendPadcoinsAlertasPushDigest({
      supabaseAdmin: {
        from(table) {
          if (table === 'user_roles') {
            return {
              select() { return this; },
              eq() { return Promise.resolve({
                data: [{ user_id: SUPER_ADMIN_ID, role: 'super_admin' }],
                error: null,
              }); },
            };
          }
          return {
            select() { return this; },
            in() { return Promise.resolve({ data: [], error: null }); },
          };
        },
      },
      resolveTokensFn: async () => ['ExponentPushToken[abc]'],
      sendPushFn: async (_admin, userIds, payload) => {
        pushCalls.push({ userIds, payload });
      },
      fetchAlertasFn: async () => [buildAlerta()],
    });

    assert.equal(result.sent, true);
    assert.equal(result.alertas, 1);
    assert.equal(pushCalls.length, 1);
    assert.deepEqual(pushCalls[0].userIds, [SUPER_ADMIN_ID]);
    assert.equal(pushCalls[0].payload.title, 'PadCoins: alerta crítica');
  });

  it('error push no rompe', async () => {
    process.env.PADCOINS_ALERTAS_PUSH_ENABLED = 'true';

    const result = await sendPadcoinsAlertasPushDigest({
      supabaseAdmin: {
        from(table) {
          if (table === 'user_roles') {
            return {
              select() { return this; },
              eq() { return Promise.resolve({
                data: [{ user_id: SUPER_ADMIN_ID, role: 'super_admin' }],
                error: null,
              }); },
            };
          }
          return {
            select() { return this; },
            in() { return Promise.resolve({ data: [], error: null }); },
          };
        },
      },
      resolveTokensFn: async () => ['ExponentPushToken[abc]'],
      sendPushFn: async () => { throw new Error('Expo down'); },
      fetchAlertasFn: async () => [buildAlerta()],
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /Expo down/);
  });
});

describe('padcoinsAlertasCron — push', () => {
  it('cron inicializa sin variables', () => {
    delete process.env.PADCOINS_ALERTAS_PUSH_ENABLED;
    delete process.env.PADCOINS_ALERTAS_WHATSAPP_ENABLED;

    const schedules = [];
    const mockCron = {
      schedule(expression, handler, options) {
        schedules.push({ expression, handler, options });
      },
    };

    assert.doesNotThrow(() => {
      initPadcoinsAlertasCron({ supabaseAdmin: {}, cron: mockCron });
    });

    assert.equal(schedules.length, 1);
    assert.equal(schedules[0].expression, '0 */12 * * *');
  });
});
