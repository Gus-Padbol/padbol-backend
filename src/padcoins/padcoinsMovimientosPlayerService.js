import { PADCOINS_MOVEMENT_TYPES } from './padcoinsConfig.js';
import { buildPaginatedPayload, parsePadcoinsPagination } from './padcoinsPagination.js';

const VALID_TIPOS = new Set(Object.values(PADCOINS_MOVEMENT_TYPES));

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

export function parsePadcoinsMovimientosPlayerFilters(query = {}) {
  return {
    tipo: parseOptionalTipo(query.tipo),
    sede_id: parseOptionalSedeId(query.sede_id ?? query.sedeId),
    referencia_tipo: parseOptionalText(query.referencia_tipo),
    referencia_id: parseOptionalText(query.referencia_id),
    fecha_desde: parseOptionalDate(query.fecha_desde ?? query.desde, 'fecha_desde'),
    fecha_hasta: parseOptionalDate(query.fecha_hasta ?? query.hasta, 'fecha_hasta'),
  };
}

async function fetchSedeMap(supabaseAdmin, sedeIds) {
  const unique = [...new Set(sedeIds.filter((id) => id != null))];
  if (!unique.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from('sedes')
    .select('id, nombre')
    .in('id', unique);

  if (error) throw error;

  return new Map((data ?? []).map((row) => [
    Number(row.id),
    String(row.nombre ?? '').trim() || null,
  ]));
}

export function mapPadcoinsMovimientoPlayerRow(row, sedeMap) {
  const sedeId = row.sede_id != null ? Number(row.sede_id) : null;
  const concepto = row.descripcion ?? null;

  return {
    id: row.id,
    tipo: row.tipo,
    monto: Number(row.monto ?? 0),
    concepto,
    descripcion: concepto,
    sede_id: sedeId,
    sede_nombre: sedeId != null ? (sedeMap.get(sedeId) ?? null) : null,
    referencia_tipo: row.referencia_tipo ?? null,
    referencia_id: row.referencia_id ?? null,
    created_at: row.created_at ?? null,
    saldo_despues: row.saldo_despues != null ? Number(row.saldo_despues) : null,
  };
}

export async function listPadcoinsMovimientosForPlayer(supabaseAdmin, userId, options = {}) {
  if (!userId || typeof userId !== 'string') {
    throw buildHttpError('userId inválido');
  }

  const query = options.query ?? {};
  const { limit, offset } = parsePadcoinsPagination({
    limit: options.limit ?? query.limit,
    offset: options.offset ?? query.offset,
  });
  const filters = options.filters ?? parsePadcoinsMovimientosPlayerFilters(query);

  let queryBuilder = supabaseAdmin
    .from('padcoins_movimientos')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false });

  if (filters.tipo) {
    queryBuilder = queryBuilder.eq('tipo', filters.tipo);
  }
  if (filters.sede_id != null) {
    queryBuilder = queryBuilder.eq('sede_id', filters.sede_id);
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

  const { data, error, count } = await queryBuilder.range(offset, offset + limit - 1);
  if (error) throw error;

  const rows = data ?? [];
  const sedeMap = await fetchSedeMap(supabaseAdmin, rows.map((row) => row.sede_id));
  const movimientos = rows.map((row) => mapPadcoinsMovimientoPlayerRow(row, sedeMap));

  return buildPaginatedPayload(movimientos, {
    limit,
    offset,
    total: count ?? rows.length,
  }, 'movimientos');
}
