import { PADCOINS_MOVEMENT_TYPES } from './padcoinsConfig.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TIPOS = new Set(Object.values(PADCOINS_MOVEMENT_TYPES));
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const MAX_SEARCH_USER_IDS = 50;

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function parseOptionalSedeId(raw) {
  if (raw == null || raw === '') return null;
  const sid = Number.parseInt(String(raw).trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function parseOptionalUserId(raw) {
  const userId = String(raw ?? '').trim();
  if (!userId) return null;
  if (!UUID_REGEX.test(userId)) {
    throw buildHttpError('user_id inválido');
  }
  return userId;
}

function parseOptionalTipo(raw) {
  if (raw == null || raw === '') return null;
  const tipo = String(raw).trim().toLowerCase();
  if (!VALID_TIPOS.has(tipo)) {
    throw buildHttpError(`tipo inválido: ${tipo}`);
  }
  return tipo;
}

function parseOptionalText(raw) {
  if (raw == null || raw === '') return null;
  const value = String(raw).trim();
  return value || null;
}

function parseOptionalDate(raw, fieldName) {
  if (raw == null || raw === '') return null;
  const date = new Date(String(raw).trim());
  if (Number.isNaN(date.getTime())) {
    throw buildHttpError(`${fieldName} inválida`);
  }
  return date.toISOString();
}

export function parsePadcoinsMovimientosAdminPagination(query = {}) {
  const limitRaw = Number.parseInt(String(query.limit ?? ''), 10);
  const limit = Number.isInteger(limitRaw) && limitRaw > 0
    ? Math.min(limitRaw, MAX_LIMIT)
    : DEFAULT_LIMIT;

  const offsetRaw = Number.parseInt(String(query.offset ?? ''), 10);
  let offset = Number.isInteger(offsetRaw) && offsetRaw >= 0 ? offsetRaw : null;

  const pageRaw = Number.parseInt(String(query.page ?? ''), 10);
  const page = Number.isInteger(pageRaw) && pageRaw > 0 ? pageRaw : null;

  if (offset == null) {
    offset = page != null ? (page - 1) * limit : 0;
  }

  return {
    limit,
    offset,
    page: page ?? Math.floor(offset / limit) + 1,
  };
}

/**
 * Alcance de auditoría PadCoins:
 * - super_admin → todas las sedes; puede filtrar sede_id
 * - admin_club → solo su sede; no puede pedir otra
 * - otros roles → prohibido
 */
export function resolvePadcoinsMovimientosAdminScope(role, requestedSedeId = null) {
  if (role?.rol === 'super_admin') {
    return {
      kind: 'all',
      sedeId: requestedSedeId,
    };
  }

  if (role?.rol === 'admin_club') {
    if (role.sede_id == null) {
      return {
        kind: 'forbidden',
        reason: 'Admin de club sin sede asignada',
      };
    }

    if (
      requestedSedeId != null
      && Number(requestedSedeId) !== Number(role.sede_id)
    ) {
      return {
        kind: 'forbidden',
        reason: 'No tenés permiso para ver movimientos de otra sede',
      };
    }

    return {
      kind: 'sede',
      sedeId: Number(role.sede_id),
    };
  }

  return {
    kind: 'forbidden',
    reason: 'No tenés permiso para auditar movimientos PadCoins',
  };
}

export function parsePadcoinsMovimientosAdminFilters(query = {}) {
  const sede_id = parseOptionalSedeId(query.sede_id ?? query.sedeId);
  const user_id = parseOptionalUserId(query.user_id ?? query.jugador_id ?? query.jugadorId);
  const tipo = parseOptionalTipo(query.tipo);
  const referencia_tipo = parseOptionalText(query.referencia_tipo);
  const referencia_id = parseOptionalText(query.referencia_id);
  const fecha_desde = parseOptionalDate(query.fecha_desde ?? query.desde, 'fecha_desde');
  const fecha_hasta = parseOptionalDate(query.fecha_hasta ?? query.hasta, 'fecha_hasta');
  const search = parseOptionalText(query.search ?? query.q);

  return {
    sede_id,
    user_id,
    tipo,
    referencia_tipo,
    referencia_id,
    fecha_desde,
    fecha_hasta,
    search,
  };
}

async function resolveUserIdsFromSearch(supabaseAdmin, search) {
  const term = String(search ?? '').trim();
  if (term.length < 2) {
    throw buildHttpError('search debe tener al menos 2 caracteres');
  }

  const escaped = term.replace(/[%_,]/g, '');
  const pattern = `%${escaped}%`;

  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('user_id')
    .or(`nombre.ilike.${pattern},apellido.ilike.${pattern},email.ilike.${pattern}`)
    .limit(MAX_SEARCH_USER_IDS);

  if (error) throw error;

  const ids = [...new Set((data ?? []).map((row) => row.user_id).filter(Boolean))];
  return ids;
}

async function fetchJugadorMap(supabaseAdmin, userIds) {
  const unique = [...new Set(userIds.filter(Boolean))];
  if (!unique.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('user_id, nombre, apellido, email')
    .in('user_id', unique);

  if (error) throw error;

  return new Map((data ?? []).map((row) => {
    const nombre = [row.nombre, row.apellido].filter(Boolean).join(' ').trim() || null;
    return [row.user_id, {
      user_id: row.user_id,
      nombre,
      email: row.email ?? null,
    }];
  }));
}

async function fetchSedeMap(supabaseAdmin, sedeIds) {
  const unique = [...new Set(sedeIds.filter((id) => id != null))];
  if (!unique.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from('sedes')
    .select('id, nombre')
    .in('id', unique);

  if (error) throw error;

  return new Map((data ?? []).map((row) => [Number(row.id), String(row.nombre ?? '').trim() || null]));
}

export function mapPadcoinsMovimientoAdminRow(row, jugadorMap, sedeMap) {
  const sedeId = row.sede_id != null ? Number(row.sede_id) : null;
  const jugador = jugadorMap.get(row.user_id) ?? null;

  return {
    id: row.id,
    fecha: row.created_at ?? null,
    user_id: row.user_id,
    jugador,
    tipo: row.tipo,
    monto: Number(row.monto ?? 0),
    descripcion: row.descripcion ?? null,
    sede_id: sedeId,
    sede_nombre: sedeId != null ? (sedeMap.get(sedeId) ?? null) : null,
    referencia_tipo: row.referencia_tipo ?? null,
    referencia_id: row.referencia_id ?? null,
    saldo_resultante: row.saldo_despues != null ? Number(row.saldo_despues) : null,
    created_by: row.created_by ?? null,
  };
}

export async function listPadcoinsMovimientosAdmin(supabaseAdmin, {
  role,
  query = {},
} = {}) {
  const filters = parsePadcoinsMovimientosAdminFilters(query);
  const pagination = parsePadcoinsMovimientosAdminPagination(query);
  const scope = resolvePadcoinsMovimientosAdminScope(role, filters.sede_id);

  if (scope.kind === 'forbidden') {
    throw buildHttpError(scope.reason ?? 'No autorizado', 403);
  }

  let queryBuilder = supabaseAdmin
    .from('padcoins_movimientos')
    .select('*', { count: 'exact' })
    .order('created_at', { ascending: false });

  if (scope.kind === 'sede') {
    queryBuilder = queryBuilder.eq('sede_id', scope.sedeId);
  } else if (scope.sedeId != null) {
    queryBuilder = queryBuilder.eq('sede_id', scope.sedeId);
  }

  if (filters.user_id) {
    queryBuilder = queryBuilder.eq('user_id', filters.user_id);
  }

  if (filters.tipo) {
    queryBuilder = queryBuilder.eq('tipo', filters.tipo);
  }

  if (filters.referencia_tipo) {
    queryBuilder = queryBuilder.eq('referencia_tipo', filters.referencia_tipo);
  }

  if (filters.referencia_id) {
    queryBuilder = queryBuilder.eq('referencia_id', filters.referencia_id);
  }

  if (filters.fecha_desde) {
    queryBuilder = queryBuilder.gte('created_at', filters.fecha_desde);
  }

  if (filters.fecha_hasta) {
    queryBuilder = queryBuilder.lte('created_at', filters.fecha_hasta);
  }

  if (filters.search) {
    const userIds = await resolveUserIdsFromSearch(supabaseAdmin, filters.search);
    if (!userIds.length) {
      return {
        movimientos: [],
        paginacion: {
          limit: pagination.limit,
          offset: pagination.offset,
          page: pagination.page,
          total: 0,
        },
        filtros_aplicados: {
          ...filters,
          scope,
        },
      };
    }
    queryBuilder = queryBuilder.in('user_id', userIds);
  }

  const { data, error, count } = await queryBuilder.range(
    pagination.offset,
    pagination.offset + pagination.limit - 1,
  );

  if (error) throw error;

  const rows = data ?? [];
  const jugadorMap = await fetchJugadorMap(supabaseAdmin, rows.map((row) => row.user_id));
  const sedeMap = await fetchSedeMap(supabaseAdmin, rows.map((row) => row.sede_id));

  return {
    movimientos: rows.map((row) => mapPadcoinsMovimientoAdminRow(row, jugadorMap, sedeMap)),
    paginacion: {
      limit: pagination.limit,
      offset: pagination.offset,
      page: pagination.page,
      total: count ?? rows.length,
    },
    filtros_aplicados: {
      ...filters,
      scope,
    },
  };
}
