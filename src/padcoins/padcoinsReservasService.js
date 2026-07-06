import {
  PADCOINS_MOVEMENT_TYPES,
  PADCOINS_ORIGINS,
} from './padcoinsConfig.js';
import { addPadcoins } from './padcoinsService.js';
import {
  calculatePadcoinsForPaidAmount,
  getPadcoinsReservationConfig,
  getPadcoinsGlobalConfigMap,
  getPadcoinsGlobalConfigTextMap,
} from './padcoinsGlobalConfigService.js';
import { isPadcoinsActiveForSede } from './padcoinsSedeConfigService.js';

export const PADCOINS_RESERVA_REFERENCIA_TIPO = 'reserva';

const RESERVA_PADCOINS_SELECT = [
  'id',
  'user_id',
  'sede_id',
  'sede',
  'estado',
  'precio',
  'precio_esperado',
  'monto_pagado',
  'moneda',
  'pago_estado',
  'checkin_realizado',
].join(', ');

const ESTADOS_NO_ACREDITABLE = new Set([
  'cancelada',
  'no_show',
  'no-show',
  'ausente',
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

function normalizeEstado(estado) {
  return String(estado ?? '').trim().toLowerCase();
}

export function buildPadcoinsReservaMovimientoReferencia(reservaId) {
  return {
    referencia_tipo: PADCOINS_RESERVA_REFERENCIA_TIPO,
    referencia_id: String(reservaId),
  };
}

/**
 * Monto pagado confiable para cálculo proporcional (no es dinero para el jugador).
 */
export function getReservaPaidAmountInfo(reserva) {
  const currency = String(reserva?.moneda ?? 'USD').trim().toUpperCase() || 'USD';
  const montoPagado = Number(reserva?.monto_pagado);
  const precio = Number(reserva?.precio);
  const precioEsperado = Number(reserva?.precio_esperado);
  const pagoEstado = normalizeEstado(reserva?.pago_estado);
  const pagadoConfirmado = pagoEstado === 'pagado' || pagoEstado === 'approved';

  if (Number.isFinite(montoPagado) && montoPagado > 0 && pagadoConfirmado) {
    return {
      paidAmount: montoPagado,
      currency,
      reliable: true,
      source: 'monto_pagado',
    };
  }

  if (Number.isFinite(precio) && precio > 0 && pagadoConfirmado) {
    return {
      paidAmount: precio,
      currency,
      reliable: true,
      source: 'precio',
    };
  }

  if (Number.isFinite(montoPagado) && montoPagado > 0) {
    return {
      paidAmount: montoPagado,
      currency,
      reliable: false,
      source: 'monto_pagado_sin_pago_estado',
    };
  }

  if (Number.isFinite(precio) && precio > 0) {
    return {
      paidAmount: precio,
      currency,
      reliable: false,
      source: 'precio_sin_pago_estado',
    };
  }

  if (Number.isFinite(precioEsperado) && precioEsperado > 0) {
    return {
      paidAmount: precioEsperado,
      currency,
      reliable: false,
      source: 'precio_esperado',
    };
  }

  return {
    paidAmount: null,
    currency,
    reliable: false,
    source: null,
  };
}

export function isReservaEstadoAcreditable(estado) {
  return normalizeEstado(estado) === 'completada';
}

export function isReservaNoShow(reserva) {
  const estado = normalizeEstado(reserva?.estado);
  if (ESTADOS_NO_ACREDITABLE.has(estado)) {
    return estado === 'no_show' || estado === 'no-show' || estado === 'ausente';
  }
  return false;
}

export function isReservaCancelada(reserva) {
  return normalizeEstado(reserva?.estado) === 'cancelada';
}

export function computePadcoinsAmountForReserva(reserva, {
  configMap = {},
  configTextMap = {},
  fallbackFixed = null,
} = {}) {
  const paidInfo = getReservaPaidAmountInfo(reserva);
  const fixedFallback = fallbackFixed
    ?? configMap.reserva_confirmada
    ?? 30;

  if (paidInfo.reliable && paidInfo.paidAmount != null && paidInfo.paidAmount > 0) {
    const calc = calculatePadcoinsForPaidAmount({
      paidAmount: paidInfo.paidAmount,
      currency: paidInfo.currency,
      configMap,
      configTextMap,
    });

    if (calc.applied && Number.isInteger(calc.padcoins) && calc.padcoins > 0) {
      return {
        padcoins: calc.padcoins,
        method: 'proportional',
        calc,
        paidInfo,
      };
    }
  }

  const fallbackReason = paidInfo.reliable
    ? 'calculo_proporcional_no_aplicado'
    : (paidInfo.source ?? 'sin_valor_pagado_confiable');

  return {
    padcoins: fixedFallback,
    method: 'fallback_reserva_confirmada',
    reason: fallbackReason,
    paidInfo,
  };
}

export async function yaFueAcreditadaReserva(supabaseAdmin, reservaId) {
  const id = String(reservaId ?? '').trim();
  if (!id) return false;

  const { data, error } = await supabaseAdmin
    .from('padcoins_movimientos')
    .select('id')
    .eq('referencia_tipo', PADCOINS_RESERVA_REFERENCIA_TIPO)
    .eq('referencia_id', id)
    .eq('tipo', PADCOINS_MOVEMENT_TYPES.EARN)
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }

  return Boolean(data?.id);
}

async function fetchReservaForPadcoins(supabaseAdmin, reservaId) {
  const id = String(reservaId ?? '').trim();
  if (!id) return null;

  const { data, error } = await supabaseAdmin
    .from('reservas')
    .select(RESERVA_PADCOINS_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

function buildDescripcionMovimiento(reserva, amountResult) {
  const sede = reserva?.sede ?? 'sede';
  if (amountResult.method === 'proportional') {
    return `PadCoins por reserva completada en ${sede} (${amountResult.padcoins} PC)`;
  }
  return `PadCoins por reserva completada en ${sede} (fallback ${amountResult.padcoins} PC)`;
}

function appendFallbackDetail(descripcion, amountResult) {
  if (amountResult.method !== 'fallback_reserva_confirmada') return descripcion;
  const detail = amountResult.reason ? ` — ${amountResult.reason}` : '';
  return `${descripcion}${detail}`.slice(0, 500);
}

/**
 * Acredita PadCoins por reserva completada/jugada. Idempotente por reservaId.
 * No trata PadCoins como dinero; equivalencia promocional interna.
 */
export async function acreditarPadcoinsPorReservaCompletada(supabaseAdmin, reservaId, options = {}) {
  const id = String(reservaId ?? '').trim();
  if (!id) {
    return { ok: false, acreditado: false, reason: 'reserva_id_invalido' };
  }

  const reserva = options.reserva ?? await fetchReservaForPadcoins(supabaseAdmin, id);
  if (!reserva) {
    return { ok: false, acreditado: false, reason: 'reserva_no_encontrada' };
  }

  if (!reserva.user_id || !UUID_REGEX.test(String(reserva.user_id))) {
    return { ok: false, acreditado: false, reason: 'user_id_invalido' };
  }

  const sedeId = Number.parseInt(String(reserva.sede_id ?? ''), 10);
  if (!Number.isFinite(sedeId) || sedeId <= 0) {
    return { ok: false, acreditado: false, reason: 'sede_id_invalido' };
  }

  if (isReservaCancelada(reserva)) {
    return { ok: true, acreditado: false, reason: 'reserva_cancelada' };
  }

  if (isReservaNoShow(reserva)) {
    return { ok: true, acreditado: false, reason: 'reserva_no_show' };
  }

  if (!isReservaEstadoAcreditable(reserva.estado)) {
    return { ok: true, acreditado: false, reason: 'estado_no_acreditable', estado: reserva.estado };
  }

  const sedeActiva = await isPadcoinsActiveForSede(supabaseAdmin, sedeId);
  if (!sedeActiva) {
    return { ok: true, acreditado: false, reason: 'sede_no_participa', sede_id: sedeId };
  }

  if (await yaFueAcreditadaReserva(supabaseAdmin, id)) {
    return { ok: true, acreditado: false, reason: 'ya_acreditada', reserva_id: id };
  }

  const reservationConfig = options.reservationConfig
    ?? await getPadcoinsReservationConfig(supabaseAdmin);
  const configMap = options.configMap ?? await getPadcoinsGlobalConfigMap(supabaseAdmin);
  const configTextMap = options.configTextMap ?? await getPadcoinsGlobalConfigTextMap(supabaseAdmin);

  const amountResult = computePadcoinsAmountForReserva(reserva, {
    configMap: {
      ...configMap,
      reserva_confirmada: reservationConfig.reserva_confirmada_fallback,
      porcentaje_devolucion_reserva: reservationConfig.porcentaje_devolucion_reserva,
      padcoins_por_usd_equivalente: reservationConfig.padcoins_por_usd_equivalente,
    },
    configTextMap: {
      ...configTextMap,
      modo_calculo_reserva: reservationConfig.modo_calculo_reserva,
    },
    fallbackFixed: reservationConfig.reserva_confirmada_fallback,
  });

  const padcoins = Number(amountResult.padcoins);
  if (!Number.isInteger(padcoins) || padcoins <= 0) {
    return { ok: true, acreditado: false, reason: 'monto_cero', amountResult };
  }

  const referencia = buildPadcoinsReservaMovimientoReferencia(id);
  const descripcion = appendFallbackDetail(
    buildDescripcionMovimiento(reserva, amountResult),
    amountResult,
  );

  const result = await addPadcoins(supabaseAdmin, reserva.user_id, padcoins, {
    tipo: PADCOINS_MOVEMENT_TYPES.EARN,
    referencia_tipo: referencia.referencia_tipo,
    referencia_id: referencia.referencia_id,
    sede_id: sedeId,
    descripcion,
    created_by: options.created_by ?? null,
  });

  return {
    ok: true,
    acreditado: true,
    padcoins,
    method: amountResult.method,
    reserva_id: id,
    sede_id: sedeId,
    saldo: result.saldo,
    movimiento: result.movimiento,
  };
}
