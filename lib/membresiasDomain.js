/**
 * Dominio puro Membresías por sede (sin I/O).
 * Beneficios aplicables ahora: descuento % y reservas incluidas por período.
 * No aplicar: PadCoins, cobro recurrente, torneos, clases gratis (sin gate real).
 */

export const DURACION_TIPOS = Object.freeze(['mensual', 'trimestral', 'semestral', 'anual', 'dias']);
export const MEMBRESIA_ESTADOS = Object.freeze(['pendiente', 'activa', 'suspendida', 'vencida', 'cancelada']);
export const ORIGENES = Object.freeze(['manual', 'pago', 'promocion']);

export const DURACION_DIAS_DEFAULT = Object.freeze({
  mensual: 30,
  trimestral: 90,
  semestral: 180,
  anual: 365,
});

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function parsePositiveInt(raw) {
  const n = parseInt(String(raw ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function parseNonNegativeNumber(raw) {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function normalizeDuracionTipo(raw, fallback = 'mensual') {
  const v = String(raw ?? '').trim().toLowerCase();
  return DURACION_TIPOS.includes(v) ? v : fallback;
}

export function resolveDuracionDias({ duracion_tipo, duracion_dias }) {
  const tipo = normalizeDuracionTipo(duracion_tipo);
  if (tipo === 'dias') {
    const d = parsePositiveInt(duracion_dias);
    if (!d) throw httpError(400, 'duracion_dias es requerido para duración personalizada');
    return d;
  }
  return DURACION_DIAS_DEFAULT[tipo] ?? 30;
}

export function addDaysIso(fromIso, days) {
  const base = fromIso ? new Date(fromIso) : new Date();
  const ms = base.getTime() + Number(days) * 24 * 60 * 60 * 1000;
  return new Date(ms).toISOString();
}

export function normalizeBeneficios(raw = {}) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const descuento = parseNonNegativeNumber(src.descuento_porcentual ?? src.descuento_pct ?? 0) ?? 0;
  const incluidas = parsePositiveInt(src.reservas_incluidas_por_periodo ?? src.reservas_incluidas) ?? 0;
  const prioridad = parseNonNegativeNumber(src.prioridad_horas ?? 0) ?? 0;
  const cancelExtra = parseNonNegativeNumber(src.cancelacion_horas_extra ?? 0) ?? 0;

  return {
    descuento_porcentual: Math.min(100, descuento),
    reservas_incluidas_por_periodo: incluidas,
    // Informativos hasta que exista gate de anticipación / cancelación
    prioridad_horas: prioridad,
    cancelacion_horas_extra: cancelExtra,
    aplicables_ahora: [
      ...(descuento > 0 ? ['descuento_porcentual'] : []),
      ...(incluidas > 0 ? ['reservas_incluidas_por_periodo'] : []),
    ],
    informativos: [
      ...(prioridad > 0 ? ['prioridad_horas'] : []),
      ...(cancelExtra > 0 ? ['cancelacion_horas_extra'] : []),
    ],
  };
}

export function isMissingMembresiaTableError(err) {
  const msg = String(err?.message ?? err ?? '');
  return /membresia_planes|membresias_sede|membresia_usos/i.test(msg)
    && /schema cache|does not exist|Could not find the table/i.test(msg);
}

export function isMembershipActive(row, now = new Date()) {
  if (!row || row.estado !== 'activa') return false;
  if (!row.vencimiento) return false;
  const exp = new Date(row.vencimiento).getTime();
  return Number.isFinite(exp) && exp > now.getTime();
}

export function shouldMarkExpired(row, now = new Date()) {
  if (!row || row.estado !== 'activa') return false;
  if (!row.vencimiento) return false;
  const exp = new Date(row.vencimiento).getTime();
  return Number.isFinite(exp) && exp <= now.getTime();
}

/** Clave de período basada en inicio de membresía (ciclos de duración). */
export function buildPeriodoKey(membresia, now = new Date()) {
  const inicio = new Date(membresia.inicio || membresia.started_at || now).getTime();
  const venc = new Date(membresia.vencimiento).getTime();
  const cycleMs = Math.max(24 * 60 * 60 * 1000, venc - inicio);
  const idx = Math.max(0, Math.floor((now.getTime() - inicio) / cycleMs));
  return `${membresia.id}:p${idx}`;
}

/**
 * Aplica beneficios reales sobre base/extras. Fee se recalcula afuera.
 * Prioridad: reserva incluida (si hay cupo) > descuento %. Nunca ambos.
 */
export function applyMembresiaBenefitsToQuote({
  base,
  extrasSubtotal = 0,
  beneficios,
  incluidasUsadas = 0,
  feePct = 0.03,
}) {
  const bens = normalizeBeneficios(beneficios || {});
  const baseNum = Math.max(0, Number(base) || 0);
  const extrasNum = Math.max(0, Number(extrasSubtotal) || 0);
  const result = {
    base: baseNum,
    extrasSubtotal: extrasNum,
    beneficio_aplicado: null,
    descuento_monto: 0,
    reserva_incluida: false,
  };

  const incluidasLimit = bens.reservas_incluidas_por_periodo;
  if (incluidasLimit > 0 && incluidasUsadas < incluidasLimit) {
    result.descuento_monto = baseNum;
    result.base = 0;
    result.reserva_incluida = true;
    result.beneficio_aplicado = {
      tipo: 'reservas_incluidas_por_periodo',
      usadas: incluidasUsadas + 1,
      limite: incluidasLimit,
    };
  } else if (bens.descuento_porcentual > 0) {
    const pct = bens.descuento_porcentual;
    const discount = Math.round(baseNum * (pct / 100));
    result.descuento_monto = discount;
    result.base = Math.max(0, baseNum - discount);
    result.beneficio_aplicado = {
      tipo: 'descuento_porcentual',
      porcentaje: pct,
      monto: discount,
    };
  }

  const fee = Math.round((result.base + result.extrasSubtotal) * feePct);
  result.fee = fee;
  result.total = result.base + result.extrasSubtotal + fee;
  return result;
}

export function mapPlanPublico(plan) {
  if (!plan) return null;
  const beneficios = normalizeBeneficios(plan.beneficios || {});
  return {
    id: plan.id,
    sede_id: plan.sede_id,
    nombre: plan.nombre,
    descripcion: plan.descripcion ?? null,
    precio: Number(plan.precio) || 0,
    moneda: plan.moneda || 'ARS',
    duracion_tipo: plan.duracion_tipo,
    duracion_dias: plan.duracion_dias ?? resolveDuracionDias(plan),
    activo: plan.activo !== false,
    cupo: plan.cupo ?? null,
    vigencia_desde: plan.vigencia_desde ?? null,
    vigencia_hasta: plan.vigencia_hasta ?? null,
    renovacion_automatica: Boolean(plan.renovacion_automatica),
    beneficios,
    renovacion_automatica_cobro: false, // cobro recurrente futuro
  };
}

export function mapMembresiaPublica(row, plan = null, jugador = null) {
  if (!row) return null;
  const out = {
    id: row.id,
    user_id: row.user_id,
    sede_id: row.sede_id,
    plan_id: row.plan_id,
    estado: row.estado,
    origen: row.origen,
    inicio: row.inicio,
    vencimiento: row.vencimiento,
    renovacion_automatica: Boolean(row.renovacion_automatica),
  };
  if (plan) out.plan = mapPlanPublico(plan);
  if (jugador) out.jugador = jugador;
  return out;
}

/** Resumen administrativo de jugador (sin documentos ni secretos). */
export function mapJugadorResumenMembresia(perfil) {
  if (!perfil || typeof perfil !== 'object') return null;
  const nombre = String(perfil.nombre || '').trim() || null;
  const apellido = String(perfil.apellido || '').trim() || null;
  const display = [nombre, apellido].filter(Boolean).join(' ').trim() || null;
  return {
    user_id: perfil.user_id != null ? String(perfil.user_id) : null,
    nombre: display || nombre,
    apellido,
    username: String(perfil.username || '').trim() || null,
    alias: String(perfil.alias || perfil.apodo || '').trim() || null,
    email: String(perfil.email || '').trim().toLowerCase() || null,
  };
}

export const MEMBRESIAS_LIST_DEFAULT_LIMIT = 15;
export const MEMBRESIAS_LIST_MAX_LIMIT = 100;
export const MEMBRESIAS_LIST_Q_MIN = 2;
export const MEMBRESIAS_LIST_Q_MAX = 80;
export const MEMBRESIAS_LIST_SORTS = Object.freeze(['created_at', 'inicio', 'vencimiento', 'estado']);

export function buildMembresiasPagination({ page, limit, total }) {
  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.max(1, Number(limit) || MEMBRESIAS_LIST_DEFAULT_LIMIT);
  const safeTotal = Math.max(0, Number(total) || 0);
  const totalPages = safeTotal === 0 ? 0 : Math.ceil(safeTotal / safeLimit);
  return {
    page: safePage,
    limit: safeLimit,
    total: safeTotal,
    total_pages: totalPages,
    has_next: totalPages > 0 && safePage < totalPages,
    has_previous: safePage > 1 && safeTotal > 0,
  };
}

function httpBad(message) {
  return httpError(400, message);
}

/**
 * Parseo estricto de query del listado admin.
 * @returns {{ page, limit, estado, planId, q, sort, direction, offset }}
 */
export function parseMembresiasListQuery(query = {}) {
  let page = 1;
  if (query.page != null && String(query.page).trim() !== '') {
    const raw = String(query.page).trim();
    if (!/^[1-9]\d*$/.test(raw)) throw httpBad('page inválido');
    page = Number.parseInt(raw, 10);
  }

  let limit = MEMBRESIAS_LIST_DEFAULT_LIMIT;
  if (query.limit != null && String(query.limit).trim() !== '') {
    const raw = String(query.limit).trim();
    if (!/^[1-9]\d*$/.test(raw)) throw httpBad('limit inválido');
    const n = Number.parseInt(raw, 10);
    if (n > MEMBRESIAS_LIST_MAX_LIMIT) throw httpBad(`limit supera el máximo de ${MEMBRESIAS_LIST_MAX_LIMIT}`);
    limit = n;
  }

  let estado = null;
  if (query.estado != null && String(query.estado).trim() !== '') {
    estado = String(query.estado).trim().toLowerCase();
    if (!MEMBRESIA_ESTADOS.includes(estado)) throw httpBad('estado inválido');
  }

  let planId = null;
  if (query.plan_id != null && String(query.plan_id).trim() !== '') {
    planId = parsePositiveInt(query.plan_id);
    if (!planId) throw httpBad('plan_id inválido');
  }

  let q = null;
  if (query.q != null && String(query.q).trim() !== '') {
    q = String(query.q).trim().replace(/\s+/g, ' ');
    if (q.length < MEMBRESIAS_LIST_Q_MIN) throw httpBad(`q debe tener al menos ${MEMBRESIAS_LIST_Q_MIN} caracteres`);
    if (q.length > MEMBRESIAS_LIST_Q_MAX) throw httpBad(`q supera el máximo de ${MEMBRESIAS_LIST_Q_MAX} caracteres`);
  }

  let sort = 'created_at';
  if (query.sort != null && String(query.sort).trim() !== '') {
    sort = String(query.sort).trim().toLowerCase();
    if (!MEMBRESIAS_LIST_SORTS.includes(sort)) throw httpBad('sort inválido');
  }

  let direction = 'desc';
  if (query.direction != null && String(query.direction).trim() !== '') {
    direction = String(query.direction).trim().toLowerCase();
    if (direction !== 'asc' && direction !== 'desc') throw httpBad('direction inválida');
  }

  return {
    page,
    limit,
    estado,
    planId,
    q,
    sort,
    direction,
    offset: (page - 1) * limit,
  };
}

/** Escapa literales para PostgREST ilike. */
export function escapeMembresiaIlike(raw) {
  return String(raw || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/"/g, '\\"');
}

/** Filtro .or() sobre jugadores_perfil para búsqueda admin. */
export function buildMembresiaJugadorSearchOrFilter(q) {
  const cleaned = String(q || '').trim().replace(/\s+/g, ' ');
  if (cleaned.length < MEMBRESIAS_LIST_Q_MIN) return null;
  const escaped = escapeMembresiaIlike(cleaned);
  return [
    `nombre.ilike."%${escaped}%"`,
    `apellido.ilike."%${escaped}%"`,
    `username.ilike."%${escaped}%"`,
    `apodo.ilike."%${escaped}%"`,
    `alias.ilike."%${escaped}%"`,
    `email.ilike."%${escaped}%"`,
  ].join(',');
}

/**
 * Asserts minimal admin list DTO (no documentos/tokens/empate).
 */
export function assertMembresiaListItemSafe(item) {
  const serialized = JSON.stringify(item || {}).toLowerCase();
  for (const bad of ['documento', 'mp_access_token', 'access_token', 'password', 'empate', 'stripe_secret']) {
    if (serialized.includes(bad)) {
      throw new Error(`Campo prohibido en listado: ${bad}`);
    }
  }
  return true;
}

export function mapMembresiaJugadorDto(row, plan = null) {
  const base = mapMembresiaPublica(row, plan);
  if (!base) return null;
  // Sin datos financieros sensibles de admin
  return {
    ...base,
    email: undefined,
    notas: undefined,
    created_by: undefined,
  };
}

export function buildMembresiaNotificacionDedupeKey(event, parts = {}) {
  const bits = Object.entries(parts)
    .filter(([, v]) => v != null && v !== '')
    .map(([k, v]) => `${k}${v}`);
  return `membresia:${event}:${bits.join(':')}`;
}

export function assertAdminSedeScope(role, sedeId) {
  if (!role) return httpError(403, 'No autorizado');
  if (role.rol === 'super_admin') return null;
  if (role.rol === 'admin_club' && Number(role.sede_id) === Number(sedeId)) return null;
  return httpError(403, 'No tenés permiso para esta sede');
}
