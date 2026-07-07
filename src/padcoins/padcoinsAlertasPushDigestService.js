import {
  evaluarAlertasPadcoinsGlobal,
  PADCOINS_ALERT_SEVERITIES,
  PADCOINS_ALERT_TYPES,
} from './padcoinsAlertsService.js';
import { filterPadcoinsAlertasForDigest, getPadcoinsAlertasPanelUrl } from './padcoinsAlertasDigestService.js';
import { resolveUserPushTokens, sendPushToUsers } from '../../utils/push.js';

const DEFAULT_PUSH_DEDUPE_HOURS = 24;
const DEFAULT_MIN_SEVERITY = PADCOINS_ALERT_SEVERITIES.ALTA;
const MAX_ALERTS_IN_SUMMARY = 5;

/** @type {Map<string, number>} hash → sentAt epoch ms */
const sentPushAlertHashes = new Map();

function parseTruthyEnv(value) {
  const raw = String(value ?? '').trim().toLowerCase();
  return raw === 'true' || raw === '1' || raw === 'yes';
}

function parsePositiveNumberEnv(value, fallback) {
  const parsed = Number.parseFloat(String(value ?? '').trim());
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function isPadcoinsAlertasPushEnabled() {
  return parseTruthyEnv(process.env.PADCOINS_ALERTAS_PUSH_ENABLED);
}

export function getPadcoinsAlertasPushMinSeverity() {
  const raw = String(process.env.PADCOINS_ALERTAS_PUSH_MIN_SEVERITY ?? '').trim().toLowerCase();
  return raw || DEFAULT_MIN_SEVERITY;
}

export function getPadcoinsAlertasPushDedupeHours() {
  return parsePositiveNumberEnv(process.env.PADCOINS_ALERTAS_PUSH_DEDUPE_HOURS, DEFAULT_PUSH_DEDUPE_HOURS);
}

export function shouldSendPadcoinsAlertasPushDigest() {
  return isPadcoinsAlertasPushEnabled();
}

export function buildPadcoinsPushAlertHash(alerta) {
  const sedeId = alerta?.sede_id ?? 'unknown';
  const tipo = alerta?.tipo_alerta ?? 'unknown';
  return `${sedeId}:${tipo}`;
}

export function filterPadcoinsAlertasForPushDigest(alertas = []) {
  const minSeverity = getPadcoinsAlertasPushMinSeverity();
  return filterPadcoinsAlertasForDigest(alertas).filter(
    (alerta) => alerta.severidad === minSeverity,
  );
}

export function buildPadcoinsAlertasPushPayload(alertas, options = {}) {
  const count = options.totalCount ?? (alertas ?? []).length;
  const panelUrl = options.panelUrl ?? getPadcoinsAlertasPanelUrl();
  const minSeverity = getPadcoinsAlertasPushMinSeverity();

  const body = count === 1
    ? '1 alerta crítica detectada en Beneficios Padbol. Revisá el panel Super Admin.'
    : `${count} alertas críticas detectadas en Beneficios Padbol. Revisá el panel Super Admin.`;

  const listed = (alertas ?? []).slice(0, MAX_ALERTS_IN_SUMMARY);

  return {
    title: 'PadCoins: alerta crítica',
    body,
    data: {
      type: 'padcoins_alertas',
      severity: minSeverity,
      screen: 'admin_padcoins_alertas',
      url: panelUrl,
      alert_count: String(count),
      alert_types: listed.map((alerta) => alerta.tipo_alerta).join(','),
    },
  };
}

export function pruneExpiredPadcoinsPushDedupeEntries(now = Date.now()) {
  const maxAgeMs = getPadcoinsAlertasPushDedupeHours() * 60 * 60 * 1000;

  for (const [hash, sentAt] of sentPushAlertHashes.entries()) {
    if (now - sentAt > maxAgeMs) {
      sentPushAlertHashes.delete(hash);
    }
  }
}

export function wasPadcoinsPushAlertRecentlySent(hash, now = Date.now()) {
  pruneExpiredPadcoinsPushDedupeEntries(now);
  const sentAt = sentPushAlertHashes.get(hash);
  if (sentAt == null) return false;

  const maxAgeMs = getPadcoinsAlertasPushDedupeHours() * 60 * 60 * 1000;
  return now - sentAt <= maxAgeMs;
}

export function filterDedupedPadcoinsPushAlertas(alertas, now = Date.now()) {
  return (alertas ?? []).filter(
    (alerta) => !wasPadcoinsPushAlertRecentlySent(buildPadcoinsPushAlertHash(alerta), now),
  );
}

export function markPadcoinsPushAlertasAsSent(alertas, now = Date.now()) {
  for (const alerta of alertas ?? []) {
    sentPushAlertHashes.set(buildPadcoinsPushAlertHash(alerta), now);
  }
}

export function resetPadcoinsPushAlertDigestDedupeForTests() {
  sentPushAlertHashes.clear();
}

export async function getSuperAdminUserIds(supabaseAdmin, { legacySuperAdminEmails = [] } = {}) {
  if (!supabaseAdmin) return [];

  const ids = new Set();

  const { data: roleRows, error: roleErr } = await supabaseAdmin
    .from('user_roles')
    .select('user_id, email, role')
    .eq('role', 'super_admin');

  if (roleErr) throw roleErr;

  for (const row of roleRows ?? []) {
    if (row?.user_id) ids.add(String(row.user_id));
  }

  const legacyEmails = (legacySuperAdminEmails ?? [])
    .map((email) => String(email ?? '').trim().toLowerCase())
    .filter(Boolean);

  if (legacyEmails.length) {
    const { data: perfilRows, error: perfilErr } = await supabaseAdmin
      .from('jugadores_perfil')
      .select('user_id, email')
      .in('email', legacyEmails);

    if (perfilErr) throw perfilErr;

    for (const row of perfilRows ?? []) {
      if (row?.user_id) ids.add(String(row.user_id));
    }
  }

  return [...ids];
}

export async function resolveSuperAdminPushRecipients(supabaseAdmin, userIds, {
  resolveTokensFn = resolveUserPushTokens,
} = {}) {
  const recipients = [];

  await Promise.all(
    (userIds ?? []).map(async (userId) => {
      const tokens = await resolveTokensFn(supabaseAdmin, userId);
      recipients.push({
        user_id: userId,
        tokens,
      });
    }),
  );

  return recipients;
}

export async function sendPadcoinsAlertasPushDigest(options = {}) {
  const {
    supabaseAdmin,
    sendPushFn = sendPushToUsers,
    legacySuperAdminEmails = [],
    now,
  } = options;

  if (!shouldSendPadcoinsAlertasPushDigest()) {
    return { ok: true, skipped: true, reason: 'push_disabled' };
  }

  if (!supabaseAdmin) {
    return { ok: true, skipped: true, reason: 'missing_supabase' };
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
    console.warn('⚠️ PadCoins alertas push digest — evaluación falló:', err.message);
    return { ok: false, error: err.message };
  }

  const alta = filterPadcoinsAlertasForPushDigest(alertasRaw);
  const pending = filterDedupedPadcoinsPushAlertas(alta, nowMs);

  if (!pending.length) {
    return { ok: true, skipped: true, reason: 'no_alerts' };
  }

  let userIds = [];
  try {
    userIds = await getSuperAdminUserIds(supabaseAdmin, { legacySuperAdminEmails });
  } catch (err) {
    console.warn('⚠️ PadCoins alertas push digest — super admins no resueltos:', err.message);
    return { ok: false, error: err.message };
  }

  if (!userIds.length) {
    console.log('⚠️ PadCoins alertas push digest — sin Super Admin destinatario');
    return { ok: true, skipped: true, reason: 'no_super_admins' };
  }

  const recipients = await resolveSuperAdminPushRecipients(supabaseAdmin, userIds, {
    resolveTokensFn: options.resolveTokensFn,
  });

  const tokenCount = recipients.reduce((sum, row) => sum + row.tokens.length, 0);
  if (!tokenCount) {
    console.log('⚠️ PadCoins alertas push digest — sin tokens push Super Admin');
    return { ok: true, skipped: true, reason: 'no_push_tokens' };
  }

  const payload = buildPadcoinsAlertasPushPayload(
    pending.slice(0, MAX_ALERTS_IN_SUMMARY),
    {
      panelUrl: getPadcoinsAlertasPanelUrl(),
      totalCount: pending.length,
    },
  );

  try {
    await sendPushFn(supabaseAdmin, userIds, payload);

    markPadcoinsPushAlertasAsSent(pending, nowMs);

    console.log(
      `✓ PadCoins alertas push digest — ${pending.length} alerta(s) a ${userIds.length} Super Admin(s) (${tokenCount} token(s))`,
    );

    return {
      ok: true,
      sent: true,
      alertas: pending.length,
      super_admins: userIds.length,
      tokens: tokenCount,
    };
  } catch (err) {
    console.warn('⚠️ PadCoins alertas push digest — envío falló:', err.message);
    return { ok: false, error: err.message };
  }
}
