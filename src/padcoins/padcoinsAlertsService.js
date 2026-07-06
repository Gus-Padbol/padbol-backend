import { PADCOINS_MOVEMENT_TYPES, PADCOINS_ORIGINS } from './padcoinsConfig.js';

export const PADCOINS_ALERT_TYPES = {
  AJUSTES_MANUALES_EXCESIVOS: 'ajustes_manuales_excesivos',
  CANJES_SOSPECHOSOS: 'canjes_sospechosos',
  RESERVAS_PADCOINS_POCO_CREIBLE: 'reservas_padcoins_poco_creible',
  PENALIZACIONES_REVERSAS_ANORMALES: 'penalizaciones_reversas_anormales',
  CAMPANIA_IDENTIFICADA: 'campania_identificada',
};

export const PADCOINS_ALERT_SEVERITIES = {
  BAJA: 'baja',
  MEDIA: 'media',
  ALTA: 'alta',
};

const DEFAULT_PERIOD_DAYS = 7;
const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

const SEVERITY_ORDER = {
  alta: 3,
  media: 2,
  baja: 1,
};

export const PADCOINS_ALERT_THRESHOLDS = {
  ajustes_manuales_excesivos: {
    min_count: 5,
    min_total: 1500,
    repeat_user_count: 3,
    alta_count: 12,
    alta_total: 5000,
  },
  canjes_sospechosos: {
    min_count_24h: 8,
    min_low_cost_count: 5,
    low_cost_threshold: 80,
    repeat_user_count: 3,
    alta_count_24h: 15,
  },
  reservas_padcoins_poco_creible: {
    min_unclear_count: 3,
    min_unclear_total: 500,
    earn_vs_reserva_ratio: 3,
    expected_per_reserva: 400,
  },
  penalizaciones_reversas_anormales: {
    min_penalties: 8,
    min_reverses: 5,
    alta_penalties: 15,
    alta_reverses: 10,
  },
};

const CAMPANIA_KEYWORDS = [
  'campaña',
  'campana',
  'marketing',
  'promocional',
  'promo',
  'justificado',
];

const CLEAR_EARN_REFERENCIAS = new Set([
  'reserva',
  'logro',
  PADCOINS_ORIGINS.PENALIZACION,
  PADCOINS_ORIGINS.BONUS_ADMIN,
  PADCOINS_ORIGINS.CANJE_PREMIO,
]);

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

function parseOptionalDate(raw, fieldName) {
  if (raw == null || raw === '') return null;
  const date = new Date(String(raw).trim());
  if (Number.isNaN(date.getTime())) {
    throw buildHttpError(`${fieldName} inválida`);
  }
  return date.toISOString();
}

export function parsePadcoinsAlertasPagination(query = {}) {
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

export function parsePadcoinsAlertasFilters(query = {}) {
  return {
    sede_id: parseOptionalSedeId(query.sede_id ?? query.sedeId),
    fecha_desde: parseOptionalDate(query.fecha_desde ?? query.desde, 'fecha_desde'),
    fecha_hasta: parseOptionalDate(query.fecha_hasta ?? query.hasta, 'fecha_hasta'),
    severidad: query.severidad ? String(query.severidad).trim().toLowerCase() : null,
    tipo_alerta: query.tipo_alerta ? String(query.tipo_alerta).trim() : null,
  };
}

export function assertPadcoinsAlertasSuperAdminAccess(role) {
  if (role?.rol !== 'super_admin') {
    throw buildHttpError('Solo super_admin puede consultar alertas PadCoins', 403);
  }
}

export function resolvePadcoinsAlertPeriod(options = {}) {
  const hastaDate = options.fecha_hasta
    ? new Date(options.fecha_hasta)
    : (options.now ? new Date(options.now) : new Date());
  const desdeDate = options.fecha_desde
    ? new Date(options.fecha_desde)
    : new Date(hastaDate.getTime() - DEFAULT_PERIOD_DAYS * 24 * 60 * 60 * 1000);

  return {
    desde: desdeDate.toISOString(),
    hasta: hastaDate.toISOString(),
    dias: Math.max(1, Math.ceil((hastaDate.getTime() - desdeDate.getTime()) / (24 * 60 * 60 * 1000))),
  };
}

export function isCampaniaDescripcion(descripcion) {
  const text = String(descripcion ?? '').trim().toLowerCase();
  if (!text) return false;
  return CAMPANIA_KEYWORDS.some((keyword) => text.includes(keyword));
}

export function getPadcoinsAlertSeverity(tipoAlerta, metricas = {}) {
  const thresholds = PADCOINS_ALERT_THRESHOLDS[tipoAlerta] ?? {};

  if (tipoAlerta === PADCOINS_ALERT_TYPES.CAMPANIA_IDENTIFICADA) {
    return PADCOINS_ALERT_SEVERITIES.BAJA;
  }

  if (tipoAlerta === PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS) {
    if (
      metricas.count >= thresholds.alta_count
      || metricas.total_monto >= thresholds.alta_total
      || metricas.max_repeat_user_count >= thresholds.repeat_user_count + 2
    ) {
      return PADCOINS_ALERT_SEVERITIES.ALTA;
    }
    if (
      metricas.count >= thresholds.min_count
      || metricas.total_monto >= thresholds.min_total
      || metricas.max_repeat_user_count >= thresholds.repeat_user_count
    ) {
      return PADCOINS_ALERT_SEVERITIES.MEDIA;
    }
    return PADCOINS_ALERT_SEVERITIES.BAJA;
  }

  if (tipoAlerta === PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS) {
    if (
      metricas.count_24h >= thresholds.alta_count_24h
      || metricas.repeat_user_count >= thresholds.repeat_user_count + 2
    ) {
      return PADCOINS_ALERT_SEVERITIES.ALTA;
    }
    if (
      metricas.count >= thresholds.min_count_24h
      || metricas.low_cost_count >= thresholds.min_low_cost_count
      || metricas.repeat_user_count >= thresholds.repeat_user_count
    ) {
      return PADCOINS_ALERT_SEVERITIES.MEDIA;
    }
    return PADCOINS_ALERT_SEVERITIES.BAJA;
  }

  if (tipoAlerta === PADCOINS_ALERT_TYPES.RESERVAS_PADCOINS_POCO_CREIBLE) {
    if (
      metricas.unclear_total >= thresholds.min_unclear_total * 3
      || metricas.ratio_exceso >= thresholds.earn_vs_reserva_ratio * 2
    ) {
      return PADCOINS_ALERT_SEVERITIES.ALTA;
    }
    if (
      metricas.unclear_count >= thresholds.min_unclear_count
      || metricas.ratio_exceso >= thresholds.earn_vs_reserva_ratio
    ) {
      return PADCOINS_ALERT_SEVERITIES.MEDIA;
    }
    return PADCOINS_ALERT_SEVERITIES.BAJA;
  }

  if (tipoAlerta === PADCOINS_ALERT_TYPES.PENALIZACIONES_REVERSAS_ANORMALES) {
    if (
      metricas.penalties_count >= thresholds.alta_penalties
      || metricas.reverses_count >= thresholds.alta_reverses
    ) {
      return PADCOINS_ALERT_SEVERITIES.ALTA;
    }
    if (
      metricas.penalties_count >= thresholds.min_penalties
      || metricas.reverses_count >= thresholds.min_reverses
    ) {
      return PADCOINS_ALERT_SEVERITIES.MEDIA;
    }
    return PADCOINS_ALERT_SEVERITIES.BAJA;
  }

  return PADCOINS_ALERT_SEVERITIES.BAJA;
}

export function getPadcoinsAlertReason(tipoAlerta, metricas = {}) {
  switch (tipoAlerta) {
    case PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS:
      return `Detectados ${metricas.count} ajustes positivos (${metricas.total_monto} PC) sin marcador de campaña; máx. repetición jugador: ${metricas.max_repeat_user_count}.`;
    case PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS:
      return `Detectados ${metricas.count} canjes (${metricas.count_24h} en 24h), ${metricas.low_cost_count} de bajo costo y ${metricas.repeat_user_count} jugadores con canjes repetidos.`;
    case PADCOINS_ALERT_TYPES.RESERVAS_PADCOINS_POCO_CREIBLE:
      return `Acreditaciones positivas (${metricas.earn_total} PC) con ${metricas.unclear_count} sin referencia clara; ratio sobre reservas: ${metricas.ratio_exceso}.`;
    case PADCOINS_ALERT_TYPES.PENALIZACIONES_REVERSAS_ANORMALES:
      return `Detectadas ${metricas.penalties_count} penalizaciones y ${metricas.reverses_count} reversas en el periodo.`;
    case PADCOINS_ALERT_TYPES.CAMPANIA_IDENTIFICADA:
      return `Se identificaron ${metricas.count} movimientos con marcador de campaña/marketing en descripción.`;
    default:
      return 'Uso anormal de PadCoins detectado.';
  }
}

export function buildPadcoinsAlert({
  tipoAlerta,
  severidad,
  sedeId,
  sedeNombre,
  metricas,
  periodo,
  movimientosRelacionados = [],
  recomendacion,
}) {
  const descripcion = getPadcoinsAlertReason(tipoAlerta, metricas);

  return {
    id: `${sedeId}:${tipoAlerta}:${periodo.desde}:${periodo.hasta}`,
    tipo_alerta: tipoAlerta,
    severidad,
    sede_id: sedeId,
    sede_nombre: sedeNombre ?? null,
    descripcion,
    metricas,
    periodo,
    movimientos_relacionados: movimientosRelacionados,
    recomendacion: recomendacion ?? defaultRecomendacion(tipoAlerta),
    calculado_en: new Date().toISOString(),
  };
}

function defaultRecomendacion(tipoAlerta) {
  switch (tipoAlerta) {
    case PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS:
      return 'Revisar ajustes admin de la sede. Si es promoción legítima, documentar campaña en descripción (Fase 2: metadata dedicada). No bloquea automáticamente.';
    case PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS:
      return 'Auditar premios de bajo costo y canjes repetidos del mismo jugador. Verificar stock y reglas de canje.';
    case PADCOINS_ALERT_TYPES.RESERVAS_PADCOINS_POCO_CREIBLE:
      return 'Contrastar acreditaciones con reservas completadas y movimientos sin referencia. Revisar configuración proporcional.';
    case PADCOINS_ALERT_TYPES.PENALIZACIONES_REVERSAS_ANORMALES:
      return 'Revisar volumen de penalizaciones y reversas de canje. Puede indicar fricción operativa o abuso.';
    case PADCOINS_ALERT_TYPES.CAMPANIA_IDENTIFICADA:
      return 'Movimiento promocional identificado por texto. Fase 2: campo campaña/metadata formal para excluir de alertas abusivas.';
    default:
      return 'Revisar actividad PadCoins de la sede. Super Admin supervisa; no reemplaza reclamos diarios de sede.';
  }
}

function countByUser(rows, key = 'user_id') {
  const map = new Map();
  for (const row of rows) {
    const uid = row[key];
    if (!uid) continue;
    map.set(uid, (map.get(uid) ?? 0) + 1);
  }
  return map;
}

function maxMapValue(map) {
  let max = 0;
  for (const value of map.values()) {
    if (value > max) max = value;
  }
  return max;
}

function sumMonto(rows) {
  return rows.reduce((sum, row) => sum + Math.abs(Number(row.monto ?? row.monto_padcoins ?? 0)), 0);
}

function mapMovimientoRef(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    tipo: row.tipo,
    monto: Number(row.monto ?? 0),
    referencia_tipo: row.referencia_tipo ?? null,
    referencia_id: row.referencia_id ?? null,
    created_at: row.created_at ?? null,
  };
}

function mapCanjeRef(row) {
  return {
    id: row.id,
    user_id: row.user_id,
    monto_padcoins: Number(row.monto_padcoins ?? 0),
    estado: row.estado ?? null,
    premio_nombre: row.premios_canjeables?.nombre ?? null,
    costo_padcoins: row.premios_canjeables?.costo_padcoins ?? null,
    created_at: row.created_at ?? null,
  };
}

export function evaluateAjustesManualesAlert(movimientos, { sedeId, sedeNombre, periodo }) {
  const adjusts = movimientos.filter(
    (row) => row.tipo === PADCOINS_MOVEMENT_TYPES.ADJUST && Number(row.monto) > 0,
  );
  const campanias = adjusts.filter((row) => isCampaniaDescripcion(row.descripcion));
  const suspicious = adjusts.filter((row) => !isCampaniaDescripcion(row.descripcion));

  const alerts = [];

  if (campanias.length > 0) {
    alerts.push(buildPadcoinsAlert({
      tipoAlerta: PADCOINS_ALERT_TYPES.CAMPANIA_IDENTIFICADA,
      severidad: PADCOINS_ALERT_SEVERITIES.BAJA,
      sedeId,
      sedeNombre,
      metricas: {
        count: campanias.length,
        total_monto: sumMonto(campanias),
      },
      periodo,
      movimientosRelacionados: campanias.slice(0, 10).map(mapMovimientoRef),
    }));
  }

  if (!suspicious.length) return alerts;

  const repeatMap = countByUser(suspicious);
  const metricas = {
    count: suspicious.length,
    total_monto: sumMonto(suspicious),
    max_repeat_user_count: maxMapValue(repeatMap),
    campanias_excluidas: campanias.length,
  };

  const thresholds = PADCOINS_ALERT_THRESHOLDS.ajustes_manuales_excesivos;
  const triggered = metricas.count >= thresholds.min_count
    || metricas.total_monto >= thresholds.min_total
    || metricas.max_repeat_user_count >= thresholds.repeat_user_count;

  if (!triggered) return alerts;

  const severidad = getPadcoinsAlertSeverity(
    PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS,
    metricas,
  );

  alerts.push(buildPadcoinsAlert({
    tipoAlerta: PADCOINS_ALERT_TYPES.AJUSTES_MANUALES_EXCESIVOS,
    severidad,
    sedeId,
    sedeNombre,
    metricas,
    periodo,
    movimientosRelacionados: suspicious.slice(0, 15).map(mapMovimientoRef),
  }));

  return alerts;
}

export function evaluateCanjesSospechososAlert(canjes, { sedeId, sedeNombre, periodo, now = new Date() }) {
  if (!canjes.length) return [];

  const nowMs = new Date(now).getTime();
  const dayMs = 24 * 60 * 60 * 1000;
  const count24h = canjes.filter((row) => {
    const created = new Date(row.created_at).getTime();
    return Number.isFinite(created) && (nowMs - created) <= dayMs;
  }).length;

  const lowCost = canjes.filter((row) => {
    const costo = Number(row.premios_canjeables?.costo_padcoins ?? row.monto_padcoins ?? 0);
    return costo > 0 && costo <= PADCOINS_ALERT_THRESHOLDS.canjes_sospechosos.low_cost_threshold;
  });

  const repeatMap = countByUser(canjes);
  const metricas = {
    count: canjes.length,
    count_24h: count24h,
    low_cost_count: lowCost.length,
    repeat_user_count: maxMapValue(repeatMap),
    total_monto: sumMonto(canjes),
  };

  const thresholds = PADCOINS_ALERT_THRESHOLDS.canjes_sospechosos;
  const triggered = metricas.count_24h >= thresholds.min_count_24h
    || metricas.low_cost_count >= thresholds.min_low_cost_count
    || metricas.repeat_user_count >= thresholds.repeat_user_count;

  if (!triggered) return [];

  return [buildPadcoinsAlert({
    tipoAlerta: PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS,
    severidad: getPadcoinsAlertSeverity(PADCOINS_ALERT_TYPES.CANJES_SOSPECHOSOS, metricas),
    sedeId,
    sedeNombre,
    metricas,
    periodo,
    movimientosRelacionados: canjes.slice(0, 15).map(mapCanjeRef),
  })];
}

export function evaluateReservasPadcoinsAlert(movimientos, { sedeId, sedeNombre, periodo }) {
  const earns = movimientos.filter(
    (row) => row.tipo === PADCOINS_MOVEMENT_TYPES.EARN && Number(row.monto) > 0,
  );
  if (!earns.length) return [];

  const reservaEarns = earns.filter((row) => row.referencia_tipo === 'reserva');
  const unclearEarns = earns.filter((row) => {
    const ref = String(row.referencia_tipo ?? '').trim().toLowerCase();
    const refId = String(row.referencia_id ?? '').trim();
    if (!ref || !refId) return true;
    return !CLEAR_EARN_REFERENCIAS.has(ref);
  });

  const earnTotal = sumMonto(earns);
  const expectedFromReservas = reservaEarns.length
    * PADCOINS_ALERT_THRESHOLDS.reservas_padcoins_poco_creible.expected_per_reserva;
  const ratioExceso = expectedFromReservas > 0
    ? Number((earnTotal / expectedFromReservas).toFixed(2))
    : (unclearEarns.length > 0 ? 99 : 0);

  const metricas = {
    earn_total: earnTotal,
    reserva_earn_count: reservaEarns.length,
    unclear_count: unclearEarns.length,
    unclear_total: sumMonto(unclearEarns),
    ratio_exceso: ratioExceso,
  };

  const thresholds = PADCOINS_ALERT_THRESHOLDS.reservas_padcoins_poco_creible;
  const triggered = metricas.unclear_count >= thresholds.min_unclear_count
    || metricas.unclear_total >= thresholds.min_unclear_total
    || metricas.ratio_exceso >= thresholds.earn_vs_reserva_ratio;

  if (!triggered) return [];

  return [buildPadcoinsAlert({
    tipoAlerta: PADCOINS_ALERT_TYPES.RESERVAS_PADCOINS_POCO_CREIBLE,
    severidad: getPadcoinsAlertSeverity(
      PADCOINS_ALERT_TYPES.RESERVAS_PADCOINS_POCO_CREIBLE,
      metricas,
    ),
    sedeId,
    sedeNombre,
    metricas,
    periodo,
    movimientosRelacionados: [...unclearEarns, ...reservaEarns]
      .slice(0, 15)
      .map(mapMovimientoRef),
  })];
}

export function evaluatePenalizacionesReversasAlert(movimientos, { sedeId, sedeNombre, periodo }) {
  const penalties = movimientos.filter(
    (row) => row.referencia_tipo === PADCOINS_ORIGINS.PENALIZACION
      || (row.tipo === PADCOINS_MOVEMENT_TYPES.SPEND
        && String(row.descripcion ?? '').toLowerCase().includes('penalización')),
  );
  const reverses = movimientos.filter((row) => row.tipo === PADCOINS_MOVEMENT_TYPES.REVERSE);

  const metricas = {
    penalties_count: penalties.length,
    reverses_count: reverses.length,
    penalties_total: sumMonto(penalties),
    reverses_total: sumMonto(reverses),
  };

  const thresholds = PADCOINS_ALERT_THRESHOLDS.penalizaciones_reversas_anormales;
  const triggered = metricas.penalties_count >= thresholds.min_penalties
    || metricas.reverses_count >= thresholds.min_reverses;

  if (!triggered) return [];

  return [buildPadcoinsAlert({
    tipoAlerta: PADCOINS_ALERT_TYPES.PENALIZACIONES_REVERSAS_ANORMALES,
    severidad: getPadcoinsAlertSeverity(
      PADCOINS_ALERT_TYPES.PENALIZACIONES_REVERSAS_ANORMALES,
      metricas,
    ),
    sedeId,
    sedeNombre,
    metricas,
    periodo,
    movimientosRelacionados: [...penalties, ...reverses].slice(0, 15).map(mapMovimientoRef),
  })];
}

export async function fetchMovimientosForAlertPeriod(supabaseAdmin, sedeId, periodo) {
  const { data, error } = await supabaseAdmin
    .from('padcoins_movimientos')
    .select('id, user_id, tipo, monto, referencia_tipo, referencia_id, descripcion, created_at, sede_id')
    .eq('sede_id', sedeId)
    .gte('created_at', periodo.desde)
    .lte('created_at', periodo.hasta);

  if (error) throw error;
  return data ?? [];
}

export async function fetchCanjesForAlertPeriod(supabaseAdmin, sedeId, periodo) {
  const { data, error } = await supabaseAdmin
    .from('padcoins_canjes')
    .select('id, user_id, sede_id, premio_id, monto_padcoins, estado, created_at, premios_canjeables ( nombre, costo_padcoins )')
    .eq('sede_id', sedeId)
    .gte('created_at', periodo.desde)
    .lte('created_at', periodo.hasta);

  if (error) throw error;
  return data ?? [];
}

async function fetchSedeNombreMap(supabaseAdmin, sedeIds) {
  const unique = [...new Set(sedeIds.filter((id) => id != null))];
  if (!unique.length) return new Map();

  const { data, error } = await supabaseAdmin
    .from('sedes')
    .select('id, nombre')
    .in('id', unique);

  if (error) throw error;

  return new Map((data ?? []).map((row) => [Number(row.id), String(row.nombre ?? '').trim() || null]));
}

async function resolveSedeIdsForEvaluation(supabaseAdmin, periodo, sedeIdFilter = null) {
  if (sedeIdFilter != null) return [sedeIdFilter];

  const queries = await Promise.all([
    supabaseAdmin
      .from('padcoins_movimientos')
      .select('sede_id')
      .not('sede_id', 'is', null)
      .gte('created_at', periodo.desde)
      .lte('created_at', periodo.hasta),
    supabaseAdmin
      .from('padcoins_canjes')
      .select('sede_id')
      .gte('created_at', periodo.desde)
      .lte('created_at', periodo.hasta),
  ]);

  for (const result of queries) {
    if (result.error) throw result.error;
  }

  const ids = new Set();
  for (const row of queries.flatMap((result) => result.data ?? [])) {
    if (row.sede_id != null) ids.add(Number(row.sede_id));
  }

  return [...ids].sort((a, b) => a - b);
}

export async function evaluarAlertasPadcoinsPorSede(supabaseAdmin, sedeId, options = {}) {
  const parsedSedeId = Number.parseInt(String(sedeId ?? ''), 10);
  if (!Number.isFinite(parsedSedeId) || parsedSedeId <= 0) {
    throw buildHttpError('sede_id inválido');
  }

  const periodo = resolvePadcoinsAlertPeriod(options);
  const sedeNombre = options.sedeNombre ?? null;

  const [movimientos, canjes] = await Promise.all([
    options.movimientos ?? fetchMovimientosForAlertPeriod(supabaseAdmin, parsedSedeId, periodo),
    options.canjes ?? fetchCanjesForAlertPeriod(supabaseAdmin, parsedSedeId, periodo),
  ]);

  const context = {
    sedeId: parsedSedeId,
    sedeNombre,
    periodo,
    now: options.now,
  };

  return [
    ...evaluateAjustesManualesAlert(movimientos, context),
    ...evaluateCanjesSospechososAlert(canjes, context),
    ...evaluateReservasPadcoinsAlert(movimientos, context),
    ...evaluatePenalizacionesReversasAlert(movimientos, context),
  ];
}

export async function evaluarAlertasPadcoinsGlobal(supabaseAdmin, options = {}) {
  const periodo = resolvePadcoinsAlertPeriod(options);
  const sedeIds = await resolveSedeIdsForEvaluation(
    supabaseAdmin,
    periodo,
    options.sede_id ?? null,
  );

  const sedeMap = await fetchSedeNombreMap(supabaseAdmin, sedeIds);
  const alertas = [];

  for (const sedeId of sedeIds) {
    const sedeAlertas = await evaluarAlertasPadcoinsPorSede(supabaseAdmin, sedeId, {
      ...options,
      sedeNombre: sedeMap.get(sedeId) ?? null,
      fecha_desde: periodo.desde,
      fecha_hasta: periodo.hasta,
    });
    alertas.push(...sedeAlertas);
  }

  return alertas.sort((a, b) => {
    const sev = (SEVERITY_ORDER[b.severidad] ?? 0) - (SEVERITY_ORDER[a.severidad] ?? 0);
    if (sev !== 0) return sev;
    return Number(a.sede_id) - Number(b.sede_id);
  });
}

function applyAlertPostFilters(alertas, filters = {}) {
  let result = [...alertas];

  if (filters.sede_id != null) {
    result = result.filter((alert) => Number(alert.sede_id) === Number(filters.sede_id));
  }
  if (filters.severidad) {
    result = result.filter((alert) => alert.severidad === filters.severidad);
  }
  if (filters.tipo_alerta) {
    result = result.filter((alert) => alert.tipo_alerta === filters.tipo_alerta);
  }

  return result;
}

export async function listPadcoinsAlertasAdmin(supabaseAdmin, { role, query = {} } = {}) {
  assertPadcoinsAlertasSuperAdminAccess(role);

  const filters = parsePadcoinsAlertasFilters(query);
  const pagination = parsePadcoinsAlertasPagination(query);
  const periodo = resolvePadcoinsAlertPeriod({
    fecha_desde: filters.fecha_desde,
    fecha_hasta: filters.fecha_hasta,
  });

  const alertas = await evaluarAlertasPadcoinsGlobal(supabaseAdmin, {
    sede_id: filters.sede_id,
    fecha_desde: periodo.desde,
    fecha_hasta: periodo.hasta,
  });

  const filtered = applyAlertPostFilters(alertas, filters);
  const slice = filtered.slice(pagination.offset, pagination.offset + pagination.limit);

  return {
    alertas: slice,
    paginacion: {
      limit: pagination.limit,
      offset: pagination.offset,
      page: pagination.page,
      total: filtered.length,
    },
    filtros_aplicados: {
      ...filters,
      periodo,
    },
    nota: 'Alertas calculadas en tiempo real; no persistidas. Fase 2: tabla padcoins_alertas y metadata de campaña.',
  };
}
