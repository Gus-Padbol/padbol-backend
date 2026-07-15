import { PADCOINS_MOVEMENT_TYPES } from './padcoinsConfig.js';
import {
  resolvePadcoinsMovimientosAdminScope,
} from './padcoinsMovimientosAdminService.js';
import { CANJE_WITH_PREMIO_SELECT, mapCanjeRow } from './padcoinsCanjesInternal.js';
import {
  getPadcoinsLoyaltyLevelThresholds,
  resolvePadcoinsLoyaltyLevel,
} from './padcoinsLoyaltyLevelsService.js';
import {
  PADCOINS_CSV_MAX_EXPORT_ROWS,
  assertPadcoinsExportWithinLimit,
  buildPadcoinsCsvContent,
  buildPadcoinsCsvFilename,
} from './padcoinsCsv.js';
import { buildPaginatedPayload, parsePadcoinsPagination } from './padcoinsPagination.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const VALID_TIPOS = new Set(Object.values(PADCOINS_MOVEMENT_TYPES));
const VALID_CANJE_ESTADOS = new Set(['pendiente', 'aprobado', 'entregado', 'cancelado', 'vencido']);
const PAGE_SCAN = 1000;
const JSON_DEFAULT_LIMIT = 50;
const JSON_MAX_LIMIT = 100;

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
  if (!UUID_REGEX.test(userId)) throw buildHttpError('user_id inválido');
  return userId;
}

function parseOptionalTipo(raw) {
  if (raw == null || raw === '') return null;
  const tipo = String(raw).trim().toLowerCase();
  if (!VALID_TIPOS.has(tipo)) throw buildHttpError(`tipo inválido: ${tipo}`);
  return tipo;
}

function parseOptionalEstadoCanje(raw) {
  if (raw == null || raw === '') return null;
  const estado = String(raw).trim().toLowerCase();
  if (!VALID_CANJE_ESTADOS.has(estado)) throw buildHttpError(`estado de canje inválido: ${estado}`);
  return estado;
}

function parseOptionalText(raw) {
  if (raw == null || raw === '') return null;
  const value = String(raw).trim();
  return value || null;
}

function parseOptionalDate(raw, fieldName) {
  if (raw == null || raw === '') return null;
  const date = new Date(String(raw).trim());
  if (Number.isNaN(date.getTime())) throw buildHttpError(`${fieldName} inválida`);
  return date.toISOString();
}

function parseOptionalUuid(raw, fieldName) {
  const value = String(raw ?? '').trim();
  if (!value) return null;
  if (!UUID_REGEX.test(value)) throw buildHttpError(`${fieldName} inválido`);
  return value;
}

export function parsePadcoinsReportesFilters(query = {}) {
  const sede_id = parseOptionalSedeId(query.sede_id ?? query.sedeId);
  const user_id = parseOptionalUserId(query.user_id ?? query.jugador_id ?? query.jugadorId);
  const tipo = parseOptionalTipo(query.tipo);
  const estado_canje = parseOptionalEstadoCanje(query.estado ?? query.estado_canje);
  const campaña_id = parseOptionalUuid(query.campana_id ?? query.campaña_id ?? query.campaign_id, 'campana_id');
  const beneficio_id = parseOptionalUuid(query.beneficio_id ?? query.premio_id, 'beneficio_id');
  const nivel = parseOptionalText(query.nivel ?? query.loyalty_level);
  const fecha_desde = parseOptionalDate(query.fecha_desde ?? query.desde, 'fecha_desde');
  const fecha_hasta = parseOptionalDate(query.fecha_hasta ?? query.hasta, 'fecha_hasta');

  if (fecha_desde && fecha_hasta && fecha_desde > fecha_hasta) {
    throw buildHttpError('fecha_desde no puede ser posterior a fecha_hasta');
  }

  return {
    sede_id,
    user_id,
    tipo,
    estado_canje,
    campana_id: campaña_id,
    beneficio_id,
    nivel,
    fecha_desde,
    fecha_hasta,
  };
}

export function resolvePadcoinsReportesScope(role, requestedSedeId = null) {
  return resolvePadcoinsMovimientosAdminScope(role, requestedSedeId);
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
  const unique = [...new Set(sedeIds.filter((id) => id != null).map(Number))];
  if (!unique.length) return new Map();
  const { data, error } = await supabaseAdmin
    .from('sedes')
    .select('id, nombre')
    .in('id', unique);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [Number(row.id), String(row.nombre ?? '').trim() || null]));
}

async function fetchCampaignMap(supabaseAdmin, campaignIds) {
  const unique = [...new Set(campaignIds.filter(Boolean))];
  if (!unique.length) return new Map();
  const { data, error } = await supabaseAdmin
    .from('padcoins_campaigns')
    .select('id, name, sede_id')
    .in('id', unique);
  if (error) throw error;
  return new Map((data ?? []).map((row) => [row.id, row]));
}

function extractCampaignIdFromMovimiento(row) {
  const meta = row?.metadata;
  if (meta && typeof meta === 'object') {
    const raw = meta.campaign_id ?? meta.campana_id ?? meta.campaignId ?? null;
    if (raw) return String(raw);
  }
  return null;
}

function applyScopeToQuery(queryBuilder, scope) {
  if (scope.kind === 'sede') {
    return queryBuilder.eq('sede_id', scope.sedeId);
  }
  if (scope.sedeId != null) {
    return queryBuilder.eq('sede_id', scope.sedeId);
  }
  return queryBuilder;
}

function applyDateFilters(queryBuilder, filters, column = 'created_at') {
  let q = queryBuilder;
  if (filters.fecha_desde) q = q.gte(column, filters.fecha_desde);
  if (filters.fecha_hasta) q = q.lte(column, filters.fecha_hasta);
  return q;
}

async function scanAllRows(fetchPage) {
  const all = [];
  let offset = 0;
  for (;;) {
    const { rows, total } = await fetchPage(offset, PAGE_SCAN);
    all.push(...rows);
    if (!rows.length || all.length >= (total ?? all.length) || rows.length < PAGE_SCAN) break;
    offset += PAGE_SCAN;
    if (offset > 100_000) break;
  }
  return all;
}

export function mapPadcoinsReporteMovimientoRow(row, { jugadorMap, sedeMap, campaignMap } = {}) {
  const sedeId = row.sede_id != null ? Number(row.sede_id) : null;
  const jugador = jugadorMap?.get(row.user_id) ?? null;
  const campaignId = extractCampaignIdFromMovimiento(row);
  const campaign = campaignId ? campaignMap?.get(campaignId) : null;

  return {
    id: row.id,
    fecha: row.created_at ?? null,
    user_id: row.user_id,
    jugador_nombre: jugador?.nombre ?? null,
    jugador_email: jugador?.email ?? null,
    sede_id: sedeId,
    sede_nombre: sedeId != null ? (sedeMap?.get(sedeId) ?? null) : null,
    tipo: row.tipo,
    cantidad: Number(row.monto ?? 0),
    saldo_posterior: row.saldo_despues != null ? Number(row.saldo_despues) : null,
    origen: row.referencia_tipo ?? null,
    campana_id: campaignId,
    campana_nombre: campaign?.name ?? null,
    referencia_tipo: row.referencia_tipo ?? null,
    referencia_id: row.referencia_id ?? null,
    descripcion: row.descripcion ?? null,
  };
}

export function mapPadcoinsReporteCanjeRow(row, { jugadorMap, sedeMap } = {}) {
  const mapped = mapCanjeRow(row);
  const sedeId = mapped.sede_id != null ? Number(mapped.sede_id) : null;
  const jugador = jugadorMap?.get(mapped.user_id) ?? null;
  const cancelacionAt = mapped.estado === 'cancelado' ? (mapped.updated_at ?? null) : null;

  return {
    id: mapped.id,
    fecha: mapped.created_at ?? null,
    user_id: mapped.user_id,
    jugador_nombre: jugador?.nombre ?? null,
    jugador_email: jugador?.email ?? null,
    sede_id: sedeId,
    sede_nombre: sedeId != null ? (sedeMap?.get(sedeId) ?? null) : null,
    beneficio_id: mapped.premio_id,
    beneficio_nombre: mapped.premio_nombre,
    costo: Number(mapped.monto_padcoins ?? 0),
    codigo: mapped.codigo,
    estado: mapped.estado,
    aprobado_at: mapped.aprobado_at,
    aprobado_por: mapped.aprobado_por,
    entregado_at: mapped.entregado_at,
    entregado_por: mapped.entregado_por,
    cancelado_at: cancelacionAt,
    vencido_at: mapped.vencido_at,
    devolucion_realizada: mapped.estado === 'cancelado',
  };
}

async function listMovimientosRaw(supabaseAdmin, { scope, filters, limit, offset, countExact = true }) {
  let queryBuilder = supabaseAdmin
    .from('padcoins_movimientos')
    .select('*', countExact ? { count: 'exact' } : {})
    .order('created_at', { ascending: false });

  queryBuilder = applyScopeToQuery(queryBuilder, scope);
  queryBuilder = applyDateFilters(queryBuilder, filters);

  if (filters.user_id) queryBuilder = queryBuilder.eq('user_id', filters.user_id);
  if (filters.tipo) queryBuilder = queryBuilder.eq('tipo', filters.tipo);
  if (filters.campana_id) {
    queryBuilder = queryBuilder.contains('metadata', { campaign_id: filters.campana_id });
  }

  const { data, error, count } = await queryBuilder.range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? (data ?? []).length };
}

async function listCanjesRaw(supabaseAdmin, { scope, filters, limit, offset }) {
  let queryBuilder = supabaseAdmin
    .from('padcoins_canjes')
    .select(CANJE_WITH_PREMIO_SELECT, { count: 'exact' })
    .order('created_at', { ascending: false });

  queryBuilder = applyScopeToQuery(queryBuilder, scope);
  queryBuilder = applyDateFilters(queryBuilder, filters);

  if (filters.user_id) queryBuilder = queryBuilder.eq('user_id', filters.user_id);
  if (filters.estado_canje) queryBuilder = queryBuilder.eq('estado', filters.estado_canje);
  if (filters.beneficio_id) queryBuilder = queryBuilder.eq('premio_id', filters.beneficio_id);

  const { data, error, count } = await queryBuilder.range(offset, offset + limit - 1);
  if (error) throw error;
  return { rows: data ?? [], total: count ?? (data ?? []).length };
}

export async function getPadcoinsReportesResumen(supabaseAdmin, { role, query = {} } = {}) {
  const filters = parsePadcoinsReportesFilters(query);
  const scope = resolvePadcoinsReportesScope(role, filters.sede_id);
  if (scope.kind === 'forbidden') {
    throw buildHttpError(scope.reason ?? 'No autorizado', 403);
  }

  const movimientos = await scanAllRows((offset, limit) => listMovimientosRaw(supabaseAdmin, {
    scope,
    filters,
    limit,
    offset,
    countExact: offset === 0,
  }));

  let emitidos = 0;
  let canjeados = 0;
  let revertidos = 0;
  const campaignEarn = new Map();

  for (const row of movimientos) {
    const monto = Number(row.monto ?? 0);
    if (row.tipo === PADCOINS_MOVEMENT_TYPES.EARN) {
      emitidos += Math.max(0, monto);
      const cid = extractCampaignIdFromMovimiento(row);
      if (cid) campaignEarn.set(cid, (campaignEarn.get(cid) ?? 0) + Math.max(0, monto));
    } else if (row.tipo === PADCOINS_MOVEMENT_TYPES.SPEND) {
      canjeados += Math.abs(monto);
    } else if (row.tipo === PADCOINS_MOVEMENT_TYPES.REVERSE) {
      revertidos += Math.abs(monto);
    }
  }

  const canjesRows = await scanAllRows((offset, limit) => listCanjesRaw(supabaseAdmin, {
    scope,
    filters: { ...filters, estado_canje: filters.estado_canje },
    limit,
    offset,
  }));

  const canjesPorEstado = {
    pendiente: 0,
    aprobado: 0,
    entregado: 0,
    cancelado: 0,
    vencido: 0,
  };
  const beneficioCount = new Map();
  let costoCanjes = 0;
  let canjesConCosto = 0;

  for (const row of canjesRows) {
    const estado = String(row.estado ?? '').toLowerCase();
    if (Object.prototype.hasOwnProperty.call(canjesPorEstado, estado)) {
      canjesPorEstado[estado] += 1;
    }
    const costo = Number(row.monto_padcoins ?? 0);
    if (Number.isFinite(costo)) {
      costoCanjes += Math.abs(costo);
      canjesConCosto += 1;
    }
    const premioId = row.premio_id;
    const premioNombre = row.premios_canjeables?.nombre ?? premioId;
    if (premioId) {
      const prev = beneficioCount.get(premioId) ?? { premio_id: premioId, nombre: premioNombre, cantidad: 0 };
      prev.cantidad += 1;
      beneficioCount.set(premioId, prev);
    }
  }

  const userIdsForSede = [...new Set(movimientos.map((r) => r.user_id).filter(Boolean))];
  let disponibleTotal = 0;
  let jugadoresConSaldo = 0;
  let saldosRows = [];

  if (scope.kind === 'all' && scope.sedeId == null && !filters.fecha_desde && !filters.fecha_hasta && !filters.user_id) {
    const { data, error } = await supabaseAdmin
      .from('padcoins_saldo')
      .select('user_id, disponible, historico_total');
    if (error) throw error;
    saldosRows = data ?? [];
  } else if (userIdsForSede.length) {
    const chunkSize = 200;
    for (let i = 0; i < userIdsForSede.length; i += chunkSize) {
      const chunk = userIdsForSede.slice(i, i + chunkSize);
      const { data, error } = await supabaseAdmin
        .from('padcoins_saldo')
        .select('user_id, disponible, historico_total')
        .in('user_id', chunk);
      if (error) throw error;
      saldosRows.push(...(data ?? []));
    }
  }

  for (const row of saldosRows) {
    const disp = Number(row.disponible ?? 0);
    disponibleTotal += disp;
    if (disp > 0) jugadoresConSaldo += 1;
  }

  const thresholds = await getPadcoinsLoyaltyLevelThresholds(supabaseAdmin);
  const nivelDist = new Map();
  for (const row of saldosRows) {
    const level = resolvePadcoinsLoyaltyLevel(row.historico_total, thresholds);
    const key = level.slug;
    const prev = nivelDist.get(key) ?? {
      slug: level.slug,
      nombre: level.nombre,
      cantidad_jugadores: 0,
    };
    prev.cantidad_jugadores += 1;
    nivelDist.set(key, prev);
  }

  const campaignIds = [...campaignEarn.keys()];
  const campaignMap = await fetchCampaignMap(supabaseAdmin, campaignIds);
  const campanasMayorGeneracion = [...campaignEarn.entries()]
    .map(([id, padcoins]) => ({
      campana_id: id,
      nombre: campaignMap.get(id)?.name ?? null,
      padcoins_emitidos: padcoins,
    }))
    .sort((a, b) => b.padcoins_emitidos - a.padcoins_emitidos)
    .slice(0, 10);

  const beneficiosMasCanjeados = [...beneficioCount.values()]
    .sort((a, b) => b.cantidad - a.cantidad)
    .slice(0, 10);

  return {
    resumen: {
      padcoins_emitidos: emitidos,
      padcoins_disponibles: disponibleTotal,
      padcoins_canjeados: canjeados,
      padcoins_revertidos: revertidos,
      jugadores_con_saldo: jugadoresConSaldo,
      cantidad_movimientos: movimientos.length,
      canjes_por_estado: canjesPorEstado,
      valor_promedio_canje: canjesConCosto > 0 ? Math.round(costoCanjes / canjesConCosto) : 0,
      beneficios_mas_canjeados: beneficiosMasCanjeados,
      campanas_mayor_generacion: campanasMayorGeneracion,
      distribucion_niveles: [...nivelDist.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    },
    filtros_aplicados: {
      ...filters,
      scope: {
        kind: scope.kind,
        sede_id: scope.sedeId ?? null,
      },
    },
  };
}

export async function listPadcoinsReportesMovimientos(supabaseAdmin, {
  role,
  query = {},
  forExport = false,
} = {}) {
  const filters = parsePadcoinsReportesFilters(query);
  const scope = resolvePadcoinsReportesScope(role, filters.sede_id);
  if (scope.kind === 'forbidden') {
    throw buildHttpError(scope.reason ?? 'No autorizado', 403);
  }

  const pagination = forExport
    ? { limit: PADCOINS_CSV_MAX_EXPORT_ROWS, offset: 0 }
    : parsePadcoinsPagination(query, { defaultLimit: JSON_DEFAULT_LIMIT, maxLimit: JSON_MAX_LIMIT });

  if (forExport) {
    const probe = await listMovimientosRaw(supabaseAdmin, {
      scope, filters, limit: 1, offset: 0, countExact: true,
    });
    assertPadcoinsExportWithinLimit(probe.total);
  }

  const { rows, total } = await listMovimientosRaw(supabaseAdmin, {
    scope,
    filters,
    limit: forExport ? PADCOINS_CSV_MAX_EXPORT_ROWS : pagination.limit,
    offset: forExport ? 0 : pagination.offset,
    countExact: true,
  });

  if (forExport) assertPadcoinsExportWithinLimit(total);

  const jugadorMap = await fetchJugadorMap(supabaseAdmin, rows.map((r) => r.user_id));
  const sedeMap = await fetchSedeMap(supabaseAdmin, rows.map((r) => r.sede_id));
  const campaignMap = await fetchCampaignMap(
    supabaseAdmin,
    rows.map((r) => extractCampaignIdFromMovimiento(r)).filter(Boolean),
  );

  const movimientos = rows.map((row) => mapPadcoinsReporteMovimientoRow(row, {
    jugadorMap,
    sedeMap,
    campaignMap,
  }));

  if (forExport) {
    return {
      movimientos,
      total,
      sedeId: scope.sedeId ?? filters.sede_id ?? null,
    };
  }

  return {
    ...buildPaginatedPayload(movimientos, {
      limit: pagination.limit,
      offset: pagination.offset,
      total,
    }, 'movimientos'),
    filtros_aplicados: { ...filters, scope: { kind: scope.kind, sede_id: scope.sedeId ?? null } },
  };
}

export async function listPadcoinsReportesCanjes(supabaseAdmin, {
  role,
  query = {},
  forExport = false,
} = {}) {
  const filters = parsePadcoinsReportesFilters(query);
  const scope = resolvePadcoinsReportesScope(role, filters.sede_id);
  if (scope.kind === 'forbidden') {
    throw buildHttpError(scope.reason ?? 'No autorizado', 403);
  }

  const pagination = forExport
    ? { limit: PADCOINS_CSV_MAX_EXPORT_ROWS, offset: 0 }
    : parsePadcoinsPagination(query, { defaultLimit: JSON_DEFAULT_LIMIT, maxLimit: JSON_MAX_LIMIT });

  if (forExport) {
    const probe = await listCanjesRaw(supabaseAdmin, {
      scope, filters, limit: 1, offset: 0,
    });
    assertPadcoinsExportWithinLimit(probe.total);
  }

  const { rows, total } = await listCanjesRaw(supabaseAdmin, {
    scope,
    filters,
    limit: forExport ? PADCOINS_CSV_MAX_EXPORT_ROWS : pagination.limit,
    offset: forExport ? 0 : pagination.offset,
  });

  if (forExport) assertPadcoinsExportWithinLimit(total);

  const jugadorMap = await fetchJugadorMap(supabaseAdmin, rows.map((r) => r.user_id));
  const sedeMap = await fetchSedeMap(supabaseAdmin, rows.map((r) => r.sede_id));
  const canjes = rows.map((row) => mapPadcoinsReporteCanjeRow(row, { jugadorMap, sedeMap }));

  if (forExport) {
    return {
      canjes,
      total,
      sedeId: scope.sedeId ?? filters.sede_id ?? null,
    };
  }

  return {
    ...buildPaginatedPayload(canjes, {
      limit: pagination.limit,
      offset: pagination.offset,
      total,
    }, 'canjes'),
    filtros_aplicados: { ...filters, scope: { kind: scope.kind, sede_id: scope.sedeId ?? null } },
  };
}

export async function listPadcoinsReportesJugadores(supabaseAdmin, {
  role,
  query = {},
  forExport = false,
} = {}) {
  const filters = parsePadcoinsReportesFilters(query);
  const scope = resolvePadcoinsReportesScope(role, filters.sede_id);
  if (scope.kind === 'forbidden') {
    throw buildHttpError(scope.reason ?? 'No autorizado', 403);
  }

  const pagination = forExport
    ? { limit: PADCOINS_CSV_MAX_EXPORT_ROWS, offset: 0 }
    : parsePadcoinsPagination(query, { defaultLimit: JSON_DEFAULT_LIMIT, maxLimit: JSON_MAX_LIMIT });

  // Actividad por sede/fecha: usuarios con movimientos en alcance.
  const movimientos = await scanAllRows((offset, limit) => listMovimientosRaw(supabaseAdmin, {
    scope,
    filters: { ...filters, tipo: null },
    limit,
    offset,
    countExact: false,
  }));

  const statsByUser = new Map();
  for (const row of movimientos) {
    const uid = row.user_id;
    if (!uid) continue;
    const prev = statsByUser.get(uid) ?? {
      user_id: uid,
      sede_ids: new Set(),
      earn: 0,
      spend: 0,
      ultimo_movimiento: null,
    };
    const monto = Number(row.monto ?? 0);
    if (row.tipo === PADCOINS_MOVEMENT_TYPES.EARN) prev.earn += Math.max(0, monto);
    if (row.tipo === PADCOINS_MOVEMENT_TYPES.SPEND) prev.spend += Math.abs(monto);
    if (row.sede_id != null) prev.sede_ids.add(Number(row.sede_id));
    if (!prev.ultimo_movimiento || String(row.created_at) > String(prev.ultimo_movimiento)) {
      prev.ultimo_movimiento = row.created_at;
    }
    statsByUser.set(uid, prev);
  }

  const canjesRows = await scanAllRows((offset, limit) => listCanjesRaw(supabaseAdmin, {
    scope,
    filters: { ...filters, estado_canje: null, beneficio_id: filters.beneficio_id },
    limit,
    offset,
  }));
  const canjesByUser = new Map();
  for (const row of canjesRows) {
    const uid = row.user_id;
    if (!uid) continue;
    canjesByUser.set(uid, (canjesByUser.get(uid) ?? 0) + 1);
  }

  let userIds = [...statsByUser.keys()];
  if (filters.user_id) {
    userIds = userIds.filter((id) => id === filters.user_id);
  }

  // Si no hay actividad filtrada pero es global sin fechas, incluir saldos.
  if (!userIds.length && scope.kind === 'all' && scope.sedeId == null && !filters.fecha_desde && !filters.fecha_hasta) {
    const { data, error } = await supabaseAdmin
      .from('padcoins_saldo')
      .select('user_id')
      .limit(PADCOINS_CSV_MAX_EXPORT_ROWS + 1);
    if (error) throw error;
    userIds = (data ?? []).map((r) => r.user_id).filter(Boolean);
  }

  if (forExport) assertPadcoinsExportWithinLimit(userIds.length);

  const thresholds = await getPadcoinsLoyaltyLevelThresholds(supabaseAdmin);
  const saldos = new Map();
  const chunkSize = 200;
  for (let i = 0; i < userIds.length; i += chunkSize) {
    const chunk = userIds.slice(i, i + chunkSize);
    const { data, error } = await supabaseAdmin
      .from('padcoins_saldo')
      .select('user_id, disponible, historico_total')
      .in('user_id', chunk);
    if (error) throw error;
    for (const row of data ?? []) saldos.set(row.user_id, row);
  }

  const jugadorMap = await fetchJugadorMap(supabaseAdmin, userIds);
  const allSedeIds = [...statsByUser.values()].flatMap((s) => [...s.sede_ids]);
  const sedeMap = await fetchSedeMap(supabaseAdmin, allSedeIds);

  let jugadores = userIds.map((uid) => {
    const saldo = saldos.get(uid);
    const stats = statsByUser.get(uid);
    const historico = Number(saldo?.historico_total ?? 0);
    const level = resolvePadcoinsLoyaltyLevel(historico, thresholds);
    const sedePrincipal = stats ? [...stats.sede_ids][0] ?? null : (scope.sedeId ?? null);
    return {
      user_id: uid,
      jugador_nombre: jugadorMap.get(uid)?.nombre ?? null,
      jugador_email: jugadorMap.get(uid)?.email ?? null,
      sede_id: sedePrincipal,
      sede_nombre: sedePrincipal != null ? (sedeMap.get(Number(sedePrincipal)) ?? null) : null,
      saldo_disponible: Number(saldo?.disponible ?? 0),
      historico_total: historico,
      nivel_slug: level.slug,
      nivel_nombre: level.nombre,
      movimientos_earn: stats?.earn ?? 0,
      movimientos_spend: stats?.spend ?? 0,
      canjes_totales: canjesByUser.get(uid) ?? 0,
      ultimo_movimiento: stats?.ultimo_movimiento ?? null,
    };
  });

  if (filters.nivel) {
    const needle = String(filters.nivel).trim().toLowerCase();
    jugadores = jugadores.filter((j) => j.nivel_slug === needle || String(j.nivel_nombre).toLowerCase() === needle);
  }

  jugadores.sort((a, b) => {
    const ta = a.ultimo_movimiento || '';
    const tb = b.ultimo_movimiento || '';
    return tb.localeCompare(ta);
  });

  const total = jugadores.length;
  if (forExport) {
    assertPadcoinsExportWithinLimit(total);
    return {
      jugadores,
      total,
      sedeId: scope.sedeId ?? filters.sede_id ?? null,
    };
  }

  const pageItems = jugadores.slice(pagination.offset, pagination.offset + pagination.limit);
  return {
    ...buildPaginatedPayload(pageItems, {
      limit: pagination.limit,
      offset: pagination.offset,
      total,
    }, 'jugadores'),
    filtros_aplicados: { ...filters, scope: { kind: scope.kind, sede_id: scope.sedeId ?? null } },
  };
}

export function buildPadcoinsMovimientosCsv(movimientos) {
  const headers = [
    'fecha',
    'jugador_nombre',
    'jugador_email',
    'sede_nombre',
    'tipo',
    'cantidad',
    'saldo_posterior',
    'origen',
    'campana_nombre',
    'referencia_tipo',
    'referencia_id',
    'descripcion',
  ];
  const rows = movimientos.map((m) => ({
    fecha: m.fecha ?? '',
    jugador_nombre: m.jugador_nombre ?? '',
    jugador_email: m.jugador_email ?? '',
    sede_nombre: m.sede_nombre ?? '',
    tipo: m.tipo ?? '',
    cantidad: m.cantidad ?? '',
    saldo_posterior: m.saldo_posterior ?? '',
    origen: m.origen ?? '',
    campana_nombre: m.campana_nombre ?? '',
    referencia_tipo: m.referencia_tipo ?? '',
    referencia_id: m.referencia_id ?? '',
    descripcion: m.descripcion ?? '',
  }));
  return buildPadcoinsCsvContent(headers, rows);
}

export function buildPadcoinsCanjesCsv(canjes) {
  const headers = [
    'fecha',
    'jugador_nombre',
    'jugador_email',
    'sede_nombre',
    'beneficio_nombre',
    'costo',
    'codigo',
    'estado',
    'aprobado_at',
    'aprobado_por',
    'entregado_at',
    'entregado_por',
    'cancelado_at',
    'vencido_at',
    'devolucion_realizada',
  ];
  const rows = canjes.map((c) => ({
    fecha: c.fecha ?? '',
    jugador_nombre: c.jugador_nombre ?? '',
    jugador_email: c.jugador_email ?? '',
    sede_nombre: c.sede_nombre ?? '',
    beneficio_nombre: c.beneficio_nombre ?? '',
    costo: c.costo ?? '',
    codigo: c.codigo ?? '',
    estado: c.estado ?? '',
    aprobado_at: c.aprobado_at ?? '',
    aprobado_por: c.aprobado_por ?? '',
    entregado_at: c.entregado_at ?? '',
    entregado_por: c.entregado_por ?? '',
    cancelado_at: c.cancelado_at ?? '',
    vencido_at: c.vencido_at ?? '',
    devolucion_realizada: c.devolucion_realizada ? 'si' : 'no',
  }));
  return buildPadcoinsCsvContent(headers, rows);
}

export function buildPadcoinsJugadoresCsv(jugadores) {
  const headers = [
    'jugador_nombre',
    'jugador_email',
    'sede_nombre',
    'saldo_disponible',
    'historico_total',
    'nivel_nombre',
    'movimientos_earn',
    'movimientos_spend',
    'canjes_totales',
    'ultimo_movimiento',
  ];
  const rows = jugadores.map((j) => ({
    jugador_nombre: j.jugador_nombre ?? '',
    jugador_email: j.jugador_email ?? '',
    sede_nombre: j.sede_nombre ?? '',
    saldo_disponible: j.saldo_disponible ?? '',
    historico_total: j.historico_total ?? '',
    nivel_nombre: j.nivel_nombre ?? '',
    movimientos_earn: j.movimientos_earn ?? '',
    movimientos_spend: j.movimientos_spend ?? '',
    canjes_totales: j.canjes_totales ?? '',
    ultimo_movimiento: j.ultimo_movimiento ?? '',
  }));
  return buildPadcoinsCsvContent(headers, rows);
}

export {
  buildPadcoinsCsvFilename,
};
