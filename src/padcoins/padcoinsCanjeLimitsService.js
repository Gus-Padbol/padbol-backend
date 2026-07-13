import {
  PADCOINS_CANJE_LIMITE_PERIODO,
  PADCOINS_CANJE_LIMITE_PERIODOS,
} from './padcoinsCanjesConfig.js';

const COUNTABLE_ESTADOS = ['pendiente', 'aprobado', 'entregado'];

function buildHttpError(message, status = 409) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function normalizePeriodo(raw) {
  if (raw == null || raw === '') return null;
  const normalized = String(raw).trim().toLowerCase();
  return PADCOINS_CANJE_LIMITE_PERIODOS.includes(normalized) ? normalized : null;
}

function parseOptionalLimit(raw) {
  if (raw == null || raw === '') return null;
  const parsed = Number.parseInt(String(raw), 10);
  if (!Number.isInteger(parsed) || parsed < 0) return undefined;
  return parsed === 0 ? null : parsed;
}

export function resolvePremioCanjeLimits(premio = {}) {
  const limiteUsuarioCantidad = parseOptionalLimit(premio.limite_usuario_cantidad);
  const limiteUsuarioPeriodo = normalizePeriodo(premio.limite_usuario_periodo);
  const limiteGlobalCantidad = parseOptionalLimit(premio.limite_global_cantidad);
  const limiteGlobalPeriodo = normalizePeriodo(premio.limite_global_periodo);

  if (limiteUsuarioCantidad != null && !limiteUsuarioPeriodo) {
    throw buildHttpError('limite_usuario_periodo es requerido cuando limite_usuario_cantidad > 0', 400);
  }
  if (limiteGlobalCantidad != null && !limiteGlobalPeriodo) {
    throw buildHttpError('limite_global_cantidad requiere limite_global_periodo', 400);
  }

  return {
    limite_usuario_cantidad: limiteUsuarioCantidad,
    limite_usuario_periodo: limiteUsuarioPeriodo,
    limite_global_cantidad: limiteGlobalCantidad,
    limite_global_periodo: limiteGlobalPeriodo,
  };
}

export function computePeriodStartIso(periodo, nowMs = Date.now()) {
  const now = new Date(nowMs);
  const utcYear = now.getUTCFullYear();
  const utcMonth = now.getUTCMonth();
  const utcDate = now.getUTCDate();

  switch (periodo) {
    case PADCOINS_CANJE_LIMITE_PERIODO.DIA:
      return new Date(Date.UTC(utcYear, utcMonth, utcDate, 0, 0, 0, 0)).toISOString();
    case PADCOINS_CANJE_LIMITE_PERIODO.SEMANA: {
      const day = now.getUTCDay();
      const diffToMonday = (day + 6) % 7;
      const monday = new Date(Date.UTC(utcYear, utcMonth, utcDate - diffToMonday, 0, 0, 0, 0));
      return monday.toISOString();
    }
    case PADCOINS_CANJE_LIMITE_PERIODO.MES:
      return new Date(Date.UTC(utcYear, utcMonth, 1, 0, 0, 0, 0)).toISOString();
    case PADCOINS_CANJE_LIMITE_PERIODO.TOTAL:
      return null;
    default:
      return null;
  }
}

async function countCanjesForLimit(supabaseAdmin, {
  premioId,
  sedeId = null,
  userId = null,
  periodo,
  excludeCanjeId = null,
}) {
  let query = supabaseAdmin
    .from('padcoins_canjes')
    .select('id', { count: 'exact', head: true })
    .eq('premio_id', premioId)
    .in('estado', COUNTABLE_ESTADOS);

  if (sedeId != null) {
    query = query.eq('sede_id', sedeId);
  }
  if (userId) {
    query = query.eq('user_id', userId);
  }
  if (excludeCanjeId) {
    query = query.neq('id', excludeCanjeId);
  }

  const periodStart = computePeriodStartIso(periodo);
  if (periodStart) {
    query = query.gte('created_at', periodStart);
  }

  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}

export async function assertCanjeLimitsAllowRedemption(supabaseAdmin, premio, {
  userId,
  excludeCanjeId = null,
} = {}) {
  const limits = resolvePremioCanjeLimits(premio);

  if (limits.limite_usuario_cantidad != null) {
    const used = await countCanjesForLimit(supabaseAdmin, {
      premioId: premio.id,
      userId,
      periodo: limits.limite_usuario_periodo,
      excludeCanjeId,
    });

    if (used >= limits.limite_usuario_cantidad) {
      throw buildHttpError(
        `Límite de canje por jugador alcanzado (${limits.limite_usuario_cantidad}/${limits.limite_usuario_periodo})`,
      );
    }
  }

  if (limits.limite_global_cantidad != null) {
    const usedGlobal = await countCanjesForLimit(supabaseAdmin, {
      premioId: premio.id,
      sedeId: premio.sede_id,
      periodo: limits.limite_global_periodo,
      excludeCanjeId,
    });

    if (usedGlobal >= limits.limite_global_cantidad) {
      throw buildHttpError(
        `Límite global de canjes del beneficio alcanzado (${limits.limite_global_cantidad}/${limits.limite_global_periodo})`,
      );
    }
  }

  return limits;
}
