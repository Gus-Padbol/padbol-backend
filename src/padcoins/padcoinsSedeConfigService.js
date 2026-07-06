const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const PADCOINS_SEDE_INACTIVE_MESSAGE = 'La sede no participa en Beneficios Padbol';

const SEDE_CONFIG_SELECT = [
  'id',
  'sede_id',
  'activo',
  'descripcion',
  'fecha_inicio',
  'fecha_fin',
  'created_at',
  'updated_at',
  'updated_by',
].join(', ');

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('padcoins_sede_config')
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function parseSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseOptionalDate(raw) {
  if (raw == null || raw === '') return null;
  const date = new Date(raw);
  if (Number.isNaN(date.getTime())) {
    throw buildHttpError('fecha inválida');
  }
  return date.toISOString();
}

function defaultSedeConfig(sedeId) {
  return {
    id: null,
    sede_id: sedeId,
    activo: false,
    descripcion: null,
    fecha_inicio: null,
    fecha_fin: null,
    created_at: null,
    updated_at: null,
    updated_by: null,
    participa: false,
  };
}

function normalizeSedeConfigRow(row, now = new Date()) {
  if (!row) return null;

  const config = {
    id: row.id ?? null,
    sede_id: Number(row.sede_id),
    activo: row.activo === true,
    descripcion: row.descripcion ?? null,
    fecha_inicio: row.fecha_inicio ?? null,
    fecha_fin: row.fecha_fin ?? null,
    created_at: row.created_at ?? null,
    updated_at: row.updated_at ?? null,
    updated_by: row.updated_by ?? null,
    participa: false,
  };

  config.participa = evaluatePadcoinsSedeParticipation(config, now);
  return config;
}

/**
 * Evalúa si una sede participa en Beneficios Padbol según config y ventana de fechas.
 * Sin fila en DB → tratar como { activo: false }.
 */
export function evaluatePadcoinsSedeParticipation(config, now = new Date()) {
  if (!config || config.activo !== true) return false;

  if (config.fecha_inicio) {
    const start = new Date(config.fecha_inicio);
    if (!Number.isNaN(start.getTime()) && start > now) return false;
  }

  if (config.fecha_fin) {
    const end = new Date(config.fecha_fin);
    if (!Number.isNaN(end.getTime()) && end < now) return false;
  }

  return true;
}

export async function getPadcoinsSedeConfig(supabaseAdmin, sedeId, { now = new Date() } = {}) {
  const sid = parseSedeId(sedeId);
  if (!sid) {
    throw buildHttpError('sede_id inválido');
  }

  try {
    const { data, error } = await supabaseAdmin
      .from('padcoins_sede_config')
      .select(SEDE_CONFIG_SELECT)
      .eq('sede_id', sid)
      .maybeSingle();

    if (error) {
      if (isMissingTable(error)) return defaultSedeConfig(sid);
      throw error;
    }

    if (!data) return defaultSedeConfig(sid);
    return normalizeSedeConfigRow(data, now);
  } catch (err) {
    if (isMissingTable(err)) return defaultSedeConfig(sid);
    throw err;
  }
}

export async function listPadcoinsSedeConfig(supabaseAdmin, { now = new Date() } = {}) {
  try {
    const { data, error } = await supabaseAdmin
      .from('padcoins_sede_config')
      .select(`${SEDE_CONFIG_SELECT}, sedes ( id, nombre )`)
      .order('sede_id', { ascending: true });

    if (error) {
      if (isMissingTable(error)) return [];
      throw error;
    }

    return (data ?? []).map((row) => {
      const config = normalizeSedeConfigRow(row, now);
      const sede = row.sedes ?? null;
      return {
        ...config,
        sede_nombre: sede?.nombre ?? null,
      };
    });
  } catch (err) {
    if (isMissingTable(err)) return [];
    throw err;
  }
}

export async function upsertPadcoinsSedeConfig(supabaseAdmin, {
  sede_id,
  activo,
  descripcion,
  fecha_inicio,
  fecha_fin,
  updated_by,
} = {}) {
  const sid = parseSedeId(sede_id);
  if (!sid) {
    throw buildHttpError('sede_id inválido');
  }

  if (typeof activo !== 'boolean') {
    throw buildHttpError('activo debe ser boolean');
  }

  if (updated_by != null && !UUID_REGEX.test(String(updated_by))) {
    throw buildHttpError('updated_by inválido');
  }

  const payload = {
    sede_id: sid,
    activo,
    descripcion: descripcion != null ? String(descripcion).trim() || null : null,
    fecha_inicio: parseOptionalDate(fecha_inicio),
    fecha_fin: parseOptionalDate(fecha_fin),
    updated_at: new Date().toISOString(),
    updated_by: updated_by ?? null,
  };

  const { data, error } = await supabaseAdmin
    .from('padcoins_sede_config')
    .upsert(payload, { onConflict: 'sede_id' })
    .select(SEDE_CONFIG_SELECT)
    .single();

  if (error) {
    if (isMissingTable(error)) {
      throw buildHttpError(
        'Tabla padcoins_sede_config no existe. Ejecutá la migración SQL primero.',
        503,
      );
    }
    throw error;
  }

  return normalizeSedeConfigRow(data);
}

export async function isPadcoinsActiveForSede(supabaseAdmin, sedeId, options = {}) {
  const config = await getPadcoinsSedeConfig(supabaseAdmin, sedeId, options);
  return config.participa === true;
}

export async function requirePadcoinsActiveForSede(supabaseAdmin, sedeId, options = {}) {
  const active = await isPadcoinsActiveForSede(supabaseAdmin, sedeId, options);
  if (!active) {
    throw buildHttpError(PADCOINS_SEDE_INACTIVE_MESSAGE, 403);
  }
  return true;
}
