import crypto from 'node:crypto';
import { PADCOINS_ORIGINS } from './padcoinsConfig.js';
import {
  getPadcoinsSaldo,
  reversePadcoins,
  spendPadcoins,
} from './padcoinsService.js';
import {
  getPremioCanjeableById,
  isPremioCanjeablePublico,
} from './premiosCanjeablesService.js';

const CANJE_SELECT = [
  'id',
  'user_id',
  'sede_id',
  'premio_id',
  'monto_padcoins',
  'estado',
  'codigo',
  'created_at',
  'updated_at',
  'entregado_at',
  'entregado_por',
].join(', ');

const CANJE_WITH_PREMIO_SELECT = `${CANJE_SELECT}, premios_canjeables ( nombre, descripcion )`;

const ENTREGABLE_ESTADOS = new Set(['pendiente', 'aprobado']);
const CANCELABLE_ESTADOS = new Set(['pendiente', 'aprobado']);

function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

function assertUserId(userId) {
  if (!userId || typeof userId !== 'string') {
    throw buildHttpError('userId inválido');
  }
}

function parseCanjeId(raw) {
  const id = String(raw ?? '').trim();
  return id || null;
}

function parseSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function generateCanjeCodigo() {
  return `PC-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

function mapCanjeRow(row) {
  if (!row) return null;

  const premio = row.premios_canjeables ?? null;

  return {
    id: row.id,
    user_id: row.user_id,
    sede_id: row.sede_id,
    premio_id: row.premio_id,
    premio_nombre: premio?.nombre ?? null,
    premio_descripcion: premio?.descripcion ?? null,
    monto_padcoins: row.monto_padcoins,
    estado: row.estado,
    codigo: row.codigo,
    created_at: row.created_at,
    updated_at: row.updated_at,
    entregado_at: row.entregado_at ?? null,
    entregado_por: row.entregado_por ?? null,
  };
}

async function decrementPremioStockIfTracked(supabaseAdmin, premio) {
  if (premio.stock_disponible == null) {
    return false;
  }

  const stockActual = Number(premio.stock_disponible);
  if (!Number.isInteger(stockActual) || stockActual <= 0) {
    throw buildHttpError('Stock del premio agotado', 409);
  }

  const { data, error } = await supabaseAdmin
    .from('premios_canjeables')
    .update({
      stock_disponible: stockActual - 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', premio.id)
    .eq('stock_disponible', stockActual)
    .select('id, stock_disponible')
    .maybeSingle();

  if (error) throw error;
  if (!data) {
    throw buildHttpError('Stock del premio agotado', 409);
  }

  return true;
}

async function restorePremioStockIfTracked(supabaseAdmin, premioId) {
  const premio = await getPremioCanjeableById(supabaseAdmin, premioId);
  if (!premio || premio.stock_disponible == null) return;

  const stockActual = Number(premio.stock_disponible);
  const { error } = await supabaseAdmin
    .from('premios_canjeables')
    .update({
      stock_disponible: stockActual + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', premioId);

  if (error) throw error;
}

async function rollbackFailedCanje(supabaseAdmin, {
  userId,
  premio,
  costo,
  stockDecremented,
}) {
  await reversePadcoins(supabaseAdmin, userId, costo, {
    credit: true,
    referencia_tipo: PADCOINS_ORIGINS.CANJE_PREMIO,
    referencia_id: premio.id,
    sede_id: premio.sede_id,
    descripcion: `Reversa canje fallido: ${premio.nombre}`,
  }).catch((err) => {
    console.error('[padcoinsCanjes] rollback reversePadcoins:', err.message);
  });

  if (stockDecremented) {
    await restorePremioStockIfTracked(supabaseAdmin, premio.id).catch((err) => {
      console.error('[padcoinsCanjes] rollback restore stock:', err.message);
    });
  }
}

export async function getCanjePadcoinsById(supabaseAdmin, canjeId) {
  const id = parseCanjeId(canjeId);
  if (!id) {
    throw buildHttpError('id de canje inválido');
  }

  const { data, error } = await supabaseAdmin
    .from('padcoins_canjes')
    .select(CANJE_WITH_PREMIO_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

export async function canjearPremioPadcoins(supabaseAdmin, userId, premioId) {
  assertUserId(userId);

  const premio = await getPremioCanjeableById(supabaseAdmin, premioId);
  if (!premio) {
    throw buildHttpError('Premio no encontrado', 404);
  }

  if (!isPremioCanjeablePublico(premio)) {
    throw buildHttpError('Premio no disponible para canje');
  }

  const costo = Number(premio.costo_padcoins);
  if (!Number.isInteger(costo) || costo <= 0) {
    throw buildHttpError('Premio con costo inválido');
  }

  const saldo = await getPadcoinsSaldo(supabaseAdmin, userId);
  if (saldo.disponible < costo) {
    throw buildHttpError('Saldo PadCoins insuficiente');
  }

  // Decremento optimista: UPDATE condicionado por stock actual.
  // Sin transacción DB/RPC queda una ventana de carrera; ver comentario en respuesta al usuario.
  const stockDecremented = await decrementPremioStockIfTracked(supabaseAdmin, premio);

  let spendResult;
  try {
    spendResult = await spendPadcoins(supabaseAdmin, userId, costo, {
      referencia_tipo: PADCOINS_ORIGINS.CANJE_PREMIO,
      referencia_id: premio.id,
      sede_id: premio.sede_id,
      descripcion: `Canje premio: ${premio.nombre}`,
    });
  } catch (err) {
    if (stockDecremented) {
      await restorePremioStockIfTracked(supabaseAdmin, premio.id).catch((restoreErr) => {
        console.error('[padcoinsCanjes] restore stock tras spend fallido:', restoreErr.message);
      });
    }
    throw err;
  }

  const codigo = generateCanjeCodigo();

  try {
    const { data: canje, error: canjeErr } = await supabaseAdmin
      .from('padcoins_canjes')
      .insert({
        user_id: userId,
        sede_id: premio.sede_id,
        premio_id: premio.id,
        monto_padcoins: costo,
        estado: 'pendiente',
        codigo,
      })
      .select(CANJE_SELECT)
      .single();

    if (canjeErr) throw canjeErr;

    return {
      canje: mapCanjeRow(canje),
      codigo,
      saldo: {
        disponible: spendResult.saldo_despues,
        historico_total: spendResult.historico_total,
      },
      movimiento_id: spendResult.movimiento?.id ?? null,
    };
  } catch (err) {
    await rollbackFailedCanje(supabaseAdmin, {
      userId,
      premio,
      costo,
      stockDecremented,
    });
    throw err;
  }
}

export async function listMisCanjesPadcoins(supabaseAdmin, userId, options = {}) {
  assertUserId(userId);

  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, 100)
    : 50;
  const offset = Number.isInteger(options.offset) && options.offset >= 0
    ? options.offset
    : 0;

  let query = supabaseAdmin
    .from('padcoins_canjes')
    .select(CANJE_WITH_PREMIO_SELECT, { count: 'exact' })
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (options.estado) {
    query = query.eq('estado', String(options.estado).trim());
  }

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    canjes: (data ?? []).map((row) => mapCanjeRow(row)),
    paginacion: {
      limit,
      offset,
      total: count ?? (data?.length ?? 0),
    },
  };
}

export async function listCanjesAdminSede(supabaseAdmin, sedeId, options = {}) {
  const parsedSedeId = parseSedeId(sedeId);
  if (!parsedSedeId) {
    throw buildHttpError('sede_id inválido');
  }

  const limit = Number.isInteger(options.limit) && options.limit > 0
    ? Math.min(options.limit, 100)
    : 50;
  const offset = Number.isInteger(options.offset) && options.offset >= 0
    ? options.offset
    : 0;

  let query = supabaseAdmin
    .from('padcoins_canjes')
    .select(CANJE_WITH_PREMIO_SELECT, { count: 'exact' })
    .eq('sede_id', parsedSedeId)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);

  if (options.estado) {
    query = query.eq('estado', String(options.estado).trim());
  }

  const { data, error, count } = await query;
  if (error) throw error;

  return {
    canjes: (data ?? []).map((row) => mapCanjeRow(row)),
    paginacion: {
      limit,
      offset,
      total: count ?? (data?.length ?? 0),
    },
  };
}

export async function entregarCanjePadcoins(supabaseAdmin, canjeId, adminUserId) {
  assertUserId(adminUserId);

  const canje = await getCanjePadcoinsById(supabaseAdmin, canjeId);
  if (!canje) {
    throw buildHttpError('Canje no encontrado', 404);
  }

  if (!ENTREGABLE_ESTADOS.has(canje.estado)) {
    throw buildHttpError(`Canje no entregable en estado ${canje.estado}`);
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('padcoins_canjes')
    .update({
      estado: 'entregado',
      entregado_at: now,
      entregado_por: adminUserId,
      updated_at: now,
    })
    .eq('id', canje.id)
    .select(CANJE_SELECT)
    .single();

  if (error) throw error;
  return mapCanjeRow(data);
}

export async function cancelarCanjePadcoins(supabaseAdmin, canjeId, adminUserId, reason = null) {
  assertUserId(adminUserId);

  const canje = await getCanjePadcoinsById(supabaseAdmin, canjeId);
  if (!canje) {
    throw buildHttpError('Canje no encontrado', 404);
  }

  if (!CANCELABLE_ESTADOS.has(canje.estado)) {
    throw buildHttpError(`Canje no cancelable en estado ${canje.estado}`);
  }

  const costo = Number(canje.monto_padcoins);
  const motivo = reason ? String(reason).trim().slice(0, 500) : null;
  const originalEstado = canje.estado;
  const now = new Date().toISOString();

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('padcoins_canjes')
    .update({
      estado: 'cancelado',
      updated_at: now,
    })
    .eq('id', canje.id)
    .in('estado', Array.from(CANCELABLE_ESTADOS))
    .select(CANJE_SELECT)
    .maybeSingle();

  if (updateErr) throw updateErr;
  if (!updated) {
    throw buildHttpError('Canje no cancelable', 409);
  }

  try {
    // V1: al cancelar un canje pendiente/aprobado se devuelven PadCoins al jugador
    // mediante reversePadcoins (credit=true). historico_total no se modifica.
    // Si el canje ya fue entregado, no se permite cancelar desde este flujo.
    await reversePadcoins(supabaseAdmin, canje.user_id, costo, {
      credit: true,
      referencia_tipo: PADCOINS_ORIGINS.CANJE_PREMIO,
      referencia_id: canje.id,
      sede_id: canje.sede_id,
      created_by: adminUserId,
      descripcion: motivo
        ? `Cancelación canje ${canje.codigo}: ${motivo}`
        : `Cancelación canje ${canje.codigo}`,
    });

    await restorePremioStockIfTracked(supabaseAdmin, canje.premio_id);
  } catch (err) {
    await supabaseAdmin
      .from('padcoins_canjes')
      .update({
        estado: originalEstado,
        updated_at: new Date().toISOString(),
      })
      .eq('id', canje.id)
      .catch((revertErr) => {
        console.error('[padcoinsCanjes] revert estado tras fallo de devolución:', revertErr.message);
      });
    throw err;
  }

  return mapCanjeRow(updated);
}
