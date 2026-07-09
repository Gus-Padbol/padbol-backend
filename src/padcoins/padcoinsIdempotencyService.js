import { PADCOINS_MOVEMENT_TYPES, PADCOINS_ORIGINS } from './padcoinsConfig.js';

/** Acciones de origen para trazabilidad e idempotencia. */
export const PADCOINS_SOURCE_ACTIONS = Object.freeze({
  EARN: 'earn',
  SPEND: 'spend',
  PENALTY: 'penalty',
  REVERSE: 'reverse',
  ADJUST: 'adjust',
});

/** Tipos de origen que exigen idempotencia estricta (misma fuente no se repite). */
export const IDEMPOTENT_SOURCE_TYPES = new Set([
  'reserva',
  PADCOINS_ORIGINS.LOGRO_DESBLOQUEADO,
  'logro',
  PADCOINS_ORIGINS.PENALIZACION,
  PADCOINS_ORIGINS.CANJE_PREMIO,
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

export function isDuplicateMovimientoError(error) {
  return error?.code === '23505'
    && String(error?.message ?? '').toLowerCase().includes('padcoins_movimientos');
}

export function isDuplicateCampaignApplicationError(error) {
  return error?.code === '23505'
    && String(error?.message ?? '').toLowerCase().includes('padcoins_campaign_applications');
}

/**
 * Clave estable para auditar y deduplicar acreditaciones.
 * Formato: user_id|source_type|source_id|action
 */
export function buildPadcoinsSourceKey({
  user_id,
  userId,
  source_type,
  sourceType,
  source_id,
  sourceId,
  action,
} = {}) {
  const uid = String(user_id ?? userId ?? '').trim();
  const st = String(source_type ?? sourceType ?? '').trim();
  const sid = source_id ?? sourceId;
  const act = String(action ?? '').trim();

  if (!uid || !st || sid == null || String(sid).trim() === '' || !act) {
    return null;
  }

  return `${uid}|${st}|${String(sid).trim()}|${act}`;
}

export function buildMovimientoMetadata({
  source_type,
  sourceType,
  source_id,
  sourceId,
  action,
  campaign_id,
  campaignId,
  calculation_detail,
  calculationDetail,
  source_key,
  sourceKey,
} = {}) {
  const metadata = {};

  const st = source_type ?? sourceType;
  const sid = source_id ?? sourceId;
  const act = action;
  const cid = campaign_id ?? campaignId;
  const detail = calculation_detail ?? calculationDetail;
  const key = source_key ?? sourceKey;

  if (st) metadata.source_type = String(st);
  if (sid != null) metadata.source_id = String(sid);
  if (act) metadata.action = String(act);
  if (cid) metadata.campaign_id = String(cid);
  if (detail && typeof detail === 'object') metadata.calculation_detail = detail;
  if (key) metadata.source_key = String(key);

  return Object.keys(metadata).length > 0 ? metadata : null;
}

function appendMetadataToDescripcion(descripcion, metadata) {
  if (!metadata) return descripcion;
  const suffix = ` [meta:${JSON.stringify(metadata)}]`;
  const base = descripcion ?? '';
  return `${base}${suffix}`.slice(0, 500);
}

export function enrichMovimientoOptions(options = {}) {
  const sourceType = options.source_type ?? options.referencia_tipo ?? null;
  const sourceId = options.source_id ?? options.referencia_id ?? null;
  const action = options.action
    ?? (options.tipo === PADCOINS_MOVEMENT_TYPES.SPEND ? PADCOINS_SOURCE_ACTIONS.SPEND : PADCOINS_SOURCE_ACTIONS.EARN);

  const sourceKeyFromEarning = options.metadata?.source_key ?? null;
  const sourceKey = sourceKeyFromEarning ?? buildPadcoinsSourceKey({
    userId: options.user_id ?? options.userId,
    sourceType: options.earning_source_key ?? sourceType,
    sourceId,
    action,
  });

  let metadata = options.metadata && typeof options.metadata === 'object'
    ? { ...options.metadata }
    : buildMovimientoMetadata({
      sourceType,
      sourceId,
      action,
      campaignId: options.campaign_id ?? options.campaignId,
      calculationDetail: options.calculation_detail ?? options.calculationDetail,
      sourceKey,
    });

  if (metadata && sourceKey && !metadata.source_key) {
    metadata.source_key = sourceKey;
  }

  const descripcion = metadata
    ? appendMetadataToDescripcion(options.descripcion, metadata)
    : options.descripcion;

  return {
    ...options,
    source_type: sourceType,
    source_id: sourceId != null ? String(sourceId) : null,
    action,
    source_key: sourceKey,
    metadata,
    descripcion,
  };
}

export async function findExistingPadcoinsMovimientoBySource(supabaseAdmin, {
  referencia_tipo,
  referencia_id,
  tipo = null,
  user_id = null,
} = {}) {
  const refTipo = String(referencia_tipo ?? '').trim();
  const refId = referencia_id != null ? String(referencia_id).trim() : '';
  if (!refTipo || !refId) return null;

  let query = supabaseAdmin
    .from('padcoins_movimientos')
    .select('*')
    .eq('referencia_tipo', refTipo)
    .eq('referencia_id', refId)
    .limit(1);

  if (tipo) {
    query = query.eq('tipo', tipo);
  }
  if (user_id && UUID_REGEX.test(String(user_id))) {
    query = query.eq('user_id', String(user_id));
  }

  const { data, error } = await query.maybeSingle();

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }

  return data ?? null;
}

/**
 * Verifica que no exista un movimiento previo para la misma fuente.
 * Retorna { alreadyApplied, movimiento } sin lanzar si ya fue aplicado.
 */
export async function ensurePadcoinsNotAlreadyApplied(supabaseAdmin, {
  user_id,
  userId,
  source_type,
  sourceType,
  source_id,
  sourceId,
  action,
  referencia_tipo,
  referencia_id,
  tipo = PADCOINS_MOVEMENT_TYPES.EARN,
} = {}) {
  const refTipo = String(source_type ?? sourceType ?? referencia_tipo ?? '').trim();
  const refId = source_id ?? sourceId ?? referencia_id;
  const refIdStr = refId != null ? String(refId).trim() : '';

  if (!refTipo || !refIdStr) {
    return { alreadyApplied: false, movimiento: null };
  }

  const existing = await findExistingPadcoinsMovimientoBySource(supabaseAdmin, {
    referencia_tipo: refTipo,
    referencia_id: refIdStr,
    tipo,
    user_id: user_id ?? userId,
  });

  if (existing?.id) {
    return {
      alreadyApplied: true,
      movimiento: existing,
      source_key: buildPadcoinsSourceKey({
        userId: user_id ?? userId,
        sourceType: refTipo,
        sourceId: refIdStr,
        action: action ?? tipo,
      }),
    };
  }

  return { alreadyApplied: false, movimiento: null };
}

/**
 * Registra aplicación de campaña; tolera duplicado por unique (campaign_id, reserva_id).
 */
export async function registerPadcoinsApplication(supabaseAdmin, insertFn) {
  try {
    const data = await insertFn();
    return { applied: true, duplicate: false, data };
  } catch (error) {
    if (isDuplicateCampaignApplicationError(error)) {
      return { applied: false, duplicate: true, data: null, error };
    }
    throw error;
  }
}

export function shouldEnforceIdempotency(options = {}) {
  if (options.skipIdempotency === true) return false;

  const refTipo = options.referencia_tipo ?? options.source_type;
  const refId = options.referencia_id ?? options.source_id;
  if (!refTipo || refId == null || String(refId).trim() === '') return false;

  if (options.tipo === PADCOINS_MOVEMENT_TYPES.ADJUST) return false;

  return IDEMPOTENT_SOURCE_TYPES.has(String(refTipo))
    || refTipo === 'reserva'
    || options.enforceIdempotency === true;
}

export function buildIdempotentSkipResult(existingMovimiento, reason = 'ya_aplicado') {
  return {
    skipped: true,
    reason,
    idempotent: true,
    monto_aplicado: 0,
    movimiento: existingMovimiento,
  };
}
