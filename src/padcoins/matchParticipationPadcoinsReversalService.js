import { PADCOINS_MOVEMENT_TYPES } from './padcoinsConfig.js';
import {
  buildPadcoinsSourceKey,
  findExistingPadcoinsMovimientoBySource,
} from './padcoinsIdempotencyService.js';
import { revertirPadcoinsPorCancelacionReserva } from './padcoinsReservaReversalService.js';
import { getPadcoinsSaldo, reversePadcoins } from './padcoinsService.js';
import {
  MATCH_REWARD_EVENT_STATUS,
  MATCH_REWARD_TYPES,
} from '../matches/matchParticipantsConstants.js';

export const MATCH_PARTICIPATION_REVERSAL_ACTIONS = Object.freeze({
  CANCELACION_RESERVA: 'reversal_cancelacion_reserva',
  ADMIN_ANULACION: 'reversal_admin_anulacion',
});

const MATCH_PADCOINS_REFERENCIA_TIPO = 'match_casual';

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

export function buildMatchParticipationReversalReferencia(matchId, userId, reversalAction) {
  return {
    referencia_tipo: MATCH_PADCOINS_REFERENCIA_TIPO,
    referencia_id: `${String(matchId).trim()}:reversal:${String(userId).trim()}:${String(reversalAction).trim()}`,
  };
}

async function listCreditedParticipationRewardEvents(supabaseAdmin, reservaId) {
  const id = Number.parseInt(String(reservaId ?? ''), 10);
  if (!Number.isFinite(id) || id <= 0) {
    return [];
  }

  const { data, error } = await supabaseAdmin
    .from('match_reward_events')
    .select('*')
    .eq('reserva_id', id)
    .eq('reward_type', MATCH_REWARD_TYPES.PADCOINS)
    .eq('status', MATCH_REWARD_EVENT_STATUS.CREDITED);

  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }

  return data ?? [];
}

async function yaFueRevertidaParticipacion(supabaseAdmin, referencia) {
  const existing = await findExistingPadcoinsMovimientoBySource(supabaseAdmin, {
    referencia_tipo: referencia.referencia_tipo,
    referencia_id: referencia.referencia_id,
    tipo: PADCOINS_MOVEMENT_TYPES.REVERSE,
  });
  return Boolean(existing?.id);
}

async function markParticipationRewardEventReversed(supabaseAdmin, eventId, metadata = {}) {
  if (!eventId) return;
  await supabaseAdmin
    .from('match_reward_events')
    .update({
      status: MATCH_REWARD_EVENT_STATUS.REVERSED,
      updated_at: new Date().toISOString(),
      metadata,
    })
    .eq('id', eventId)
    .then(({ error }) => {
      if (error && !isMissingTable(error)) throw error;
    });
}

async function revertSingleParticipationRewardEvent(supabaseAdmin, event, {
  reversalAction,
  reserva = null,
} = {}) {
  const action = String(reversalAction ?? MATCH_PARTICIPATION_REVERSAL_ACTIONS.CANCELACION_RESERVA).trim();
  const userId = String(event?.user_id ?? '').trim();
  const matchId = String(event?.match_id ?? '').trim();
  const amount = Math.abs(Math.trunc(Number(event?.amount ?? 0)));

  if (!userId || !matchId || amount <= 0) {
    return {
      revertido: false,
      reason: 'evento_invalido',
      event_id: event?.id ?? null,
    };
  }

  const referencia = buildMatchParticipationReversalReferencia(matchId, userId, action);
  if (await yaFueRevertidaParticipacion(supabaseAdmin, referencia)) {
    await markParticipationRewardEventReversed(supabaseAdmin, event.id, {
      ...(event.metadata ?? {}),
      reversal_action: action,
      reversal_idempotent: true,
    });
    return {
      revertido: false,
      reason: 'ya_revertida',
      idempotent: true,
      event_id: event.id,
      user_id: userId,
      source_key: event.source_key ?? null,
    };
  }

  const sourceKey = buildPadcoinsSourceKey({
    userId,
    sourceType: MATCH_PADCOINS_REFERENCIA_TIPO,
    sourceId: `${matchId}:${action}`,
    action,
  });

  const saldo = await getPadcoinsSaldo(supabaseAdmin, userId);
  const disponible = Number(saldo.disponible ?? 0);
  const toClaw = Math.min(amount, Math.max(0, disponible));

  if (toClaw <= 0) {
    await markParticipationRewardEventReversed(supabaseAdmin, event.id, {
      ...(event.metadata ?? {}),
      reversal_action: action,
      clawback_pendiente: amount,
      reversal_skipped: 'saldo_insuficiente',
    });
    return {
      revertido: false,
      reason: 'saldo_insuficiente',
      event_id: event.id,
      user_id: userId,
      pendiente: amount,
    };
  }

  const partial = toClaw < amount;
  const descripcion = partial
    ? `Reversa PadCoins participación partido #${matchId} — reserva #${event.reserva_id ?? reserva?.id ?? '?'} (-${toClaw} PC, parcial)`
    : `Reversa PadCoins participación partido #${matchId} — reserva #${event.reserva_id ?? reserva?.id ?? '?'} (-${toClaw} PC)`;

  let clawbackResult;
  try {
    clawbackResult = await reversePadcoins(supabaseAdmin, userId, toClaw, {
      credit: false,
      referencia_tipo: referencia.referencia_tipo,
      referencia_id: referencia.referencia_id,
      sede_id: reserva?.sede_id ?? null,
      action,
      descripcion,
      enforceIdempotency: true,
      metadata: {
        source_key: sourceKey,
        source_type: MATCH_PADCOINS_REFERENCIA_TIPO,
        source_id: matchId,
        reserva_id: String(event.reserva_id ?? reserva?.id ?? ''),
        original_event_id: event.id,
        original_source_key: event.source_key ?? null,
        reversal_action: action,
        clawback_solicitado: amount,
        clawback_aplicado: toClaw,
        clawback_pendiente: amount - toClaw,
      },
    });
  } catch (err) {
    if (err.code === 'PADCOINS_ALREADY_APPLIED' || err.code === 'PADCOINS_DUPLICATE_MOVIMIENTO') {
      clawbackResult = {
        skipped: true,
        reason: 'ya_revertida',
        idempotent: true,
        movimiento: err.movimiento ?? null,
      };
    } else {
      throw err;
    }
  }

  if (clawbackResult?.skipped) {
    await markParticipationRewardEventReversed(supabaseAdmin, event.id, {
      ...(event.metadata ?? {}),
      reversal_action: action,
      reversal_skipped: clawbackResult.reason ?? 'skipped',
    });
    return {
      revertido: false,
      reason: clawbackResult.reason ?? 'skipped',
      idempotent: clawbackResult.idempotent === true,
      event_id: event.id,
      user_id: userId,
    };
  }

  await markParticipationRewardEventReversed(supabaseAdmin, event.id, {
    ...(event.metadata ?? {}),
    reversal_action: action,
    reversal_movimiento_id: clawbackResult.movimiento?.id ?? null,
    clawback_pendiente: amount - toClaw,
  });

  return {
    revertido: true,
    event_id: event.id,
    user_id: userId,
    match_id: matchId,
    padcoins: toClaw,
    pendiente: amount - toClaw,
    partial,
    movimiento: clawbackResult.movimiento ?? null,
    source_key: event.source_key ?? null,
  };
}

/**
 * Revierte PadCoins de participación (match_reward_events) y earn legacy directo al pagador.
 */
export async function revertirPadcoinsParticipacionPorReserva(supabaseAdmin, reservaId, {
  reserva: reservaInput = null,
  reversalAction = MATCH_PARTICIPATION_REVERSAL_ACTIONS.CANCELACION_RESERVA,
} = {}) {
  const id = String(reservaId ?? '').trim();
  if (!id) {
    return { ok: false, revertido: false, reason: 'reserva_id_invalido' };
  }

  const legacyReversal = await revertirPadcoinsPorCancelacionReserva(supabaseAdmin, id, {
    reserva: reservaInput,
  });

  const events = await listCreditedParticipationRewardEvents(supabaseAdmin, id);
  const participationResults = [];

  for (const event of events) {
    participationResults.push(await revertSingleParticipationRewardEvent(supabaseAdmin, event, {
      reversalAction,
      reserva: reservaInput,
    }));
  }

  const matchReverted = participationResults.some((row) => row.revertido === true);
  const legacyReverted = legacyReversal.revertido === true;

  return {
    ok: true,
    revertido: matchReverted || legacyReverted,
    reserva_id: id,
    legacy_reversal: legacyReversal,
    participation_reversals: participationResults,
    events_considered: events.length,
  };
}
