import { normalizePushLanguage, localizedPushPreview } from './pushLanguages.js';
import { createHash, randomUUID } from 'node:crypto';

export const EXPO_PUSH_SEND_URL = 'https://exp.host/--/api/v2/push/send';
export const EXPO_PUSH_RECEIPTS_URL = 'https://exp.host/--/api/v2/push/getReceipts';

const EXPO_PUSH_BATCH = 100;
const EXPO_RECEIPT_BATCH = 300;
const MAX_TITLE_LENGTH = 50;
const MAX_BODY_LENGTH = 150;
const MAX_DEVICE_ID_LENGTH = 160;
const MAX_IDEMPOTENCY_KEY_LENGTH = 180;
const RECEIPT_RECHECK_MS = 5 * 60 * 1000;
const RECEIPT_MAX_CHECKS = 6;

const PUSH_CATEGORIES = new Set(['transactional', 'marketing']);
const PUSH_TYPES = new Set([
  'admin_message',
  'reserva_confirmada',
  'recordatorio_reserva',
  'reserva_cancelada',
  'reserva_modificada',
  'partido_solicitud',
  'partido_solicitud_aceptada',
  'partido_solicitud_rechazada',
  'partido_completo',
  'invitacion_torneo_dupla',
  'resultado_partido',
  'torneo_inscripcion_confirmada',
  'torneo_nuevo',
  'torneo_fixture',
  'torneo_equipo_completo',
  'ranking_actualizado',
  'general',
]);
const PUSH_ROUTES = new Set([
  'Notificaciones',
  'Reserva',
  'Reservas',
  'PartidoDetalle',
  'TorneoDetalle',
  'Perfil',
]);
const ROUTE_PARAM_KEYS = Object.freeze({
  Notificaciones: new Set(),
  Reserva: new Set(['sedeId', 'deporte']),
  Reservas: new Set(),
  PartidoDetalle: new Set(['partidoId']),
  TorneoDetalle: new Set(['torneoId']),
  Perfil: new Set(),
});
const RETRYABLE_HTTP_STATUS = new Set([408, 429, 500, 502, 503, 504]);

function pushError(message, status = 500, code = 'PUSH_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function cleanString(value, maxLength) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function normalizeScalar(value) {
  if (typeof value === 'string') return value.slice(0, 160);
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'boolean') return value;
  return null;
}

export function isExpoPushToken(value) {
  return /^(?:ExponentPushToken|ExpoPushToken)\[[A-Za-z0-9+/_=-]+\]$/.test(
    String(value ?? '').trim(),
  );
}

export function pushTokenFingerprint(value) {
  return createHash('sha256').update(String(value ?? '')).digest('hex');
}

export function normalizePushPlatform(value) {
  const platform = cleanString(value, 20).toLowerCase();
  return platform === 'ios' || platform === 'android' ? platform : null;
}

export function normalizePushDeviceId(value) {
  const deviceId = cleanString(value, MAX_DEVICE_ID_LENGTH);
  if (deviceId.length < 16 || !/^[A-Za-z0-9._:-]+$/.test(deviceId)) return null;
  return deviceId;
}

export function sanitizePushData(raw = {}) {
  const input = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const type = cleanString(input.type, 80).toLowerCase();
  if (!PUSH_TYPES.has(type)) {
    throw pushError('Tipo de notificación no permitido', 400, 'PUSH_TYPE_INVALID');
  }

  const route = input.route == null ? null : cleanString(input.route, 80);
  if (route && !PUSH_ROUTES.has(route)) {
    throw pushError('Destino de navegación no permitido', 400, 'PUSH_ROUTE_INVALID');
  }

  const allowedParams = route ? ROUTE_PARAM_KEYS[route] : new Set();
  const rawParams = input.params && typeof input.params === 'object' && !Array.isArray(input.params)
    ? input.params
    : {};
  const params = {};
  for (const [key, value] of Object.entries(rawParams)) {
    if (!allowedParams.has(key)) continue;
    const scalar = normalizeScalar(value);
    if (scalar != null) params[key] = scalar;
  }

  if (route === 'PartidoDetalle' && params.partidoId == null) {
    throw pushError('Falta partidoId para el destino solicitado', 400, 'PUSH_ROUTE_PARAMS_INVALID');
  }
  if (route === 'TorneoDetalle' && params.torneoId == null) {
    throw pushError('Falta torneoId para el destino solicitado', 400, 'PUSH_ROUTE_PARAMS_INVALID');
  }
  if (route === 'Reserva' && params.sedeId == null) {
    throw pushError('Falta sedeId para el destino solicitado', 400, 'PUSH_ROUTE_PARAMS_INVALID');
  }

  const notificationId = normalizeScalar(input.notificationId);
  const eventId = normalizeScalar(input.eventId);
  return {
    type,
    route,
    params,
    ...(notificationId != null ? { notificationId } : {}),
    ...(eventId != null ? { eventId } : {}),
  };
}

export function buildPushDataForInboxNotification({ tipo, link, notificationId, pushData } = {}) {
  if (pushData) {
    return sanitizePushData({
      ...pushData,
      type: pushData.type || tipo || 'general',
      notificationId: pushData.notificationId ?? notificationId,
    });
  }

  const type = PUSH_TYPES.has(cleanString(tipo, 80).toLowerCase())
    ? cleanString(tipo, 80).toLowerCase()
    : 'general';
  const normalizedLink = cleanString(link, 500);
  const torneoMatch = normalizedLink.match(/\/torneo\/(\d+)/i);
  let route = 'Notificaciones';
  let params = {};

  if (torneoMatch) {
    route = 'TorneoDetalle';
    params = { torneoId: Number(torneoMatch[1]) };
  } else if (/mi-perfil\?tab=reservas|\/reservas/i.test(normalizedLink)) {
    route = 'Reservas';
  }

  return sanitizePushData({ type, route, params, notificationId });
}

function expoHeaders(accessToken = '') {
  const headers = {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip, deflate',
    'Content-Type': 'application/json',
  };
  const token = cleanString(accessToken, 1000);
  if (token) headers.Authorization = `Bearer ${token}`;
  return headers;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postExpoJsonWithRetry({
  url,
  payload,
  fetchImpl,
  accessToken,
  maxAttempts = 3,
  sleepImpl = delay,
}) {
  let lastError = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(url, {
        method: 'POST',
        headers: expoHeaders(accessToken),
        body: JSON.stringify(payload),
      });
      const json = await response.json().catch(() => ({}));
      if (response.ok) return json;
      const message = json?.errors?.[0]?.message || json?.message || `Expo respondió HTTP ${response.status}`;
      lastError = pushError(message, 502, 'EXPO_HTTP_ERROR');
      if (!RETRYABLE_HTTP_STATUS.has(response.status)) throw lastError;
      if (attempt === maxAttempts) break;
    } catch (error) {
      lastError = error;
      if (error?.code === 'EXPO_HTTP_ERROR') throw error;
      if (attempt === maxAttempts) break;
    }
    await sleepImpl(Math.min(1000, 100 * (2 ** (attempt - 1))));
  }
  throw pushError(lastError?.message || 'No se pudo contactar Expo Push', 502, 'EXPO_TRANSPORT_ERROR');
}

export async function sendExpoPushNotifications({
  title,
  body,
  tokens,
  data,
  fetchImpl = globalThis.fetch,
  accessToken = '',
  maxAttempts = 3,
  sleepImpl = delay,
} = {}) {
  const cleanTitle = cleanString(title, MAX_TITLE_LENGTH);
  const cleanBody = cleanString(body, MAX_BODY_LENGTH);
  if (!cleanTitle || !cleanBody) {
    throw pushError('Título y mensaje son obligatorios', 400, 'PUSH_CONTENT_INVALID');
  }
  if (typeof fetchImpl !== 'function') {
    throw pushError('El transporte de Expo Push no está disponible', 503, 'PUSH_TRANSPORT_NOT_CONFIGURED');
  }
  const payloadData = sanitizePushData(data);
  const rows = (tokens || []).map((entry) => (
    typeof entry === 'string' ? { token: entry } : entry
  ));
  const validRows = rows.filter((row) => isExpoPushToken(row?.token));
  if (!validRows.length) return { sent: 0, accepted: 0, failed: 0, results: [] };

  const results = [];
  for (let index = 0; index < validRows.length; index += EXPO_PUSH_BATCH) {
    const chunk = validRows.slice(index, index + EXPO_PUSH_BATCH);
    const messages = chunk.map((row) => ({
      to: row.token,
      title: cleanString(row.title || cleanTitle, MAX_TITLE_LENGTH),
      body: cleanString(row.body || cleanBody, MAX_BODY_LENGTH),
      sound: 'default',
      data: payloadData,
    }));
    const json = await postExpoJsonWithRetry({
      url: EXPO_PUSH_SEND_URL,
      payload: messages,
      fetchImpl,
      accessToken,
      maxAttempts,
      sleepImpl,
    });
    const ticketRows = Array.isArray(json?.data) ? json.data : [json?.data].filter(Boolean);
    chunk.forEach((row, offset) => {
      const ticket = ticketRows[offset] || { status: 'error', message: 'Expo no devolvió ticket' };
      results.push({
        ...row,
        ticket,
        ok: ticket.status === 'ok' && Boolean(ticket.id),
        errorCode: ticket?.details?.error || null,
        errorMessage: ticket.status === 'error' ? cleanString(ticket.message, 500) : null,
      });
    });
  }
  const accepted = results.filter((row) => row.ok).length;
  return {
    sent: results.length,
    accepted,
    failed: results.length - accepted,
    results,
  };
}

function rpcRow(data) {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

function isUniqueViolation(error) {
  return String(error?.code || '') === '23505' || /duplicate|unique/i.test(String(error?.message || ''));
}

function requireServiceRole(serviceRoleConfigured, supabaseAdmin) {
  if (!serviceRoleConfigured || !supabaseAdmin) {
    throw pushError(
      'El servicio de notificaciones push no está configurado',
      503,
      'PUSH_SERVICE_ROLE_REQUIRED',
    );
  }
}

export function createMobilePushService({
  supabaseAdmin,
  serviceRoleConfigured,
  expoAccessToken = '',
  sendEnabled = true,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  uuid = randomUUID,
  logger = console,
  sleepImpl = delay,
} = {}) {
  function assertConfigured() {
    requireServiceRole(serviceRoleConfigured, supabaseAdmin);
  }

  async function registerToken({ userId, token, platform, deviceId, language }) {
    assertConfigured();
    const uid = cleanString(userId, 80);
    const normalizedLanguage = normalizePushLanguage(language);
    const normalizedPlatform = normalizePushPlatform(platform);
    const normalizedDeviceId = normalizePushDeviceId(deviceId);
    const normalizedToken = cleanString(token, 500);
    if (!uid || !isExpoPushToken(normalizedToken) || !normalizedPlatform || !normalizedDeviceId || !normalizedLanguage) {
      throw pushError('Registro push inválido', 400, 'PUSH_REGISTRATION_INVALID');
    }
    const { data, error } = await supabaseAdmin.rpc('register_mobile_push_token_v2', {
      p_language: normalizedLanguage,
      p_user_id: uid,
      p_token: normalizedToken,
      p_platform: normalizedPlatform,
      p_device_id: normalizedDeviceId,
    });
    if (error) throw pushError('No se pudo registrar este dispositivo', 503, 'PUSH_STORAGE_UNAVAILABLE');
    const row = rpcRow(data);
    return {
      ok: true,
      deviceId: normalizedDeviceId,
      platform: normalizedPlatform,
      language: normalizedLanguage,
      registeredAt: row?.last_seen_at || now().toISOString(),
    };
  }

  async function revokeToken({ userId, token = null, deviceId = null }) {
    assertConfigured();
    const uid = cleanString(userId, 80);
    const normalizedToken = token == null ? null : cleanString(token, 500);
    const normalizedDeviceId = deviceId == null ? null : normalizePushDeviceId(deviceId);
    if (!uid || (!normalizedToken && !normalizedDeviceId)) {
      throw pushError('Indica el token o dispositivo a revocar', 400, 'PUSH_REVOCATION_INVALID');
    }
    if (normalizedToken && !isExpoPushToken(normalizedToken)) {
      throw pushError('Token push inválido', 400, 'PUSH_REVOCATION_INVALID');
    }
    if (deviceId != null && !normalizedDeviceId) {
      throw pushError('Dispositivo push inválido', 400, 'PUSH_REVOCATION_INVALID');
    }
    const { data, error } = await supabaseAdmin.rpc('revoke_mobile_push_token', {
      p_user_id: uid,
      p_token: normalizedToken,
      p_device_id: normalizedDeviceId,
    });
    if (error) throw pushError('No se pudo revocar este dispositivo', 503, 'PUSH_STORAGE_UNAVAILABLE');
    return { ok: true, revoked: Number(data || 0) };
  }

  async function getPreferences(userId) {
    assertConfigured();
    const uid = cleanString(userId, 80);
    const { data, error } = await supabaseAdmin
      .from('push_notification_preferences')
      .select('transactional_enabled, marketing_enabled, updated_at')
      .eq('user_id', uid)
      .maybeSingle();
    if (error) throw pushError('No se pudieron cargar las preferencias push', 503, 'PUSH_STORAGE_UNAVAILABLE');
    return {
      transactionalEnabled: data?.transactional_enabled !== false,
      marketingEnabled: data?.marketing_enabled === true,
      updatedAt: data?.updated_at || null,
    };
  }

  async function updatePreferences(userId, patch = {}) {
    assertConfigured();
    const hasTransactional = typeof patch.transactionalEnabled === 'boolean';
    const hasMarketing = typeof patch.marketingEnabled === 'boolean';
    if (!hasTransactional && !hasMarketing) {
      throw pushError('Indica al menos una preferencia push', 400, 'PUSH_PREFERENCES_INVALID');
    }
    const current = await getPreferences(userId);
    const transactionalEnabled = hasTransactional
      ? patch.transactionalEnabled
      : current.transactionalEnabled;
    const marketingEnabled = hasMarketing ? patch.marketingEnabled : current.marketingEnabled;
    const { data, error } = await supabaseAdmin.rpc('set_mobile_push_preferences', {
      p_user_id: cleanString(userId, 80),
      p_transactional_enabled: transactionalEnabled,
      p_marketing_enabled: marketingEnabled,
      p_source: 'authenticated_api',
    });
    if (error) throw pushError('No se pudieron guardar las preferencias push', 503, 'PUSH_STORAGE_UNAVAILABLE');
    const row = rpcRow(data);
    return {
      transactionalEnabled: row?.transactional_enabled !== false,
      marketingEnabled: row?.marketing_enabled === true,
      updatedAt: row?.updated_at || now().toISOString(),
    };
  }

  async function invalidateTokenRows(rows, reason) {
    const ids = [...new Set((rows || []).map((row) => Number(row?.id)).filter(Number.isFinite))];
    if (!ids.length) return;
    const timestamp = now().toISOString();
    const { error } = await supabaseAdmin
      .from('push_tokens')
      .update({
        enabled: false,
        invalidated_at: timestamp,
        updated_at: timestamp,
        invalidation_reason: cleanString(reason, 160),
      })
      .in('id', ids);
    if (error) logger.warn?.('[push] No se pudieron invalidar tokens:', error.message);
  }

  async function fetchEligibleTokens(userIds, category) {
    assertConfigured();
    const ids = [...new Set((userIds || []).map((id) => cleanString(id, 80)).filter(Boolean))];
    if (!ids.length) return [];
    const tokenRows = [];
    const preferenceRows = [];
    for (let index = 0; index < ids.length; index += 100) {
      const chunk = ids.slice(index, index + 100);
      for (let offset = 0; ; offset += 1000) {
        const { data, error: tokenError } = await supabaseAdmin
          .from('push_tokens')
          .select('id, user_id, expo_push_token, platform, device_id, language')
          .in('user_id', chunk)
          .eq('enabled', true)
          .is('revoked_at', null)
          .is('invalidated_at', null)
          .range(offset, offset + 999);
        if (tokenError) {
          throw pushError('No se pudieron resolver los dispositivos push', 503, 'PUSH_STORAGE_UNAVAILABLE');
        }
        tokenRows.push(...(data || []));
        if (!data || data.length < 1000) break;
      }

      const { data, error: preferenceError } = await supabaseAdmin
        .from('push_notification_preferences')
        .select('user_id, transactional_enabled, marketing_enabled')
        .in('user_id', chunk);
      if (preferenceError) {
        throw pushError('No se pudieron comprobar las preferencias push', 503, 'PUSH_STORAGE_UNAVAILABLE');
      }
      preferenceRows.push(...(data || []));
    }
    const preferences = new Map((preferenceRows || []).map((row) => [String(row.user_id), row]));
    const invalid = (tokenRows || []).filter((row) => !isExpoPushToken(row.expo_push_token));
    if (invalid.length) await invalidateTokenRows(invalid, 'invalid_format');

    return (tokenRows || [])
      .filter((row) => isExpoPushToken(row.expo_push_token))
      .filter((row) => {
        const preference = preferences.get(String(row.user_id));
        if (category === 'marketing') return preference?.marketing_enabled === true;
        return preference?.transactional_enabled !== false;
      })
      .map((row) => ({
        id: row.id,
        userId: row.user_id,
        language: normalizePushLanguage(row.language) || 'es',
        token: row.expo_push_token,
        fingerprint: pushTokenFingerprint(row.expo_push_token),
      }));
  }

  async function claimJob({ idempotencyKey, source, category, title, body, data, actorUserId }) {
    const row = {
      idempotency_key: idempotencyKey,
      source,
      category,
      event_type: data.type,
      title,
      body,
      payload: data,
      actor_user_id: actorUserId || null,
      status: 'processing',
    };
    const { data: inserted, error } = await supabaseAdmin
      .from('push_delivery_jobs')
      .insert(row)
      .select('*')
      .single();
    if (!error) return { job: inserted, duplicate: false };
    if (!isUniqueViolation(error)) throw pushError('No se pudo crear el envío push', 503, 'PUSH_STORAGE_UNAVAILABLE');
    const { data: existing, error: existingError } = await supabaseAdmin
      .from('push_delivery_jobs')
      .select('*')
      .eq('idempotency_key', idempotencyKey)
      .maybeSingle();
    if (existingError || !existing) {
      throw pushError('No se pudo recuperar el envío idempotente', 503, 'PUSH_STORAGE_UNAVAILABLE');
    }
    return { job: existing, duplicate: true };
  }

  async function updateJob(jobId, patch) {
    const { error } = await supabaseAdmin
      .from('push_delivery_jobs')
      .update({ ...patch, updated_at: now().toISOString() })
      .eq('id', jobId);
    if (error) throw pushError('No se pudo actualizar la auditoría push', 503, 'PUSH_STORAGE_UNAVAILABLE');
  }

  async function dispatch({
    idempotencyKey,
    userIds,
    title,
    body,
    category = 'transactional',
    data,
    source = 'system',
    actorUserId = null,
    tokenIds = null,
  } = {}) {
    assertConfigured();
    if (!sendEnabled) throw pushError('Envío push deshabilitado en este entorno', 503, 'PUSH_SEND_DISABLED');
    const key = cleanString(idempotencyKey, MAX_IDEMPOTENCY_KEY_LENGTH);
    const cleanTitle = cleanString(title, MAX_TITLE_LENGTH);
    const cleanBody = cleanString(body, MAX_BODY_LENGTH);
    const cleanCategory = cleanString(category, 40).toLowerCase();
    const payload = sanitizePushData(data);
    const recipients = [...new Set((userIds || []).map((id) => cleanString(id, 80)).filter(Boolean))];
    if (!key || !cleanTitle || !cleanBody || !PUSH_CATEGORIES.has(cleanCategory)) {
      throw pushError('Solicitud de envío push inválida', 400, 'PUSH_DISPATCH_INVALID');
    }

    const claimed = await claimJob({
      idempotencyKey: key,
      source: cleanString(source, 100) || 'system',
      category: cleanCategory,
      title: cleanTitle,
      body: cleanBody,
      data: payload,
      actorUserId,
    });
    if (claimed.duplicate) {
      return {
        duplicate: true,
        jobId: claimed.job.id,
        status: claimed.job.status,
        recipients: claimed.job.recipient_count || 0,
        sent: claimed.job.token_count || 0,
        accepted: claimed.job.accepted_count || 0,
        failed: claimed.job.failed_count || 0,
      };
    }

    const job = claimed.job;
    try {
      let tokens = await fetchEligibleTokens(recipients, cleanCategory);
      if (tokenIds) { const allowed = new Set(tokenIds.map(String)); tokens = tokens.filter(token => allowed.has(String(token.id))); }
      if (!tokens.length) {
        await updateJob(job.id, {
          recipient_count: recipients.length,
          token_count: 0,
          accepted_count: 0,
          failed_count: 0,
          status: 'no_tokens',
        });
        return {
          duplicate: false,
          jobId: job.id,
          status: 'no_tokens',
          recipients: recipients.length,
          sent: 0,
          accepted: 0,
          failed: 0,
        };
      }

      const result = await sendExpoPushNotifications({
        title: cleanTitle,
        body: cleanBody,
        tokens: tokens.map((token) => ({ ...token, ...localizedPushPreview({ language: token.language, category: cleanCategory, type: payload.type, title: cleanTitle, body: cleanBody }) })),
        data: payload,
        fetchImpl,
        accessToken: expoAccessToken,
        sleepImpl,
      });
      const nextReceiptCheckAt = new Date(now().getTime() + RECEIPT_RECHECK_MS).toISOString();
      const attempts = result.results.map((row) => ({
        job_id: job.id,
        push_token_id: row.id || null,
        user_id: row.userId || null,
        token_fingerprint: row.fingerprint || pushTokenFingerprint(row.token),
        expo_ticket_id: row.ok ? row.ticket.id : null,
        status: row.ok
          ? 'ticket_ok'
          : row.errorCode === 'DeviceNotRegistered' ? 'invalidated' : 'ticket_error',
        error_code: row.errorCode,
        error_message: row.errorMessage,
        next_receipt_check_at: row.ok ? nextReceiptCheckAt : null,
      }));
      const { error: attemptsError } = await supabaseAdmin
        .from('push_delivery_attempts')
        .insert(attempts);
      if (attemptsError) throw attemptsError;
      await invalidateTokenRows(
        result.results.filter((row) => row.errorCode === 'DeviceNotRegistered'),
        'DeviceNotRegistered',
      );
      const status = result.failed === 0 ? 'sent' : result.accepted > 0 ? 'partial' : 'failed';
      await updateJob(job.id, {
        recipient_count: recipients.length,
        token_count: tokens.length,
        accepted_count: result.accepted,
        failed_count: result.failed,
        status,
        last_error: result.failed ? 'Uno o más tickets fueron rechazados por Expo' : null,
      });
      return {
        duplicate: false,
        jobId: job.id,
        status,
        recipients: recipients.length,
        sent: result.sent,
        accepted: result.accepted,
        failed: result.failed,
      };
    } catch (error) {
      await updateJob(job.id, {
        recipient_count: recipients.length,
        status: 'failed',
        last_error: cleanString(error?.message, 500),
      }).catch(() => {});
      throw error;
    }
  }

  async function processPendingReceipts({ limit = 300 } = {}) {
    assertConfigured();
    if (!sendEnabled) return { disabled: true, checked: 0 };
    const nowIso = now().toISOString();
    const { data: attempts, error } = await supabaseAdmin
      .from('push_delivery_attempts')
      .select('id, job_id, push_token_id, expo_ticket_id, receipt_check_count')
      .eq('status', 'ticket_ok')
      .not('expo_ticket_id', 'is', null)
      .lte('next_receipt_check_at', nowIso)
      .order('next_receipt_check_at', { ascending: true })
      .limit(Math.min(Number(limit) || EXPO_RECEIPT_BATCH, EXPO_RECEIPT_BATCH));
    if (error) throw pushError('No se pudieron cargar receipts pendientes', 503, 'PUSH_STORAGE_UNAVAILABLE');
    if (!attempts?.length) return { checked: 0, delivered: 0, invalidated: 0, pending: 0 };

    const ticketIds = attempts.map((row) => row.expo_ticket_id);
    const json = await postExpoJsonWithRetry({
      url: EXPO_PUSH_RECEIPTS_URL,
      payload: { ids: ticketIds },
      fetchImpl,
      accessToken: expoAccessToken,
      sleepImpl,
    });
    const receipts = json?.data && typeof json.data === 'object' ? json.data : {};
    let delivered = 0;
    let invalidated = 0;
    let pending = 0;
    for (const attempt of attempts) {
      const receipt = receipts[attempt.expo_ticket_id];
      const checkedCount = Number(attempt.receipt_check_count || 0) + 1;
      if (!receipt) {
        const timedOut = checkedCount >= RECEIPT_MAX_CHECKS;
        await supabaseAdmin
          .from('push_delivery_attempts')
          .update({
            receipt_check_count: checkedCount,
            status: timedOut ? 'receipt_timeout' : 'ticket_ok',
            next_receipt_check_at: timedOut
              ? null
              : new Date(now().getTime() + RECEIPT_RECHECK_MS).toISOString(),
            updated_at: now().toISOString(),
          })
          .eq('id', attempt.id);
        if (!timedOut) pending += 1;
        continue;
      }

      if (receipt.status === 'ok') {
        delivered += 1;
        await supabaseAdmin
          .from('push_delivery_attempts')
          .update({
            status: 'delivered',
            receipt_check_count: checkedCount,
            receipt_checked_at: now().toISOString(),
            next_receipt_check_at: null,
            updated_at: now().toISOString(),
          })
          .eq('id', attempt.id);
        continue;
      }

      const errorCode = cleanString(receipt?.details?.error, 160) || 'ExpoReceiptError';
      if (errorCode === 'DeviceNotRegistered') {
        invalidated += 1;
        await invalidateTokenRows([{ id: attempt.push_token_id }], errorCode);
      }
      await supabaseAdmin
        .from('push_delivery_attempts')
        .update({
          status: errorCode === 'DeviceNotRegistered' ? 'invalidated' : 'receipt_error',
          error_code: errorCode,
          error_message: cleanString(receipt?.message, 500),
          receipt_check_count: checkedCount,
          receipt_checked_at: now().toISOString(),
          next_receipt_check_at: null,
          updated_at: now().toISOString(),
        })
        .eq('id', attempt.id);
    }
    return { checked: attempts.length, delivered, invalidated, pending };
  }

  return {
    dispatch,
    fetchEligibleTokens,
    getPreferences,
    invalidateTokenRows,
    processPendingReceipts,
    registerToken,
    revokeToken,
    updatePreferences,
  };
}

function routeError(res, error, logger, route) {
  logger.error?.(`[push] ${route}:`, error?.message || error);
  return res.status(error?.status || 500).json({
    error: error?.message || 'Error de notificaciones push',
    code: error?.code || 'PUSH_ERROR',
  });
}

export function registerMobilePushRoutes(app, { pushService, authUserFromBearer, logger = console }) {
  app.post('/api/push-tokens', async (req, res) => {
    try {
      const user = await authUserFromBearer(req);
      if (!user?.id) throw pushError('No autorizado', 401, 'AUTH_REQUIRED');
      const result = await pushService.registerToken({
        userId: user.id,
        token: req.body?.token,
        platform: req.body?.platform,
        deviceId: req.body?.deviceId,
        language: req.body?.language,
      });
      return res.status(201).json(result);
    } catch (error) {
      return routeError(res, error, logger, 'POST /api/push-tokens');
    }
  });

  app.delete('/api/push-tokens', async (req, res) => {
    try {
      const user = await authUserFromBearer(req);
      if (!user?.id) throw pushError('No autorizado', 401, 'AUTH_REQUIRED');
      const result = await pushService.revokeToken({
        userId: user.id,
        token: req.body?.token,
        deviceId: req.body?.deviceId,
      });
      return res.json(result);
    } catch (error) {
      return routeError(res, error, logger, 'DELETE /api/push-tokens');
    }
  });

  app.get('/api/push-preferences', async (req, res) => {
    try {
      const user = await authUserFromBearer(req);
      if (!user?.id) throw pushError('No autorizado', 401, 'AUTH_REQUIRED');
      return res.json(await pushService.getPreferences(user.id));
    } catch (error) {
      return routeError(res, error, logger, 'GET /api/push-preferences');
    }
  });

  app.patch('/api/push-preferences', async (req, res) => {
    try {
      const user = await authUserFromBearer(req);
      if (!user?.id) throw pushError('No autorizado', 401, 'AUTH_REQUIRED');
      return res.json(await pushService.updatePreferences(user.id, req.body));
    } catch (error) {
      return routeError(res, error, logger, 'PATCH /api/push-preferences');
    }
  });
}

export function newPushIdempotencyKey(prefix, ...parts) {
  const safePrefix = cleanString(prefix, 50).replace(/[^a-zA-Z0-9:_-]/g, '_') || 'push';
  const safeParts = parts
    .map((part) => cleanString(part, 80).replace(/[^a-zA-Z0-9:_.-]/g, '_'))
    .filter(Boolean);
  return [safePrefix, ...safeParts, uuidSuffix()].join(':').slice(0, MAX_IDEMPOTENCY_KEY_LENGTH);
}

function uuidSuffix() {
  return randomUUID();
}
