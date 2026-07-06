import {
  PADCOINS_MOVEMENT_TYPES,
} from './padcoinsConfig.js';
import {
  applyPadcoinsEarnCaps,
  appendPadcoinsEarnCapToDescripcion,
} from './padcoinsEarnLimitsService.js';

const VALID_MOVEMENT_TYPES = new Set(Object.values(PADCOINS_MOVEMENT_TYPES));

function assertUserId(userId) {
  if (!userId || typeof userId !== 'string') {
    throw new Error('userId inválido');
  }
}

function assertNonZeroAmount(amount) {
  const parsed = Number(amount);
  if (!Number.isInteger(parsed) || parsed === 0) {
    throw new Error('amount debe ser un entero distinto de cero');
  }
  return parsed;
}

function assertPositiveAmount(amount) {
  const parsed = assertNonZeroAmount(amount);
  if (parsed < 0) {
    throw new Error('amount debe ser mayor a cero');
  }
  return parsed;
}

function normalizeOptions(options = {}) {
  return {
    referencia_tipo: options.referencia_tipo ?? null,
    referencia_id: options.referencia_id != null ? String(options.referencia_id) : null,
    sede_id: options.sede_id ?? null,
    descripcion: options.descripcion ?? null,
    created_by: options.created_by ?? null,
  };
}

function buildMovimientoPayload(userId, tipo, monto, saldoAntes, saldoDespues, options) {
  if (!VALID_MOVEMENT_TYPES.has(tipo)) {
    throw new Error(`Tipo de movimiento PadCoins inválido: ${tipo}`);
  }

  return {
    user_id: userId,
    tipo,
    monto,
    saldo_antes: saldoAntes,
    saldo_despues: saldoDespues,
    referencia_tipo: options.referencia_tipo,
    referencia_id: options.referencia_id,
    sede_id: options.sede_id,
    descripcion: options.descripcion,
    created_by: options.created_by,
  };
}

async function fetchSaldoRow(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('padcoins_saldo')
    .select('id, user_id, disponible, historico_total, created_at, updated_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;
  return data;
}

async function insertSaldoInicial(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('padcoins_saldo')
    .insert({
      user_id: userId,
      disponible: 0,
      historico_total: 0,
    })
    .select('id, user_id, disponible, historico_total, created_at, updated_at')
    .single();

  if (error) {
    if (error.code === '23505') {
      return fetchSaldoRow(supabaseAdmin, userId);
    }
    throw error;
  }

  return data;
}

async function getOrCreateSaldoRow(supabaseAdmin, userId) {
  const existing = await fetchSaldoRow(supabaseAdmin, userId);
  if (existing) return existing;
  return insertSaldoInicial(supabaseAdmin, userId);
}

async function persistSaldoChange(supabaseAdmin, saldoRow, nextDisponible, nextHistorico) {
  if (nextDisponible < 0) {
    throw new Error('Saldo PadCoins insuficiente');
  }
  if (nextHistorico < 0) {
    throw new Error('historico_total PadCoins inválido');
  }

  const { data, error } = await supabaseAdmin
    .from('padcoins_saldo')
    .update({
      disponible: nextDisponible,
      historico_total: nextHistorico,
      updated_at: new Date().toISOString(),
    })
    .eq('id', saldoRow.id)
    .select('id, user_id, disponible, historico_total, created_at, updated_at')
    .single();

  if (error) throw error;
  return data;
}

async function insertMovimiento(supabaseAdmin, payload) {
  const { data, error } = await supabaseAdmin
    .from('padcoins_movimientos')
    .insert(payload)
    .select('*')
    .single();

  if (error) throw error;
  return data;
}

async function applyBalanceChange(
  supabaseAdmin,
  userId,
  {
    deltaDisponible,
    deltaHistorico = 0,
    tipo,
    monto,
    options = {},
  },
) {
  assertUserId(userId);

  const saldoRow = await getOrCreateSaldoRow(supabaseAdmin, userId);
  const saldoAntes = Number(saldoRow.disponible ?? 0);
  const historicoAntes = Number(saldoRow.historico_total ?? 0);
  const saldoDespues = saldoAntes + deltaDisponible;
  const historicoDespues = historicoAntes + deltaHistorico;

  const updatedSaldo = await persistSaldoChange(
    supabaseAdmin,
    saldoRow,
    saldoDespues,
    historicoDespues,
  );

  const movimiento = await insertMovimiento(
    supabaseAdmin,
    buildMovimientoPayload(userId, tipo, monto, saldoAntes, saldoDespues, options),
  );

  return {
    saldo: updatedSaldo,
    movimiento,
    monto_aplicado: Math.abs(monto),
    saldo_antes: saldoAntes,
    saldo_despues: saldoDespues,
    historico_total: historicoDespues,
  };
}

export async function getPadcoinsSaldo(supabaseAdmin, userId) {
  assertUserId(userId);

  const saldo = await getOrCreateSaldoRow(supabaseAdmin, userId);

  return {
    user_id: saldo.user_id,
    disponible: Number(saldo.disponible ?? 0),
    historico_total: Number(saldo.historico_total ?? 0),
    created_at: saldo.created_at ?? null,
    updated_at: saldo.updated_at ?? null,
  };
}

export async function addPadcoins(supabaseAdmin, userId, amount, options = {}) {
  const parsedAmount = assertPositiveAmount(amount);
  const tipo = options.tipo ?? PADCOINS_MOVEMENT_TYPES.EARN;
  let finalAmount = parsedAmount;
  let capResult = null;

  if (tipo !== PADCOINS_MOVEMENT_TYPES.EARN && tipo !== PADCOINS_MOVEMENT_TYPES.ADJUST) {
    throw new Error('addPadcoins solo admite movimientos earn o adjust positivos');
  }

  if (tipo === PADCOINS_MOVEMENT_TYPES.EARN && options.skipEarnCaps !== true) {
    capResult = await applyPadcoinsEarnCaps(
      supabaseAdmin,
      userId,
      parsedAmount,
      {
        now: options.now,
        timeZone: options.timeZone,
        limits: options.earnLimits,
      },
    );
    finalAmount = capResult.amountToCredit;

    if (finalAmount <= 0) {
      return {
        skipped: true,
        reason: capResult.reason ?? 'limite_alcanzado',
        cap: capResult,
        monto_solicitado: parsedAmount,
        monto_aplicado: 0,
        saldo: await getPadcoinsSaldo(supabaseAdmin, userId),
      };
    }
  }

  const normalizedOptions = normalizeOptions({
    ...options,
    descripcion: capResult?.capped
      ? appendPadcoinsEarnCapToDescripcion(options.descripcion, capResult)
      : options.descripcion,
  });

  const deltaHistorico = tipo === PADCOINS_MOVEMENT_TYPES.EARN ? finalAmount : 0;

  const result = await applyBalanceChange(supabaseAdmin, userId, {
    deltaDisponible: finalAmount,
    deltaHistorico,
    tipo,
    monto: finalAmount,
    options: normalizedOptions,
  });

  if (capResult) {
    return {
      ...result,
      cap: capResult,
      monto_solicitado: parsedAmount,
      monto_aplicado: finalAmount,
    };
  }

  return result;
}

export async function spendPadcoins(supabaseAdmin, userId, amount, options = {}) {
  const parsedAmount = assertPositiveAmount(amount);
  const normalizedOptions = normalizeOptions(options);

  return applyBalanceChange(supabaseAdmin, userId, {
    deltaDisponible: -parsedAmount,
    deltaHistorico: 0,
    tipo: PADCOINS_MOVEMENT_TYPES.SPEND,
    monto: -parsedAmount,
    options: normalizedOptions,
  });
}

export async function adjustPadcoins(supabaseAdmin, userId, amount, options = {}) {
  const parsedAmount = assertNonZeroAmount(amount);
  const normalizedOptions = normalizeOptions(options);

  return applyBalanceChange(supabaseAdmin, userId, {
    deltaDisponible: parsedAmount,
    deltaHistorico: 0,
    tipo: PADCOINS_MOVEMENT_TYPES.ADJUST,
    monto: parsedAmount,
    options: normalizedOptions,
  });
}

export async function reversePadcoins(supabaseAdmin, userId, amount, options = {}) {
  const parsedAmount = assertPositiveAmount(amount);
  const normalizedOptions = normalizeOptions(options);
  const credit = options.credit !== false;
  const deltaDisponible = credit ? parsedAmount : -parsedAmount;

  return applyBalanceChange(supabaseAdmin, userId, {
    deltaDisponible,
    deltaHistorico: 0,
    tipo: PADCOINS_MOVEMENT_TYPES.REVERSE,
    monto: credit ? parsedAmount : -parsedAmount,
    options: normalizedOptions,
  });
}

export async function listPadcoinsMovimientos(supabaseAdmin, userId, options = {}) {
  assertUserId(userId);

  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, 100)
    : 50;
  const offset = Number.isInteger(options.offset) && options.offset >= 0
    ? options.offset
    : 0;

  const { data, error, count } = await supabaseAdmin
    .from('padcoins_movimientos')
    .select('*', { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (error) throw error;

  return {
    movimientos: data ?? [],
    paginacion: {
      limit,
      offset,
      total: count ?? (data?.length ?? 0),
    },
  };
}
