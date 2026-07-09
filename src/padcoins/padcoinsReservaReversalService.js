import {
  PADCOINS_MOVEMENT_TYPES,
} from './padcoinsConfig.js';
import {
  PADCOINS_RESERVA_REFERENCIA_TIPO,
} from './padcoinsReservasService.js';
import {
  buildIdempotentSkipResult,
  buildMovimientoMetadata,
  buildPadcoinsSourceKey,
  findExistingPadcoinsMovimientoBySource,
} from './padcoinsIdempotencyService.js';
import { getPadcoinsSaldo, reversePadcoins } from './padcoinsService.js';

export const PADCOINS_RESERVA_REVERSAL_ACTIONS = Object.freeze({
  CANCELACION_TARDIA: 'reversal_cancelacion_tardia',
  NO_SHOW: 'reversal_no_show',
});

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const REVERSAL_REASONS = Object.freeze({
  [PADCOINS_RESERVA_REVERSAL_ACTIONS.CANCELACION_TARDIA]:
    'Reversa PadCoins por cancelación tardía de reserva previamente acreditada',
  [PADCOINS_RESERVA_REVERSAL_ACTIONS.NO_SHOW]:
    'Reversa PadCoins por no show en reserva previamente acreditada',
});

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

export function mapPenaltyTypeToReversalAction(tipoPenalizacion) {
  const tipo = String(tipoPenalizacion ?? '').trim();
  if (tipo === 'cancelacion_tarde') {
    return PADCOINS_RESERVA_REVERSAL_ACTIONS.CANCELACION_TARDIA;
  }
  if (tipo === 'no_show') {
    return PADCOINS_RESERVA_REVERSAL_ACTIONS.NO_SHOW;
  }
  return null;
}

export function buildReservaReversalReferencia(reservaId, reversalAction) {
  return {
    referencia_tipo: PADCOINS_RESERVA_REFERENCIA_TIPO,
    referencia_id: `${String(reservaId)}:${String(reversalAction ?? '').trim()}`,
  };
}

export async function fetchReservaEarnMovimiento(supabaseAdmin, reservaId) {
  const id = String(reservaId ?? '').trim();
  if (!id) return null;

  const { data, error } = await supabaseAdmin
    .from('padcoins_movimientos')
    .select('*')
    .eq('referencia_tipo', PADCOINS_RESERVA_REFERENCIA_TIPO)
    .eq('referencia_id', id)
    .eq('tipo', PADCOINS_MOVEMENT_TYPES.EARN)
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }

  return data ?? null;
}

export async function fetchCampaignApplicationForReserva(supabaseAdmin, reservaId) {
  const id = String(reservaId ?? '').trim();
  if (!id) return null;

  const { data, error } = await supabaseAdmin
    .from('padcoins_campaign_applications')
    .select('*')
    .eq('reserva_id', id)
    .limit(1)
    .maybeSingle();

  if (error) {
    if (isMissingTable(error)) return null;
    throw error;
  }

  return data ?? null;
}

export async function yaFueRevertidaReserva(supabaseAdmin, reservaId, reversalAction) {
  const referencia = buildReservaReversalReferencia(reservaId, reversalAction);
  const existing = await findExistingPadcoinsMovimientoBySource(supabaseAdmin, {
    referencia_tipo: referencia.referencia_tipo,
    referencia_id: referencia.referencia_id,
    tipo: PADCOINS_MOVEMENT_TYPES.REVERSE,
  });

  return Boolean(existing?.id);
}

function resolveEarnAmount(movimiento) {
  const raw = Number(movimiento?.monto);
  if (!Number.isFinite(raw) || raw === 0) return 0;
  return Math.abs(Math.trunc(raw));
}

function buildReversalDescripcion(reserva, reversalAction, amount, partial = false) {
  const sede = reserva?.sede ?? 'sede';
  const reservaId = reserva?.id ?? '?';
  const base = reversalAction === PADCOINS_RESERVA_REVERSAL_ACTIONS.NO_SHOW
    ? `Reversa PadCoins por no show — reserva #${reservaId} en ${sede} (-${amount} PC)`
    : `Reversa PadCoins por cancelación tardía — reserva #${reservaId} en ${sede} (-${amount} PC)`;

  if (!partial) return base;
  return `${base} (reversa parcial por saldo insuficiente)`.slice(0, 500);
}

function buildCampaignReversalMetadata(campaignApplication) {
  if (!campaignApplication) return {};

  const base = Number(campaignApplication.base_padcoins);
  const final = Number(campaignApplication.final_padcoins);
  const bonus = Number.isFinite(base) && Number.isFinite(final) && final > base
    ? final - base
    : null;

  return {
    campaign_application_id: campaignApplication.id ?? null,
    campaign_id: campaignApplication.campaign_id ?? null,
    campaign_base_padcoins: Number.isFinite(base) ? base : null,
    campaign_final_padcoins: Number.isFinite(final) ? final : null,
    campaign_bonus_padcoins: bonus,
  };
}

async function clawbackPadcoinsEarn(supabaseAdmin, userId, amount, options = {}) {
  const parsedAmount = Math.abs(Math.trunc(Number(amount)));
  if (!Number.isInteger(parsedAmount) || parsedAmount <= 0) {
    return {
      skipped: true,
      reason: 'monto_cero',
      monto_solicitado: parsedAmount,
      monto_aplicado: 0,
      saldo: await getPadcoinsSaldo(supabaseAdmin, userId),
    };
  }

  const saldo = await getPadcoinsSaldo(supabaseAdmin, userId);
  const disponible = Number(saldo.disponible ?? 0);
  const toClaw = Math.min(parsedAmount, disponible);
  const pendiente = parsedAmount - toClaw;

  if (toClaw <= 0) {
    return {
      skipped: true,
      reason: 'saldo_insuficiente',
      monto_solicitado: parsedAmount,
      monto_aplicado: 0,
      pendiente: parsedAmount,
      partial: false,
      saldo,
    };
  }

  const partial = pendiente > 0;
  const metadata = buildMovimientoMetadata({
    sourceType: options.source_type,
    sourceId: options.source_id,
    action: options.action,
    sourceKey: options.source_key,
    calculationDetail: {
      ...(options.calculation_detail ?? {}),
      clawback_solicitado: parsedAmount,
      clawback_aplicado: toClaw,
      clawback_pendiente: pendiente,
      original_movement_id: options.original_movement_id ?? null,
      reason: options.reason ?? null,
    },
  });

  const descripcion = typeof options.buildDescripcion === 'function'
    ? options.buildDescripcion(toClaw, partial)
    : options.descripcion;

  try {
    const result = await reversePadcoins(supabaseAdmin, userId, toClaw, {
      credit: false,
      referencia_tipo: options.referencia_tipo,
      referencia_id: options.referencia_id,
      sede_id: options.sede_id ?? null,
      descripcion,
      metadata,
      action: options.action,
      enforceIdempotency: true,
      created_by: options.created_by ?? null,
    });

    return {
      ...result,
      monto_solicitado: parsedAmount,
      monto_aplicado: toClaw,
      pendiente,
      partial,
    };
  } catch (err) {
    if (err.code === 'PADCOINS_ALREADY_APPLIED' || err.code === 'PADCOINS_DUPLICATE_MOVIMIENTO') {
      return {
        ...buildIdempotentSkipResult(err.movimiento, 'ya_revertida'),
        monto_solicitado: parsedAmount,
        monto_aplicado: 0,
        saldo: await getPadcoinsSaldo(supabaseAdmin, userId),
      };
    }
    throw err;
  }
}

/**
 * Revierte el earn de una reserva (incluye bonus de campaña en el mismo movimiento).
 * Idempotente por reserva + acción de reversa. Soporta clawback parcial si saldo bajo.
 */
export async function revertirPadcoinsPorReservaIncumplimiento(supabaseAdmin, reservaId, {
  reversalAction,
  reserva: reservaInput = null,
  userId: userIdInput = null,
  reason: reasonOverride = null,
} = {}) {
  const id = String(reservaId ?? '').trim();
  const action = String(reversalAction ?? '').trim();

  if (!id) {
    return { ok: false, revertido: false, reason: 'reserva_id_invalido' };
  }
  if (!action || !Object.values(PADCOINS_RESERVA_REVERSAL_ACTIONS).includes(action)) {
    return { ok: false, revertido: false, reason: 'reversal_action_invalida' };
  }

  const reserva = reservaInput;
  const userId = userIdInput && UUID_REGEX.test(String(userIdInput))
    ? String(userIdInput)
    : (reserva?.user_id && UUID_REGEX.test(String(reserva.user_id)) ? String(reserva.user_id) : null);

  if (!userId) {
    return { ok: true, revertido: false, reason: 'user_id_invalido' };
  }

  const sedeId = Number.parseInt(String(reserva?.sede_id ?? ''), 10);

  const earnMovimiento = await fetchReservaEarnMovimiento(supabaseAdmin, id);
  if (!earnMovimiento?.id) {
    return { ok: true, revertido: false, reason: 'sin_acreditacion_previa', reserva_id: id };
  }

  if (await yaFueRevertidaReserva(supabaseAdmin, id, action)) {
    return {
      ok: true,
      revertido: false,
      reason: 'ya_revertida',
      reserva_id: id,
      idempotent: true,
    };
  }

  const earnAmount = resolveEarnAmount(earnMovimiento);
  if (earnAmount <= 0) {
    return { ok: true, revertido: false, reason: 'earn_monto_cero', reserva_id: id };
  }

  const campaignApplication = await fetchCampaignApplicationForReserva(supabaseAdmin, id);
  const referencia = buildReservaReversalReferencia(id, action);
  const reason = reasonOverride ?? REVERSAL_REASONS[action] ?? action;
  const sourceKey = buildPadcoinsSourceKey({
    userId,
    sourceType: PADCOINS_RESERVA_REFERENCIA_TIPO,
    sourceId: id,
    action,
  });

  const clawbackResult = await clawbackPadcoinsEarn(supabaseAdmin, userId, earnAmount, {
    referencia_tipo: referencia.referencia_tipo,
    referencia_id: referencia.referencia_id,
    sede_id: Number.isFinite(sedeId) && sedeId > 0 ? sedeId : null,
    source_type: PADCOINS_RESERVA_REFERENCIA_TIPO,
    source_id: id,
    action,
    source_key: sourceKey,
    original_movement_id: earnMovimiento.id,
    reason,
    buildDescripcion: (appliedAmount, partial) => buildReversalDescripcion(
      reserva,
      action,
      appliedAmount,
      partial,
    ),
    calculation_detail: buildCampaignReversalMetadata(campaignApplication),
  });

  if (clawbackResult.skipped) {
    const skipReason = clawbackResult.reason === 'ya_revertida' ? 'ya_revertida' : clawbackResult.reason;
    return {
      ok: true,
      revertido: false,
      reason: skipReason,
      reserva_id: id,
      padcoins_solicitados: earnAmount,
      padcoins: 0,
      pendiente: clawbackResult.pendiente ?? earnAmount,
      partial: Boolean(clawbackResult.partial),
      saldo: clawbackResult.saldo,
      movimiento: clawbackResult.movimiento ?? null,
      idempotent: clawbackResult.idempotent === true,
      original_movement_id: earnMovimiento.id,
      campaign_application: campaignApplication,
    };
  }

  return {
    ok: true,
    revertido: true,
    reserva_id: id,
    padcoins_solicitados: earnAmount,
    padcoins: clawbackResult.monto_aplicado ?? earnAmount,
    pendiente: clawbackResult.pendiente ?? 0,
    partial: Boolean(clawbackResult.partial),
    reversal_action: action,
    source_key: sourceKey,
    reason,
    saldo: clawbackResult.saldo,
    movimiento: clawbackResult.movimiento,
    original_movement_id: earnMovimiento.id,
    campaign_application: campaignApplication,
  };
}

export async function revertirPadcoinsPorCancelacionTardeReserva(supabaseAdmin, reservaId, options = {}) {
  return revertirPadcoinsPorReservaIncumplimiento(supabaseAdmin, reservaId, {
    ...options,
    reversalAction: PADCOINS_RESERVA_REVERSAL_ACTIONS.CANCELACION_TARDIA,
  });
}

export async function revertirPadcoinsPorNoShowReserva(supabaseAdmin, reservaId, options = {}) {
  return revertirPadcoinsPorReservaIncumplimiento(supabaseAdmin, reservaId, {
    ...options,
    reversalAction: PADCOINS_RESERVA_REVERSAL_ACTIONS.NO_SHOW,
  });
}
