import {
  createNotificacionIfAbsent,
  logNotificacionDiagnostic,
} from '../../utils/notificaciones.js';

export const PADCOINS_CANJE_NOTIFICATION_SOURCE = 'padcoins_canje_v1';

export const PADCOINS_CANJE_NOTIFICATION_TYPES = Object.freeze({
  JUGADOR_PENDIENTE: 'padcoins_canje_pendiente',
  ADMIN_NUEVO_PENDIENTE: 'padcoins_canje_admin_pendiente',
  JUGADOR_ENTREGADO: 'padcoins_canje_entregado',
  JUGADOR_CANCELADO: 'padcoins_canje_cancelado',
});

export const PADCOINS_CANJE_NOTIFICATION_TRANSITIONS = Object.freeze({
  PLAYER_PENDIENTE: 'player_pendiente',
  ADMIN_NUEVO_PENDIENTE: 'admin_nuevo_pendiente',
  PLAYER_ENTREGADO: 'player_entregado',
  PLAYER_CANCELADO: 'player_cancelado',
});

export const PADCOINS_CANJE_PLAYER_ACTION = 'ver_canje_padcoins';
export const PADCOINS_CANJE_ADMIN_ACTION = 'admin_padcoins_canjes';

function normalizeCanje(canje = {}) {
  return {
    id: String(canje.id ?? '').trim(),
    user_id: String(canje.user_id ?? '').trim(),
    sede_id: canje.sede_id != null ? Number(canje.sede_id) : null,
    premio_id: canje.premio_id ?? null,
    estado: canje.estado ?? null,
    codigo: canje.codigo ?? null,
    premio_nombre: canje.premio_nombre ?? null,
  };
}

export function buildPadcoinsCanjeNotificationDedupeKey(canjeId, userId, transition) {
  return `padcoins_canje|${String(canjeId).trim()}|user|${String(userId).trim()}|${transition}`;
}

export function buildPadcoinsCanjeNotificationMetadata(canje, userId, transition, {
  premioNombre = null,
} = {}) {
  const normalized = normalizeCanje(canje);
  const resolvedPremioNombre = premioNombre ?? normalized.premio_nombre ?? null;
  const isAdminTransition = transition === PADCOINS_CANJE_NOTIFICATION_TRANSITIONS.ADMIN_NUEVO_PENDIENTE;

  return {
    canje_id: normalized.id,
    premio_id: normalized.premio_id,
    sede_id: normalized.sede_id,
    estado: normalized.estado,
    codigo: normalized.codigo,
    premio_nombre: resolvedPremioNombre,
    source: PADCOINS_CANJE_NOTIFICATION_SOURCE,
    transition,
    action: isAdminTransition ? PADCOINS_CANJE_ADMIN_ACTION : PADCOINS_CANJE_PLAYER_ACTION,
    dedupe_key: buildPadcoinsCanjeNotificationDedupeKey(normalized.id, userId, transition),
  };
}

export function buildPadcoinsCanjePlayerLink(canjeId) {
  const id = String(canjeId ?? '').trim();
  return id ? `/padcoins/canjes/${id}` : null;
}

export function buildPadcoinsCanjeAdminLink(sedeId, canjeId) {
  const sid = Number(sedeId);
  const id = String(canjeId ?? '').trim();
  if (!Number.isFinite(sid) || sid <= 0 || !id) return null;
  return `/admin/padcoins-canjes?sede_id=${sid}&canje_id=${id}`;
}

export async function getSedeAdminClubUserIds(supabaseAdmin, sedeId) {
  if (!supabaseAdmin) return [];

  const sid = Number(sedeId);
  if (!Number.isFinite(sid) || sid <= 0) return [];

  const { data, error } = await supabaseAdmin
    .from('user_roles')
    .select('user_id')
    .eq('role', 'admin_club')
    .eq('sede_id', sid);

  if (error) throw error;

  return [...new Set((data ?? []).map((row) => row.user_id).filter(Boolean))];
}

async function sendPadcoinsCanjeNotification(supabaseAdmin, {
  userId,
  tipo,
  titulo,
  mensaje,
  canje,
  transition,
  premioNombre,
  link,
}, deps = {}) {
  const createFn = deps.createNotificacionIfAbsent ?? createNotificacionIfAbsent;
  const metadata = buildPadcoinsCanjeNotificationMetadata(canje, userId, transition, { premioNombre });

  const result = await createFn(supabaseAdmin, {
    user_id: userId,
    tipo,
    titulo,
    mensaje,
    link,
    data: metadata,
  });

  logNotificacionDiagnostic('padcoins_canje_notification', {
    canje_id: canje?.id ?? null,
    user_id: userId,
    transition,
    created: result?.created === true,
    duplicate: result?.duplicate === true,
  });

  return result;
}

export async function notifyPadcoinsCanjePendientePlayer(supabaseAdmin, canje, {
  premioNombre = null,
} = {}, deps = {}) {
  const normalized = normalizeCanje(canje);
  if (!normalized.id || !normalized.user_id) return { skipped: true, reason: 'invalid_canje' };

  const nombre = premioNombre ?? normalized.premio_nombre ?? 'beneficio';

  return sendPadcoinsCanjeNotification(supabaseAdmin, {
    userId: normalized.user_id,
    tipo: PADCOINS_CANJE_NOTIFICATION_TYPES.JUGADOR_PENDIENTE,
    titulo: 'Canje registrado',
    mensaje: `Tu canje de "${nombre}" quedó pendiente. Código: ${normalized.codigo ?? '—'}.`,
    canje: normalized,
    transition: PADCOINS_CANJE_NOTIFICATION_TRANSITIONS.PLAYER_PENDIENTE,
    premioNombre: nombre,
    link: buildPadcoinsCanjePlayerLink(normalized.id),
  }, deps);
}

export async function notifyPadcoinsNuevoCanjeAdminSede(supabaseAdmin, canje, {
  premioNombre = null,
} = {}, deps = {}) {
  const normalized = normalizeCanje(canje);
  if (!normalized.id || normalized.sede_id == null) {
    return { skipped: true, reason: 'invalid_canje' };
  }

  const adminIds = await getSedeAdminClubUserIds(supabaseAdmin, normalized.sede_id);
  if (!adminIds.length) {
    return { skipped: true, reason: 'no_admins' };
  }

  const nombre = premioNombre ?? normalized.premio_nombre ?? 'beneficio';
  const results = [];

  for (const adminUserId of adminIds) {
    const result = await sendPadcoinsCanjeNotification(supabaseAdmin, {
      userId: adminUserId,
      tipo: PADCOINS_CANJE_NOTIFICATION_TYPES.ADMIN_NUEVO_PENDIENTE,
      titulo: 'Nuevo canje PadCoins',
      mensaje: `Canje pendiente: "${nombre}" (${normalized.codigo ?? 'sin código'}).`,
      canje: normalized,
      transition: PADCOINS_CANJE_NOTIFICATION_TRANSITIONS.ADMIN_NUEVO_PENDIENTE,
      premioNombre: nombre,
      link: buildPadcoinsCanjeAdminLink(normalized.sede_id, normalized.id),
    }, deps);
    results.push({ user_id: adminUserId, ...result });
  }

  return { notified: results.length, results };
}

export async function notifyPadcoinsCanjeEntregadoPlayer(supabaseAdmin, canje, {
  premioNombre = null,
} = {}, deps = {}) {
  const normalized = normalizeCanje(canje);
  if (!normalized.id || !normalized.user_id) return { skipped: true, reason: 'invalid_canje' };

  const nombre = premioNombre ?? normalized.premio_nombre ?? 'beneficio';

  return sendPadcoinsCanjeNotification(supabaseAdmin, {
    userId: normalized.user_id,
    tipo: PADCOINS_CANJE_NOTIFICATION_TYPES.JUGADOR_ENTREGADO,
    titulo: 'Canje entregado',
    mensaje: `Tu canje de "${nombre}" fue entregado. ¡Disfrutalo!`,
    canje: { ...normalized, estado: 'entregado' },
    transition: PADCOINS_CANJE_NOTIFICATION_TRANSITIONS.PLAYER_ENTREGADO,
    premioNombre: nombre,
    link: buildPadcoinsCanjePlayerLink(normalized.id),
  }, deps);
}

export async function notifyPadcoinsCanjeCanceladoPlayer(supabaseAdmin, canje, {
  premioNombre = null,
  reason = null,
} = {}, deps = {}) {
  const normalized = normalizeCanje(canje);
  if (!normalized.id || !normalized.user_id) return { skipped: true, reason: 'invalid_canje' };

  const nombre = premioNombre ?? normalized.premio_nombre ?? 'beneficio';
  const suffix = reason ? ` Motivo: ${String(reason).trim()}.` : '';

  return sendPadcoinsCanjeNotification(supabaseAdmin, {
    userId: normalized.user_id,
    tipo: PADCOINS_CANJE_NOTIFICATION_TYPES.JUGADOR_CANCELADO,
    titulo: 'Canje cancelado',
    mensaje: `Se canceló tu canje de "${nombre}". Tus PadCoins fueron devueltos.${suffix}`,
    canje: { ...normalized, estado: 'cancelado' },
    transition: PADCOINS_CANJE_NOTIFICATION_TRANSITIONS.PLAYER_CANCELADO,
    premioNombre: nombre,
    link: buildPadcoinsCanjePlayerLink(normalized.id),
  }, deps);
}

export async function notifyPadcoinsCanjeCreated(supabaseAdmin, {
  canje,
  premioNombre = null,
} = {}, deps = {}) {
  const playerResult = await notifyPadcoinsCanjePendientePlayer(
    supabaseAdmin,
    canje,
    { premioNombre },
    deps,
  );
  const adminResult = await notifyPadcoinsNuevoCanjeAdminSede(
    supabaseAdmin,
    canje,
    { premioNombre },
    deps,
  );

  return { player: playerResult, admin: adminResult };
}
