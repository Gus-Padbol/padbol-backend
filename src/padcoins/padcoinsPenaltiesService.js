import {
  PADCOINS_GLOBAL_CONFIG_DEFAULTS,
  listPadcoinsGlobalConfig,
} from './padcoinsGlobalConfigService.js';
import {
  getEffectivePadcoinsValueForSede,
  normalizePadcoinsSedeRuleOverrides,
} from './padcoinsEffectiveConfigService.js';
import { deductPadcoins } from './padcoinsService.js';
import { PADCOINS_ORIGINS } from './padcoinsConfig.js';
import { getPadcoinsSedeConfig, isPadcoinsActiveForSede } from './padcoinsSedeConfigService.js';
import { isReservaNoShow } from './padcoinsReservasService.js';
import {
  mapPenaltyTypeToReversalAction,
  revertirPadcoinsPorReservaIncumplimiento,
} from './padcoinsReservaReversalService.js';
import {
  computeHorasAnticipacionReserva,
  PENALIZACION_UMBRAL_HORAS,
} from '../../routes/reputacion.js';
import { reservaHoraInicioFromRow } from '../../utils/reservasColumns.js';

export const PADCOINS_PENALTY_TYPES = {
  CANCELACION_TARDE: 'cancelacion_tarde',
  NO_SHOW: 'no_show',
};

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const RESERVA_PENALTY_SELECT = [
  'id',
  'user_id',
  'sede_id',
  'sede',
  'estado',
  'fecha',
  'hora',
  'hora_inicio',
  'email',
].join(', ');

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

export function buildPadcoinsPenaltyReferencia(reservaId, tipoPenalizacion) {
  return {
    referencia_tipo: PADCOINS_ORIGINS.PENALIZACION,
    referencia_id: `${String(reservaId)}:${tipoPenalizacion}`,
  };
}

export function isCancelacionTardeReserva(fecha, hora, horasPrecomputed) {
  const horas = horasPrecomputed != null && Number.isFinite(Number(horasPrecomputed))
    ? Number(horasPrecomputed)
    : computeHorasAnticipacionReserva(fecha, hora);

  return horas != null && horas < PENALIZACION_UMBRAL_HORAS;
}

function parseOptionalSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function resolvePenaltyMagnitude(raw) {
  const magnitude = Math.abs(Number(raw));
  return Number.isInteger(magnitude) && magnitude > 0 ? magnitude : 0;
}

export async function getPadcoinsPenaltyAmount(supabaseAdmin, key, sedeId = null) {
  const normalizedKey = String(key ?? '').trim();
  const sid = parseOptionalSedeId(sedeId);
  const rows = await listPadcoinsGlobalConfig(supabaseAdmin);
  const row = rows.find((item) => item.key === normalizedKey);

  if (sid) {
    const sedeConfig = await getPadcoinsSedeConfig(supabaseAdmin, sid);
    const overrides = normalizePadcoinsSedeRuleOverrides(sedeConfig.rule_overrides);
    const hasSedeOverride = Object.prototype.hasOwnProperty.call(overrides, normalizedKey);

    if (hasSedeOverride) {
      return resolvePenaltyMagnitude(overrides[normalizedKey]);
    }

    if (row?.activo === false) return 0;

    const effectiveValue = await getEffectivePadcoinsValueForSede(
      supabaseAdmin,
      sid,
      normalizedKey,
      null,
    );
    return resolvePenaltyMagnitude(effectiveValue);
  }

  if (row?.activo === false) return 0;

  const raw = row?.value_integer ?? PADCOINS_GLOBAL_CONFIG_DEFAULTS[normalizedKey];
  return resolvePenaltyMagnitude(raw);
}

export async function yaFuePenalizadaReserva(supabaseAdmin, reservaId, tipoPenalizacion) {
  const id = String(reservaId ?? '').trim();
  const tipo = String(tipoPenalizacion ?? '').trim();
  if (!id || !tipo) return false;

  const referencia = buildPadcoinsPenaltyReferencia(id, tipo);

  const { data, error } = await supabaseAdmin
    .from('padcoins_movimientos')
    .select('id')
    .eq('referencia_tipo', referencia.referencia_tipo)
    .eq('referencia_id', referencia.referencia_id)
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return false;
    throw error;
  }

  return Boolean(data?.id);
}

async function fetchReservaForPenalty(supabaseAdmin, reservaId) {
  const id = String(reservaId ?? '').trim();
  if (!id) return null;

  const { data, error } = await supabaseAdmin
    .from('reservas')
    .select(RESERVA_PENALTY_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

function resolveReservaUserId(reserva, options = {}) {
  if (options.userId && UUID_REGEX.test(String(options.userId))) {
    return String(options.userId);
  }
  if (reserva?.user_id && UUID_REGEX.test(String(reserva.user_id))) {
    return String(reserva.user_id);
  }
  return null;
}

function buildPenaltyDescripcion(tipoPenalizacion, reserva, montoConfig) {
  const sede = reserva?.sede ?? 'sede';
  const reservaId = reserva?.id ?? '?';

  if (tipoPenalizacion === PADCOINS_PENALTY_TYPES.CANCELACION_TARDE) {
    return `Penalización PadCoins por cancelación tardía — reserva #${reservaId} en ${sede} (-${montoConfig} PC)`;
  }

  if (tipoPenalizacion === PADCOINS_PENALTY_TYPES.NO_SHOW) {
    return `Penalización PadCoins por no show — reserva #${reservaId} en ${sede} (-${montoConfig} PC)`;
  }

  return `Penalización PadCoins — reserva #${reservaId} (-${montoConfig} PC)`;
}

async function applyReservaPadcoinsPenalty(supabaseAdmin, reservaId, tipoPenalizacion, {
  reserva: reservaInput,
  userId: userIdInput,
  configKey,
  skipLateCheck = false,
  horasAnticipacion,
  requireNoShow = false,
} = {}) {
  const id = String(reservaId ?? '').trim();
  if (!id) {
    return { ok: false, penalizado: false, reason: 'reserva_id_invalido' };
  }

  const reserva = reservaInput ?? await fetchReservaForPenalty(supabaseAdmin, id);
  if (!reserva) {
    return { ok: false, penalizado: false, reason: 'reserva_no_encontrada' };
  }

  const userId = resolveReservaUserId(reserva, { userId: userIdInput });
  if (!userId) {
    return { ok: true, penalizado: false, reason: 'user_id_invalido' };
  }

  const sedeId = Number.parseInt(String(reserva.sede_id ?? ''), 10);
  if (!Number.isFinite(sedeId) || sedeId <= 0) {
    return { ok: true, penalizado: false, reason: 'sede_id_invalido' };
  }

  const sedeActiva = await isPadcoinsActiveForSede(supabaseAdmin, sedeId);
  if (!sedeActiva) {
    return { ok: true, penalizado: false, reason: 'sede_no_participa', sede_id: sedeId };
  }

  if (requireNoShow && !isReservaNoShow(reserva)) {
    return { ok: true, penalizado: false, reason: 'estado_no_show', estado: reserva.estado };
  }

  if (!skipLateCheck) {
    const horaInicio = reservaHoraInicioFromRow(reserva);
    const esTarde = isCancelacionTardeReserva(
      reserva.fecha,
      horaInicio,
      horasAnticipacion,
    );
    if (!esTarde) {
      return {
        ok: true,
        penalizado: false,
        reason: 'cancelacion_no_tardia',
        horas_anticipacion: horasAnticipacion ?? computeHorasAnticipacionReserva(reserva.fecha, horaInicio),
      };
    }
  }

  const reversalAction = mapPenaltyTypeToReversalAction(tipoPenalizacion);
  const reversalResult = reversalAction
    ? await revertirPadcoinsPorReservaIncumplimiento(supabaseAdmin, id, {
      reversalAction,
      reserva,
      userId,
    })
    : null;

  if (await yaFuePenalizadaReserva(supabaseAdmin, id, tipoPenalizacion)) {
    return {
      ok: true,
      penalizado: false,
      reason: 'ya_penalizada',
      reserva_id: id,
      reversal: reversalResult,
    };
  }

  const montoConfig = await getPadcoinsPenaltyAmount(supabaseAdmin, configKey, sedeId);
  if (montoConfig <= 0) {
    return {
      ok: true,
      penalizado: false,
      reason: 'penalizacion_inactiva_o_cero',
      configKey,
      reversal: reversalResult,
    };
  }

  const referencia = buildPadcoinsPenaltyReferencia(id, tipoPenalizacion);
  const descripcion = buildPenaltyDescripcion(tipoPenalizacion, reserva, montoConfig);

  const result = await deductPadcoins(supabaseAdmin, userId, montoConfig, {
    referencia_tipo: referencia.referencia_tipo,
    referencia_id: referencia.referencia_id,
    sede_id: sedeId,
    descripcion,
    created_by: null,
  });

  if (result.skipped) {
    const reason = result.reason === 'ya_descontado' ? 'ya_penalizada' : (result.reason ?? 'saldo_insuficiente');
    return {
      ok: true,
      penalizado: false,
      reason,
      padcoins_solicitados: montoConfig,
      padcoins: 0,
      reserva_id: id,
      sede_id: sedeId,
      saldo: result.saldo,
      idempotent: result.idempotent === true,
      reversal: reversalResult,
    };
  }

  return {
    ok: true,
    penalizado: true,
    padcoins_solicitados: montoConfig,
    padcoins: result.monto_aplicado ?? montoConfig,
    partial: Boolean(result.partial),
    reserva_id: id,
    sede_id: sedeId,
    tipo: tipoPenalizacion,
    saldo: result.saldo,
    movimiento: result.movimiento,
    reversal: reversalResult,
  };
}

export async function penalizarPadcoinsPorCancelacionTarde(supabaseAdmin, reservaId, options = {}) {
  return applyReservaPadcoinsPenalty(
    supabaseAdmin,
    reservaId,
    PADCOINS_PENALTY_TYPES.CANCELACION_TARDE,
    {
      ...options,
      configKey: 'cancelacion_tarde',
      skipLateCheck: false,
      requireNoShow: false,
    },
  );
}

export async function penalizarPadcoinsPorNoShow(supabaseAdmin, reservaId, options = {}) {
  return applyReservaPadcoinsPenalty(
    supabaseAdmin,
    reservaId,
    PADCOINS_PENALTY_TYPES.NO_SHOW,
    {
      ...options,
      configKey: 'no_show',
      skipLateCheck: true,
      requireNoShow: true,
    },
  );
}
