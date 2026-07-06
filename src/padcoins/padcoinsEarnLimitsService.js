import {
  PADCOINS_GLOBAL_CONFIG_DEFAULTS,
  listPadcoinsGlobalConfig,
} from './padcoinsGlobalConfigService.js';
import { PADCOINS_MOVEMENT_TYPES } from './padcoinsConfig.js';

export const PADCOINS_EARN_LIMIT_TZ = 'America/Argentina/Buenos_Aires';

function pad2(value) {
  return String(value).padStart(2, '0');
}

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

/**
 * Partes de fecha en zona horaria (día calendario local AR).
 */
export function getYMDInTimezone(date, timeZone = PADCOINS_EARN_LIMIT_TZ) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);

  const get = (type) => parts.find((part) => part.type === type)?.value;

  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
  };
}

/**
 * Inicio/fin de día o mes en Argentina (UTC-3, sin DST).
 * Día: 00:00:00.000 — 23:59:59.999 del calendario AR.
 * Mes: primer día 00:00 — último día 23:59:59.999 del calendario AR.
 */
export function getEarnPeriodBounds(period, now = new Date(), timeZone = PADCOINS_EARN_LIMIT_TZ) {
  const { year, month, day } = getYMDInTimezone(now, timeZone);

  if (period === 'day') {
    const ymd = `${year}-${pad2(month)}-${pad2(day)}`;
    return {
      desde: new Date(`${ymd}T00:00:00.000-03:00`),
      hasta: new Date(`${ymd}T23:59:59.999-03:00`),
    };
  }

  if (period === 'month') {
    const firstYmd = `${year}-${pad2(month)}-01`;
    const lastDay = new Date(year, month, 0).getDate();
    const lastYmd = `${year}-${pad2(month)}-${pad2(lastDay)}`;
    return {
      desde: new Date(`${firstYmd}T00:00:00.000-03:00`),
      hasta: new Date(`${lastYmd}T23:59:59.999-03:00`),
    };
  }

  throw new Error(`periodo inválido: ${period}`);
}

function resolveLimitFromRow(row, defaultValue) {
  if (row?.activo === false) return null;
  const value = row?.value_integer != null ? Number(row.value_integer) : defaultValue;
  if (!Number.isInteger(value) || value <= 0) return null;
  return value;
}

/**
 * Topes diario/mensual desde padcoins_global_config.
 * Si la key está inactiva o el valor ≤ 0, no aplica tope (null = ilimitado).
 */
export async function getPadcoinsEarnLimits(supabaseAdmin) {
  const rows = await listPadcoinsGlobalConfig(supabaseAdmin);
  const dailyRow = rows.find((row) => row.key === 'limite_diario_jugador');
  const monthlyRow = rows.find((row) => row.key === 'limite_mensual_jugador');

  return {
    limite_diario_jugador: resolveLimitFromRow(
      dailyRow,
      PADCOINS_GLOBAL_CONFIG_DEFAULTS.limite_diario_jugador,
    ),
    limite_mensual_jugador: resolveLimitFromRow(
      monthlyRow,
      PADCOINS_GLOBAL_CONFIG_DEFAULTS.limite_mensual_jugador,
    ),
  };
}

/**
 * Suma earn positivos en [desde, hasta] por created_at.
 * No cuenta spend, adjust, reverse ni montos ≤ 0.
 */
export async function getPadcoinsEarnedInPeriod(supabaseAdmin, userId, desde, hasta) {
  if (!userId || !desde || !hasta) return 0;

  const { data, error } = await supabaseAdmin
    .from('padcoins_movimientos')
    .select('monto')
    .eq('user_id', userId)
    .eq('tipo', PADCOINS_MOVEMENT_TYPES.EARN)
    .gt('monto', 0)
    .gte('created_at', desde.toISOString())
    .lte('created_at', hasta.toISOString());

  if (error) {
    if (isMissingTable(error)) return 0;
    throw error;
  }

  return (data ?? []).reduce((sum, row) => sum + Number(row.monto ?? 0), 0);
}

function resolveCapReasons({
  amountToCredit,
  requested,
  dailyRemaining,
  monthlyRemaining,
  limits,
}) {
  const reasons = [];

  if (amountToCredit >= requested) {
    return { reason: null, reasons };
  }

  if (amountToCredit <= 0) {
    if (limits.limite_diario_jugador != null && dailyRemaining <= 0) {
      reasons.push('limite_diario_alcanzado');
    }
    if (limits.limite_mensual_jugador != null && monthlyRemaining <= 0) {
      reasons.push('limite_mensual_alcanzado');
    }
    if (!reasons.length) reasons.push('limite_alcanzado');
    return { reason: reasons[0], reasons };
  }

  const dailyCapped = limits.limite_diario_jugador != null && amountToCredit === dailyRemaining;
  const monthlyCapped = limits.limite_mensual_jugador != null && amountToCredit === monthlyRemaining;

  if (dailyCapped) reasons.push('limite_diario_aplicado');
  if (monthlyCapped) reasons.push('limite_mensual_aplicado');
  if (!reasons.length) reasons.push('limite_aplicado');

  return { reason: reasons[0], reasons };
}

/**
 * Aplica topes diario/mensual a un earn solicitado.
 * @returns {{ amountToCredit, requested, capped, reason, reasons, limits, periodo }}
 */
export async function applyPadcoinsEarnCaps(supabaseAdmin, userId, montoSolicitado, options = {}) {
  const requested = Number(montoSolicitado);
  if (!Number.isInteger(requested) || requested <= 0) {
    return {
      amountToCredit: 0,
      requested: Number.isFinite(requested) ? requested : 0,
      capped: false,
      reason: 'monto_invalido',
      reasons: ['monto_invalido'],
      limits: null,
      periodo: null,
    };
  }

  const now = options.now ?? new Date();
  const timeZone = options.timeZone ?? PADCOINS_EARN_LIMIT_TZ;
  const limits = options.limits ?? await getPadcoinsEarnLimits(supabaseAdmin);

  const dayBounds = getEarnPeriodBounds('day', now, timeZone);
  const monthBounds = getEarnPeriodBounds('month', now, timeZone);

  const dailyEarned = limits.limite_diario_jugador != null
    ? await getPadcoinsEarnedInPeriod(supabaseAdmin, userId, dayBounds.desde, dayBounds.hasta)
    : 0;
  const monthlyEarned = limits.limite_mensual_jugador != null
    ? await getPadcoinsEarnedInPeriod(supabaseAdmin, userId, monthBounds.desde, monthBounds.hasta)
    : 0;

  const dailyRemaining = limits.limite_diario_jugador == null
    ? requested
    : Math.max(0, limits.limite_diario_jugador - dailyEarned);
  const monthlyRemaining = limits.limite_mensual_jugador == null
    ? requested
    : Math.max(0, limits.limite_mensual_jugador - monthlyEarned);

  const amountToCredit = Math.min(requested, dailyRemaining, monthlyRemaining);
  const capped = amountToCredit < requested;
  const { reason, reasons } = resolveCapReasons({
    amountToCredit,
    requested,
    dailyRemaining,
    monthlyRemaining,
    limits,
  });

  return {
    amountToCredit,
    requested,
    capped,
    reason,
    reasons,
    limits,
    periodo: {
      dailyEarned,
      monthlyEarned,
      dailyRemaining,
      monthlyRemaining,
      dayBounds,
      monthBounds,
    },
  };
}

export function appendPadcoinsEarnCapToDescripcion(descripcion, capResult) {
  if (!capResult?.capped || capResult.amountToCredit <= 0) {
    return descripcion ?? null;
  }

  const base = descripcion ?? '';
  const suffix = ` (límite aplicado: solicitado ${capResult.requested}, acreditado ${capResult.amountToCredit})`;
  return `${base}${suffix}`.slice(0, 500);
}
