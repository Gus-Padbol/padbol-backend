import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';
import {
  buildPadcoinsAlertasDigestMessage,
  buildPadcoinsAlertHash,
  filterDedupedPadcoinsAlertas,
  filterPadcoinsAlertasForDigest,
  getPadcoinsAlertasDigestRecipients,
  markPadcoinsAlertasAsSent,
  resetPadcoinsAlertDigestDedupeForTests,
  sendPadcoinsAlertasWhatsAppDigest,
  shouldSendPadcoinsAlertDigest,
} from '../src/padcoins/padcoinsAlertasDigestService.js';
import { initPadcoinsAlertasCron } from '../src/cron/padcoinsAlertasCron.js';
import {
  PADCOINS_ALERT_SEVERITIES,
  PADCOINS_ALERT_TYPES,
} from '../src/padcoins/padcoinsAlertsService.js';

const ENV_KEYS = [
  'PADCOINS_ALERTAS_WHATSAPP_ENABLED',
  'PADCOINS_ALERTAS_WHATSAPP_TO',
  'PADCOINS_ALERTAS_DIGEST_CRON',
  'PADCOINS_ALERTAS_PANEL_URL',
  'PADCOINS_ALERTAS_DEDUPE_HOURS',
];

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
    descripcion: 'Detectados 15 ajustes positivos sin marcador de campaña.',
    recomendacion: 'Revisar ajustes admin de la sede. No bloquea automáticamente.',
    periodo: { desde: '2026-07-01T00:00:00.000Z', hasta: '2026-07-07T23:59:59.999Z', dias: 7 },
    metricas: { count: 15 },
    movimientos_relacionados: [],
    calculado_en: '2026-07-07T12:00:00.000Z',
    ...overrides,
  };
}

function buildSupabaseMock(alertas = []) {
  return {
    from() {
      return this;
    },
    select() {
      return this;
    },
    not() {
      return this;
    },
    gte() {
      return this;
    },
    lte() {
      return this;
    },
    in() {
      return this;
    },
    eq() {
      return this;
    },
    then(resolve) {
      return Promise.resolve({ data: [], error: null }).then(resolve);
    },
    async fetchMovimientos() {
      return { data: [], error: null };
    },
  };
}

beforeEach(() => {
  saveEnv();
  resetPadcoinsAlertDigestDedupeForTests();
});

afterEach(() => {
  restoreEnv();
  resetPadcoinsAlertDigestDedupeForTests();
});

describe('padcoinsAlertasDigestService — habilitación', () => {
  it('no envía si enabled=false', async () => {
    process.env.PADCOINS_ALERTAS_WHATSAPP_ENABLED = 'false';
    process.env.PADCOINS_ALERTAS_WHATSAPP_TO = 'whatsapp:+5491111111111';

    const sendCalls = [];
    const result = await sendPadcoinsAlertasWhatsAppDigest({
      supabaseAdmin: {},
      sendWhatsAppMessage: async (payload) => { sendCalls.push(payload); },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'disabled_or_no_recipients');
    assert.equal(sendCalls.length, 0);
    assert.equal(shouldSendPadcoinsAlertDigest(), false);
  });

  it('no envía si no hay destinatario', async () => {
    process.env.PADCOINS_ALERTAS_WHATSAPP_ENABLED = 'true';
    delete process.env.PADCOINS_ALERTAS_WHATSAPP_TO;

    const sendCalls = [];
    const result = await sendPadcoinsAlertasWhatsAppDigest({
      supabaseAdmin: {},
      sendWhatsAppMessage: async (payload) => { sendCalls.push(payload); },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'disabled_or_no_recipients');
    assert.equal(getPadcoinsAlertasDigestRecipients().length, 0);
    assert.equal(sendCalls.length, 0);
  });
});

describe('padcoinsAlertasDigestService — filtrado', () => {
  it('filtra baja/media y excluye campania_identificada', () => {
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

    const filtered = filterPadcoinsAlertasForDigest(alertas);
    assert.equal(filtered.length, 1);
    assert.equal(filtered[0].tipo_alerta, PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS);
  });

  it('no envía si no hay alertas altas', async () => {
    process.env.PADCOINS_ALERTAS_WHATSAPP_ENABLED = 'true';
    process.env.PADCOINS_ALERTAS_WHATSAPP_TO = 'whatsapp:+5491111111111';

    const sendCalls = [];
    const result = await sendPadcoinsAlertasWhatsAppDigest({
      supabaseAdmin: {
        from(table) {
          if (table === 'padcoins_movimientos' || table === 'padcoins_canjes') {
            return {
              select() { return this; },
              not() { return this; },
              gte() { return this; },
              lte() { return Promise.resolve({ data: [], error: null }); },
            };
          }
          if (table === 'sedes') {
            return {
              select() { return this; },
              in() { return Promise.resolve({ data: [], error: null }); },
            };
          }
          return buildSupabaseMock();
        },
      },
      sendWhatsAppMessage: async (payload) => { sendCalls.push(payload); },
    });

    assert.equal(result.skipped, true);
    assert.equal(result.reason, 'no_alerts');
    assert.equal(sendCalls.length, 0);
  });
});

describe('padcoinsAlertasDigestService — mensaje', () => {
  it('arma mensaje compacto con máximo 5 alertas', () => {
    const alertas = Array.from({ length: 8 }, (_, i) => buildAlerta({
      sede_id: i + 1,
      sede_nombre: `Sede ${i + 1}`,
      tipo_alerta: i % 2 === 0
        ? PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS
        : PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS,
    }));

    const message = buildPadcoinsAlertasDigestMessage(alertas.slice(0, 5), {
      panelUrl: 'https://panel.test/alertas',
      totalCount: alertas.length,
    });

    assert.match(message, /^Padbol Match — Alertas PadCoins/);
    assert.match(message, /8 alertas críticas detectadas/);
    assert.match(message, /1\) Sede 1 — Ajustes manuales excesivos/);
    assert.match(message, /5\) Sede 5 — Ajustes manuales excesivos/);
    assert.doesNotMatch(message, /6\) Sede 6/);
    assert.match(message, /\+3 alerta\(s\) más en el panel\./);
    assert.match(message, /Ver panel: https:\/\/panel\.test\/alertas/);
    assert.doesNotMatch(message, /"tipo_alerta"/);
    assert.doesNotMatch(message, /fraude/i);
  });

  it('usa lenguaje de revisión, no acusatorio', () => {
    const message = buildPadcoinsAlertasDigestMessage([buildAlerta()]);
    assert.match(message, /Motivo:/);
    assert.match(message, /Recomendación:/);
    assert.doesNotMatch(message, /fraude|estafa|robo/i);
  });
});

describe('padcoinsAlertasDigestService — dedupe', () => {
  it('dedupe evita reenviar misma alerta', () => {
    const alerta = buildAlerta();
    const hash = buildPadcoinsAlertHash(alerta);
    assert.equal(hash, '1:ajustes_manuales_excesivos');

    markPadcoinsAlertasAsSent([alerta], Date.now());

    const pending = filterDedupedPadcoinsAlertas([alerta], Date.now());
    assert.equal(pending.length, 0);
  });

  it('permite reenvío tras expirar ventana dedupe', () => {
    process.env.PADCOINS_ALERTAS_DEDUPE_HOURS = '1';
    const alerta = buildAlerta();
    const sentAt = Date.now() - (2 * 60 * 60 * 1000);

    markPadcoinsAlertasAsSent([alerta], sentAt);

    const pending = filterDedupedPadcoinsAlertas([alerta], Date.now());
    assert.equal(pending.length, 1);
  });
});

describe('padcoinsAlertasDigestService — envío', () => {
  it('error Twilio no rompe y retorna ok:false', async () => {
    process.env.PADCOINS_ALERTAS_WHATSAPP_ENABLED = 'true';
    process.env.PADCOINS_ALERTAS_WHATSAPP_TO = 'whatsapp:+5491111111111';

    const alta = buildAlerta();

    const result = await sendPadcoinsAlertasWhatsAppDigest({
      supabaseAdmin: {},
      sendWhatsAppMessage: async () => {
        throw new Error('Twilio unavailable');
      },
      fetchAlertasFn: async () => [alta],
    });

    assert.equal(result.ok, false);
    assert.match(result.error, /Twilio unavailable/);
  });
});

describe('padcoinsAlertasCron — inicialización', () => {
  it('cron se puede inicializar sin variables', () => {
    delete process.env.PADCOINS_ALERTAS_WHATSAPP_ENABLED;
    delete process.env.PADCOINS_ALERTAS_WHATSAPP_TO;

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
    assert.equal(typeof schedules[0].handler, 'function');
  });
});
