import {
  buildDedupeLinkPrefix,
  encodeNotificationLinkPayload,
  hasNotificationMetadata,
  isMissingNotificacionesDataColumnError,
  resolveNotificationData,
  resolveNotificationPayload,
  sanitizeNotificationMetadata,
} from './notificacionesMetadata.js';

export { isMissingNotificacionesDataColumnError };

const NOTIFICACIONES_TABLE = 'notificaciones';

/** Columnas seguras en prod sin columna `data`. */
export const NOTIFICACIONES_PUBLIC_COLUMNS =
  'id, user_id, tipo, titulo, mensaje, link, leida, created_at';

const SELECT_WITH_DATA = `id, user_id, tipo, titulo, mensaje, data, link, leida, created_at`;
const SELECT_LINK_ONLY = NOTIFICACIONES_PUBLIC_COLUMNS;

/** @type {'auto' | 'data' | 'link'} */
let metadataStorageMode = 'auto';

export function resetNotificacionesMetadataModeForTests() {
  metadataStorageMode = 'auto';
}

export function getNotificacionesMetadataStorageMode() {
  return metadataStorageMode;
}

function resolveTitulo(payload = {}) {
  const titulo = String(payload.titulo ?? payload.mensaje ?? payload.tipo ?? 'Notificación').trim();
  return titulo || 'Notificación';
}

function buildInsertRow(payload = {}, mode = 'data') {
  const metadata = sanitizeNotificationMetadata(payload.data ?? {});
  const originalLink = payload.link != null && String(payload.link).trim()
    ? String(payload.link).trim()
    : null;

  const row = {
    user_id: payload.user_id,
    tipo: payload.tipo,
    titulo: resolveTitulo(payload),
    mensaje: payload.mensaje,
    leida: false,
  };

  if (mode === 'data') {
    if (hasNotificationMetadata(metadata)) {
      row.data = metadata;
    }
    if (originalLink) {
      row.link = originalLink;
    }
    return row;
  }

  if (hasNotificationMetadata(metadata)) {
    const enriched = { ...metadata };
    if (originalLink) {
      enriched.original_link = originalLink;
    }
    row.link = encodeNotificationLinkPayload(enriched);
    return row;
  }

  if (originalLink) {
    row.link = originalLink;
  }

  return row;
}

async function insertNotificacionRow(supabaseAdmin, row) {
  return supabaseAdmin
    .from(NOTIFICACIONES_TABLE)
    .insert(row)
    .select(NOTIFICACIONES_PUBLIC_COLUMNS)
    .single();
}

export async function createNotificacion(supabaseAdmin, payload) {
  const userId = payload?.user_id;
  const tipo = String(payload?.tipo ?? '').trim();
  const mensaje = String(payload?.mensaje ?? '').trim();

  if (!userId || !tipo || !mensaje) return null;

  const modesToTry = metadataStorageMode === 'auto'
    ? ['data', 'link']
    : [metadataStorageMode];

  for (const mode of modesToTry) {
    try {
      const { data, error } = await insertNotificacionRow(
        supabaseAdmin,
        buildInsertRow(payload, mode),
      );
      if (error) throw error;
      if (metadataStorageMode === 'auto') {
        metadataStorageMode = mode;
      }
      return data;
    } catch (err) {
      if (isMissingNotificacionesDataColumnError(err)) {
        if (mode === 'data') {
          metadataStorageMode = 'link';
          continue;
        }
        console.warn('⚠️ createNotificacion: schema sin columna data en modo link');
        return null;
      }
      if (err?.code === 'NOTIFICATION_LINK_TOO_LARGE') {
        console.warn('⚠️ createNotificacion: encoded link too large');
        return null;
      }
      console.warn('⚠️ createNotificacion:', err.message);
      return null;
    }
  }

  return null;
}

async function queryNotificacionByDedupeKeyData(supabaseAdmin, userId, dedupeKey) {
  const { data, error } = await supabaseAdmin
    .from(NOTIFICACIONES_TABLE)
    .select(SELECT_WITH_DATA)
    .eq('user_id', userId)
    .contains('data', { dedupe_key: dedupeKey })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingNotificacionesDataColumnError(error)) {
      return { row: null, useLinkMode: true };
    }
    throw error;
  }

  return { row: data ?? null, useLinkMode: false };
}

async function queryNotificacionByDedupeKeyLink(supabaseAdmin, userId, dedupeKey) {
  const { data, error } = await supabaseAdmin
    .from(NOTIFICACIONES_TABLE)
    .select(SELECT_LINK_ONLY)
    .eq('user_id', userId)
    .like('link', `${buildDedupeLinkPrefix(dedupeKey)}%`)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function findNotificacionByDedupeKey(supabaseAdmin, userId, dedupeKey) {
  if (!userId || !dedupeKey) return null;

  try {
    if (metadataStorageMode === 'data') {
      const dataResult = await queryNotificacionByDedupeKeyData(supabaseAdmin, userId, dedupeKey);
      if (dataResult.useLinkMode) {
        metadataStorageMode = 'link';
      } else if (dataResult.row) {
        return dataResult.row;
      } else {
        return null;
      }
    }

    if (metadataStorageMode === 'auto') {
      const dataResult = await queryNotificacionByDedupeKeyData(supabaseAdmin, userId, dedupeKey);
      if (dataResult.useLinkMode) {
        metadataStorageMode = 'link';
      } else if (dataResult.row) {
        metadataStorageMode = 'data';
        return dataResult.row;
      }
    }

    return await queryNotificacionByDedupeKeyLink(supabaseAdmin, userId, dedupeKey);
  } catch (err) {
    if (isNotificacionesTableMissing(err)) return null;
    console.warn('⚠️ findNotificacionByDedupeKey:', err.message);
    return null;
  }
}

/** Log diagnóstico sin PII (solo ids/tipos/motivos). */
export function logNotificacionDiagnostic(event, details = {}) {
  const safe = {};
  for (const [key, value] of Object.entries(details)) {
    if (value == null) {
      safe[key] = value;
      continue;
    }
    const lower = String(key).toLowerCase();
    if (lower.includes('email') || lower.includes('token') || lower.includes('phone')) {
      continue;
    }
    safe[key] = value;
  }
  console.log(`[notificaciones] ${event}`, safe);
}

export async function createNotificacionIfAbsent(supabaseAdmin, payload) {
  const dedupeKey = payload?.data?.dedupe_key ?? null;
  if (dedupeKey) {
    const existing = await findNotificacionByDedupeKey(
      supabaseAdmin,
      payload.user_id,
      dedupeKey,
    );
    if (existing) {
      return { created: false, duplicate: true, notificacion: existing };
    }
  }

  const notificacion = await createNotificacion(supabaseAdmin, payload);
  if (!notificacion) {
    return { created: false, duplicate: false, notificacion: null };
  }

  return { created: true, duplicate: false, notificacion };
}

export async function markNotificacionLeida(supabaseAdmin, notificacionId, userId) {
  const { data, error } = await supabaseAdmin
    .from(NOTIFICACIONES_TABLE)
    .update({ leida: true })
    .eq('id', notificacionId)
    .eq('user_id', userId)
    .select(NOTIFICACIONES_PUBLIC_COLUMNS)
    .maybeSingle();

  if (error) throw error;
  return data;
}

export async function markAllNotificacionesLeidas(supabaseAdmin, userId) {
  const { error } = await supabaseAdmin
    .from(NOTIFICACIONES_TABLE)
    .update({ leida: true })
    .eq('user_id', userId)
    .eq('leida', false);

  if (error) throw error;
}

export function isNotificacionesTableMissing(error) {
  const msg = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || msg.includes('notificaciones')
  );
}

export { resolveNotificationData, resolveNotificationPayload };

export async function listNotificacionesForUser(supabaseAdmin, userId, { limit = 100 } = {}) {
  const effectiveLimit = Number.isFinite(Number(limit)) && Number(limit) > 0
    ? Math.floor(Number(limit))
    : 100;

  const { data, error } = await supabaseAdmin
    .from(NOTIFICACIONES_TABLE)
    .select(NOTIFICACIONES_PUBLIC_COLUMNS)
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(effectiveLimit);

  if (error) throw error;
  return data ?? [];
}
