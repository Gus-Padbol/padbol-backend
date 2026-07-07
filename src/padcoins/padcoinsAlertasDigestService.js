import {
  evaluarAlertasPadcoinsGlobal,
  PADCOINS_ALERT_SEVERITIES,
  PADCOINS_ALERT_TYPES,
} from './padcoinsAlertsService.js';

const DEFAULT_DIGEST_CRON = '0 */12 * * *';
const DEFAULT_DEDUPE_HOURS = 24;
const MAX_ALERTS_IN_MESSAGE = 5;
const MAX_LINE_LENGTH = 140;

const TIPO_ALERTA_LABELS = {
  [PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS]: 'Ajustes manuales excesivos',
  [PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS]: 'Canjes sospechosos',
  [PADCOINS_ALERT_TYPES.RESERVAS_PADCOINS_POCO_CREIBLE]: 'Reservas / PadCoins poco creíble',
  [PADCOINS_ALERT_TYPES.PENALIZACIONES_REVERSAS_ANORMALES]: 'Penalizaciones / reversas anormales',
  [PADCOINS_ALERT_TYPES.CAMPANIA_IDENTIFICADA]: 'Campaña identificada',
};

/** @type {Map<string, number>} hash → sentAt epoch ms */
const sentAlertHashes = new Map();

function parseTruthyEnv(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function parsePositiveNumberEnv(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isPadcoinsAlertasWhatsAppEnabled() {
  return parseTruthyEnv(process.env.PADCOINS_ALERTAS_WHATSAPP_ENABLED);
}

export function getPadcoinsAlertasDigestCronExpression() {
  const raw = String(process.env.PADCOINS_ALERTAS_DIGEST_CRON ?? '').trim();
  return raw || DEFAULT_DIGEST_CRON;
}

export function getPadcoinsAlertasDedupeHours() {
  return parsePositiveNumberEnv(process.env.PADCOINS_ALERTAS_DEDUPE_HOURS, DEFAULT_DEDUPE_HOURS);
}

export function getPadcoinsAlertasPanelUrl() {
  const raw = String(process.env.PADCOINS_ALERTAS_PANEL_URL ?? '').trim();
  return raw || 'https://padbolmatch.com/admin/padcoins/alertas';
}

export function normalizeWhatsAppRecipient(value) {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return null;
  if (trimmed.startsWith('whatsapp:')) return trimmed;

  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return null;
  return `whatsapp:+${digits}`;
}

export function getPadcoinsAlertasDigestRecipients() {
  const raw = String(process.env.PADCOINS_ALERTAS_WHATSAPP_TO ?? '').trim();
  if (!raw) return [];

  return raw
    .split(',')
    .map((part) => normalizeWhatsAppRecipient(part))
    .filter(Boolean);
}

export function shouldSendPadcoinsAlertDigest() {
  return isPadcoinsAlertasWhatsAppEnabled() && getPadcoinsAlertasDigestRecipients().length > 0;
}

export function buildPadcoinsAlertHash(alerta) {
  const sedeId = alerta?.sede_id ?? 'unknown';
  const tipo = alerta?.tipo_alerta ?? 'unknown';
  return `${sedeId}:${tipo}`;
}

export function filterPadcoinsAlertasForDigest(alertas = []) {
  return (alertas ?? []).filter((alerta) => {
    if (alerta.severidad !== PADCOINS_ALERT_SEVERITIES.ALTA) return false;

    if (alerta.tipo_alerta === PADCOINS_ALERT_TYPES.CAMPANIA_IDENTIFICADA) {
      return alerta.requiere_revision === true;
    }

    return true;
  });
}

function truncateText(text, max = MAX_LINE_LENGTH) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max - 1)}…`;
}

function labelForTipoAlerta(tipoAlerta) {
  return TIPO_ALERTA_LABELS[tipoAlerta] ?? 'Actividad poco habitual';
}

export function buildPadcoinsAlertasDigestMessage(alertas, options = {}) {
  const panelUrl = options.panelUrl ?? getPadcoinsAlertasPanelUrl();
  const listed = (alertas ?? []).slice(0, MAX_ALERTS_IN_MESSAGE);
  const totalCount = options.totalCount ?? listed.length;
  const remaining = Math.max(0, totalCount - listed.length);

  const headerCount = totalCount === 1
    ? '1 alerta crítica detectada'
    : `${totalCount} alertas críticas detectadas`;

  const lines = [
    'Padbol Match — Alertas PadCoins',
    headerCount,
  ];

  listed.forEach((alerta, index) => {
    const sede = alerta.sede_nombre ?? `Sede ${alerta.sede_id}`;
    lines.push(`${index + 1}) ${sede} — ${labelForTipoAlerta(alerta.tipo_alerta)}`);
    lines.push(`Motivo: ${truncateText(alerta.descripcion)}`);
    lines.push(`Recomendación: ${truncateText(alerta.recomendacion)}`);
  });

  if (remaining > 0) {
    lines.push(`+${remaining} alerta(s) más en el panel.`);
  }

  lines.push(`Ver panel: ${panelUrl}`);

  return lines.join('\n');
}

export function pruneExpiredPadcoinsAlertDedupeEntries(now = Date.now()) {
  const maxAgeMs = getPadcoinsAlertasDedupeHours() * 60 * 60 * 1000;

  for (const [hash, sentAt] of sentAlertHashes.entries()) {
    if (now - sentAt > maxAgeMs) {
      sentAlertHashes.delete(hash);
    }
  }
}

export function wasPadcoinsAlertRecentlySent(hash, now = Date.now()) {
  pruneExpiredPadcoinsAlertDedupeEntries(now);
  const sentAt = sentAlertHashes.get(hash);
  if (sentAt == null) return false;

  const maxAgeMs = getPadcoinsAlertasDedupeHours() * 60 * 60 * 1000;
  return now - sentAt <= maxAgeMs;
}

export function filterDedupedPadcoinsAlertas(alertas, now = Date.now()) {
  return (alertas ?? []).filter(
    (alerta) => !wasPadcoinsAlertRecentlySent(buildPadcoinsAlertHash(alerta), now),
  );
}

export function markPadcoinsAlertasAsSent(alertas, now = Date.now()) {
  for (const alerta of alertas ?? []) {
    sentAlertHashes.set(buildPadcoinsAlertHash(alerta), now);
  }
}

export function resetPadcoinsAlertDigestDedupeForTests() {
  sentAlertHashes.clear();
}

export async function sendPadcoinsAlertasWhatsAppDigest(options = {}) {
  const {
    supabaseAdmin,
    sendWhatsAppMessage,
    twilioFrom,
    now,
  } = options;

  if (!shouldSendPadcoinsAlertDigest()) {
    return { ok: true, skipped: true, reason: 'disabled_or_no_recipients' };
  }

  if (!supabaseAdmin) {
    return { ok: true, skipped: true, reason: 'missing_supabase' };
  }

  if (typeof sendWhatsAppMessage !== 'function') {
    return { ok: true, skipped: true, reason: 'missing_sender' };
  }

  const nowMs = now != null ? new Date(now).getTime() : Date.now();

  let alertasRaw = [];
  try {
    if (typeof options.fetchAlertasFn === 'function') {
      alertasRaw = await options.fetchAlertasFn();
    } else {
      alertasRaw = await evaluarAlertasPadcoinsGlobal(supabaseAdmin, { now });
    }
  } catch (err) {
    console.warn('⚠️ PadCoins alertas digest — evaluación falló:', err.message);
    return { ok: false, error: err.message };
  }

  const alta = filterPadcoinsAlertasForDigest(alertasRaw);
  const pending = filterDedupedPadcoinsAlertas(alta, nowMs);

  if (!pending.length) {
    return { ok: true, skipped: true, reason: 'no_alerts' };
  }

  const message = buildPadcoinsAlertasDigestMessage(pending.slice(0, MAX_ALERTS_IN_MESSAGE), {
    panelUrl: getPadcoinsAlertasPanelUrl(),
    totalCount: pending.length,
  });

  const recipients = getPadcoinsAlertasDigestRecipients();

  try {
    for (const to of recipients) {
      await sendWhatsAppMessage({
        to,
        body: message,
        from: twilioFrom,
      });
    }

    markPadcoinsAlertasAsSent(pending, nowMs);

    console.log(
      `✓ PadCoins alertas WhatsApp digest — ${pending.length} alerta(s) a ${recipients.length} destinatario(s)`,
    );

    return {
      ok: true,
      sent: true,
      alertas: pending.length,
      recipients: recipients.length,
    };
  } catch (err) {
    console.warn('⚠️ PadCoins alertas WhatsApp digest — envío falló:', err.message);
    return { ok: false, error: err.message };
  }
}
