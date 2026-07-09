import { TIPOS_ACEPTACION } from './jugadorIdentidadConfig.js';

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

function assertUserId(userId) {
  const id = String(userId ?? '').trim();
  if (!UUID_REGEX.test(id)) {
    const err = new Error('userId inválido');
    err.code = 'USER_ID_INVALIDO';
    throw err;
  }
  return id;
}

function validationError(message, code) {
  const err = new Error(message);
  err.code = code ?? 'VALIDACION_ACEPTACION';
  err.status = 400;
  throw err;
}

function normalizeTorneoId(raw) {
  if (raw == null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    validationError('torneo_id inválido', 'TORNEO_ID_INVALIDO');
  }
  return parsed;
}

function mapAceptacionRow(row) {
  return {
    id: row.id,
    tipo: row.tipo,
    version: row.version,
    torneo_id: row.torneo_id ?? null,
    aceptado_at: row.aceptado_at,
  };
}

export async function listAceptaciones(supabaseAdmin, userId) {
  const uid = assertUserId(userId);

  const { data, error } = await supabaseAdmin
    .from('jugadores_aceptaciones')
    .select('id, user_id, tipo, version, torneo_id, aceptado_at')
    .eq('user_id', uid)
    .order('aceptado_at', { ascending: false });

  if (error) {
    if (isMissingTable(error)) {
      const err = new Error('Tabla jugadores_aceptaciones no disponible. Ejecutar migración SQL.');
      err.code = 'ACEPTACIONES_TABLA_NO_DISPONIBLE';
      err.status = 503;
      throw err;
    }
    throw error;
  }

  return (data ?? []).map(mapAceptacionRow);
}

async function findExistingAceptacion(supabaseAdmin, userId, { tipo, version, torneoId }) {
  let query = supabaseAdmin
    .from('jugadores_aceptaciones')
    .select('id, user_id, tipo, version, torneo_id, aceptado_at, ip, user_agent')
    .eq('user_id', userId)
    .eq('tipo', tipo)
    .eq('version', version)
    .limit(1);

  if (torneoId == null) {
    query = query.is('torneo_id', null);
  } else {
    query = query.eq('torneo_id', torneoId);
  }

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function registrarAceptacion(supabaseAdmin, userId, payload = {}, requestMeta = {}) {
  const uid = assertUserId(userId);

  const tipo = String(payload.tipo ?? '').trim().toLowerCase();
  const version = String(payload.version ?? '').trim();
  const torneoId = normalizeTorneoId(payload.torneo_id);

  if (!TIPOS_ACEPTACION.includes(tipo)) {
    validationError(
      `tipo inválido. Permitidos: ${TIPOS_ACEPTACION.join(', ')}`,
      'TIPO_ACEPTACION_INVALIDO',
    );
  }

  if (!version || version.length > 64) {
    validationError('version requerida (máx. 64 caracteres)', 'VERSION_INVALIDA');
  }

  if (tipo === 'reglamento_torneo' && torneoId == null) {
    validationError('torneo_id requerido para reglamento_torneo', 'TORNEO_ID_REQUERIDO');
  }

  const existing = await findExistingAceptacion(supabaseAdmin, uid, {
    tipo,
    version,
    torneoId,
  });

  if (existing?.id) {
    return {
      ...mapAceptacionRow(existing),
      idempotent: true,
      already_accepted: true,
    };
  }

  const insertRow = {
    user_id: uid,
    tipo,
    version,
    torneo_id: torneoId,
    aceptado_at: new Date().toISOString(),
    ip: requestMeta.ip ? String(requestMeta.ip).slice(0, 64) : null,
    user_agent: requestMeta.userAgent ? String(requestMeta.userAgent).slice(0, 512) : null,
  };

  const { data, error } = await supabaseAdmin
    .from('jugadores_aceptaciones')
    .insert(insertRow)
    .select('id, user_id, tipo, version, torneo_id, aceptado_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      const dup = await findExistingAceptacion(supabaseAdmin, uid, { tipo, version, torneoId });
      if (dup) {
        return {
          ...mapAceptacionRow(dup),
          idempotent: true,
          already_accepted: true,
        };
      }
    }
    if (isMissingTable(error)) {
      const err = new Error('Tabla jugadores_aceptaciones no disponible. Ejecutar migración SQL.');
      err.code = 'ACEPTACIONES_TABLA_NO_DISPONIBLE';
      err.status = 503;
      throw err;
    }
    throw error;
  }

  return {
    ...mapAceptacionRow(data),
    idempotent: false,
    already_accepted: false,
  };
}
