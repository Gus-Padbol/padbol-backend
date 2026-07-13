import crypto from 'node:crypto';
import { PADCOINS_ORIGINS } from './padcoinsConfig.js';
import {
  buildMovimientoMetadata,
} from './padcoinsIdempotencyService.js';
import {
  getPadcoinsSaldo,
  reversePadcoins,
  spendPadcoins,
} from './padcoinsService.js';
import {
  getPremioCanjeableById,
  isPremioCanjeablePublico,
} from './premiosCanjeablesService.js';
import { buildPaginatedPayload } from './padcoinsPagination.js';
import {
  notifyPadcoinsCanjeAprobadoPlayer,
  notifyPadcoinsCanjeCanceladoPlayer,
  notifyPadcoinsCanjeCreated,
  notifyPadcoinsCanjeEntregadoPlayer,
} from './padcoinsCanjesNotificationService.js';
import { assertCanjeLimitsAllowRedemption } from './padcoinsCanjeLimitsService.js';
import {
  isCanjeExpired,
  resolveCanjeExpiresAt,
  vencerCanjePadcoins,
} from './padcoinsCanjeExpiryService.js';
import { buildCanjeQrResponse } from './padcoinsCanjeQrService.js';
import {
  PADCOINS_CANJE_CANCELABLE_ESTADOS,
  PADCOINS_CANJE_ENTREGABLE_ESTADOS,
  PADCOINS_CANJE_ESTADOS_FINALES,
} from './padcoinsCanjesConfig.js';
import {
  CANJE_SELECT,
  CANJE_WITH_PREMIO_SELECT,
  buildHttpError,
  decrementPremioStockIfTracked,
  mapCanjeRow,
  restorePremioStockIfTracked,
  resolvePremioNombreFromCanjeRow,
} from './padcoinsCanjesInternal.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CANJE_CODIGO_REGEX = /^PC-[0-9A-F]{12}$/;

function assertUserId(userId) {
  if (!userId || typeof userId !== 'string') {
    throw buildHttpError('userId inválido');
  }
}

function parseCanjeId(raw) {
  const id = String(raw ?? '').trim();
  return id || null;
}

function parseCanjeCodigo(raw) {
  const codigo = String(raw ?? '').trim().toUpperCase();
  if (!codigo) return null;
  if (!CANJE_CODIGO_REGEX.test(codigo)) {
    throw buildHttpError('codigo inválido');
  }
  return codigo;
}

function parseSedeId(raw) {
  const sid = Number.parseInt(String(raw ?? '').trim(), 10);
  return Number.isFinite(sid) && sid > 0 ? sid : null;
}

function parseOptionalUserId(raw) {
  const userId = String(raw ?? '').trim();
  if (!userId) return null;
  if (!UUID_REGEX.test(userId)) {
    throw buildHttpError('user_id inválido');
  }
  return userId;
}

function generateCanjeCodigo() {
  return `PC-${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
}

async function findPendingCanjeForPremio(supabaseAdmin, userId, premioId) {
  const { data, error } = await supabaseAdmin
    .from('padcoins_canjes')
    .select(CANJE_SELECT)
    .eq('user_id', userId)
    .eq('premio_id', premioId)
    .in('estado', ['pendiente', 'aprobado'])
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) throw error;
  return data ?? null;
}

async function rollbackFailedCanje(supabaseAdmin, {
  userId,
  premio,
  costo,
  stockDecremented,
  canjeId,
}) {
  await reversePadcoins(supabaseAdmin, userId, costo, {
    credit: true,
    referencia_tipo: PADCOINS_ORIGINS.CANJE_PREMIO,
    referencia_id: canjeId ?? premio.id,
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

async function fetchCanjeRow(supabaseAdmin, filters) {
  let query = supabaseAdmin
    .from('padcoins_canjes')
    .select(CANJE_WITH_PREMIO_SELECT);

  if (filters.id) query = query.eq('id', filters.id);
  if (filters.codigo) query = query.eq('codigo', filters.codigo);

  const { data, error } = await query.maybeSingle();
  if (error) throw error;
  return data ?? null;
}

export async function ensureCanjeFreshOrExpire(supabaseAdmin, canjeRow, deps = {}) {
  if (!canjeRow) return null;
  if (PADCOINS_CANJE_ESTADOS_FINALES.has(canjeRow.estado)) {
    return canjeRow;
  }
  if (!isCanjeExpired(canjeRow)) {
    return canjeRow;
  }

  const premioNombre = resolvePremioNombreFromCanjeRow(canjeRow);
  const result = await vencerCanjePadcoins(supabaseAdmin, canjeRow, {
    ...deps,
    premioNombre,
  });

  if (result.updated) {
    return fetchCanjeRow(supabaseAdmin, { id: canjeRow.id });
  }

  return fetchCanjeRow(supabaseAdmin, { id: canjeRow.id });
}

export async function getCanjePadcoinsById(supabaseAdmin, canjeId, deps = {}) {
  const id = parseCanjeId(canjeId);
  if (!id) {
    throw buildHttpError('id de canje inválido');
  }

  const row = await fetchCanjeRow(supabaseAdmin, { id });
  return ensureCanjeFreshOrExpire(supabaseAdmin, row, deps);
}

export async function getCanjePadcoinsByCodigo(supabaseAdmin, codigo, deps = {}) {
  const normalized = parseCanjeCodigo(codigo);
  if (!normalized) {
    throw buildHttpError('codigo inválido');
  }

  const row = await fetchCanjeRow(supabaseAdmin, { codigo: normalized });
  return ensureCanjeFreshOrExpire(supabaseAdmin, row, deps);
}

export async function getCanjePadcoinsForPlayer(supabaseAdmin, canjeId, userId, deps = {}) {
  assertUserId(userId);
  const canje = await getCanjePadcoinsById(supabaseAdmin, canjeId, deps);
  if (!canje) {
    throw buildHttpError('Canje no encontrado', 404);
  }
  if (canje.user_id !== userId) {
    throw buildHttpError('No autorizado', 403);
  }
  return canje;
}

export async function canjearPremioPadcoins(supabaseAdmin, userId, premioId, deps = {}) {
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

  const pendingCanje = await findPendingCanjeForPremio(supabaseAdmin, userId, premio.id);
  if (pendingCanje) {
    const fresh = await ensureCanjeFreshOrExpire(supabaseAdmin, pendingCanje, deps);
    if (fresh && ['pendiente', 'aprobado'].includes(fresh.estado)) {
      const saldoActual = await getPadcoinsSaldo(supabaseAdmin, userId);
      const mapped = mapCanjeRow(fresh, { includeQr: true });
      return {
        canje: mapped,
        codigo: fresh.codigo,
        saldo: {
          disponible: saldoActual.disponible,
          historico_total: saldoActual.historico_total,
        },
        movimiento_id: null,
        idempotent: true,
        ...buildCanjeQrResponse(mapped, { premioNombre: premio.nombre }),
      };
    }
  }

  await assertCanjeLimitsAllowRedemption(supabaseAdmin, premio, { userId });

  const canjeId = crypto.randomUUID();
  const stockDecremented = await decrementPremioStockIfTracked(supabaseAdmin, premio);

  const spendMetadata = buildMovimientoMetadata({
    sourceType: PADCOINS_ORIGINS.CANJE_PREMIO,
    sourceId: canjeId,
    action: 'spend',
  });

  let spendResult;
  try {
    spendResult = await spendPadcoins(supabaseAdmin, userId, costo, {
      referencia_tipo: PADCOINS_ORIGINS.CANJE_PREMIO,
      referencia_id: canjeId,
      sede_id: premio.sede_id,
      descripcion: `Canje premio: ${premio.nombre}`,
      metadata: spendMetadata,
      calculation_detail: {
        premio_id: premio.id,
        premio_nombre: premio.nombre,
        costo_padcoins: costo,
      },
    });
  } catch (err) {
    if (stockDecremented) {
      await restorePremioStockIfTracked(supabaseAdmin, premio.id).catch(() => null);
    }
    throw err;
  }

  if (spendResult.skipped) {
    if (stockDecremented) {
      await restorePremioStockIfTracked(supabaseAdmin, premio.id).catch(() => null);
    }
    throw buildHttpError('Canje ya procesado', 409);
  }

  const codigo = generateCanjeCodigo();
  const createdAt = new Date().toISOString();
  const expiresAt = resolveCanjeExpiresAt({
    createdAt,
    validezDias: premio.canje_validez_dias,
  });

  try {
    const { data: canje, error: canjeErr } = await supabaseAdmin
      .from('padcoins_canjes')
      .insert({
        id: canjeId,
        user_id: userId,
        sede_id: premio.sede_id,
        premio_id: premio.id,
        monto_padcoins: costo,
        estado: 'pendiente',
        codigo,
        expires_at: expiresAt,
        created_at: createdAt,
        updated_at: createdAt,
      })
      .select(CANJE_SELECT)
      .single();

    if (canjeErr) {
      if (canjeErr.code === '23505') {
        const existing = await findPendingCanjeForPremio(supabaseAdmin, userId, premio.id);
        if (existing) {
          const mappedExisting = mapCanjeRow(existing, { includeQr: true });
          return {
            canje: mappedExisting,
            codigo: existing.codigo,
            saldo: {
              disponible: spendResult.saldo_despues,
              historico_total: spendResult.historico_total,
            },
            movimiento_id: spendResult.movimiento?.id ?? null,
            idempotent: true,
            ...buildCanjeQrResponse(mappedExisting, { premioNombre: premio.nombre }),
          };
        }
      }
      throw canjeErr;
    }

    const mappedCanje = mapCanjeRow({
      ...canje,
      premios_canjeables: { nombre: premio.nombre, descripcion: premio.descripcion, imagen_url: premio.imagen_url },
    }, { includeQr: true });

    if (deps.skipNotifications !== true) {
      await notifyPadcoinsCanjeCreated(supabaseAdmin, {
        canje: mappedCanje,
        premioNombre: premio.nombre,
      }, deps).catch((notifyErr) => {
        console.warn('[padcoinsCanjes] notify created:', notifyErr.message);
      });
    }

    const qr = buildCanjeQrResponse(mappedCanje, { premioNombre: premio.nombre });

    return {
      canje: mappedCanje,
      codigo,
      saldo: {
        disponible: spendResult.saldo_despues,
        historico_total: spendResult.historico_total,
      },
      movimiento_id: spendResult.movimiento?.id ?? null,
      ...qr,
    };
  } catch (err) {
    await rollbackFailedCanje(supabaseAdmin, {
      userId,
      premio,
      costo,
      stockDecremented,
      canjeId,
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
    .order('created_at', { ascending: false });

  if (options.estado) {
    query = query.eq('estado', String(options.estado).trim());
  }

  const { data, error, count } = await query.range(offset, offset + limit - 1);
  if (error) throw error;

  const canjes = (data ?? []).map((row) => mapCanjeRow(row));
  const total = count ?? canjes.length;

  return buildPaginatedPayload(canjes, { limit, offset, total }, 'canjes');
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
    .order('created_at', { ascending: false });

  if (options.estado) {
    query = query.eq('estado', String(options.estado).trim());
  }

  const userId = parseOptionalUserId(options.user_id ?? options.usuario_id ?? options.jugador_id);
  if (userId) {
    query = query.eq('user_id', userId);
  }

  const { data, error, count } = await query.range(offset, offset + limit - 1);
  if (error) throw error;

  const canjes = (data ?? []).map((row) => mapCanjeRow(row));
  const total = count ?? canjes.length;

  return buildPaginatedPayload(canjes, { limit, offset, total }, 'canjes');
}

export async function aprobarCanjePadcoins(supabaseAdmin, canjeId, adminUserId, deps = {}) {
  assertUserId(adminUserId);

  const canje = await getCanjePadcoinsById(supabaseAdmin, canjeId, deps);
  if (!canje) {
    throw buildHttpError('Canje no encontrado', 404);
  }

  if (canje.estado !== 'pendiente') {
    throw buildHttpError(`Canje no aprobable en estado ${canje.estado}`);
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('padcoins_canjes')
    .update({
      estado: 'aprobado',
      aprobado_at: now,
      aprobado_por: adminUserId,
      updated_at: now,
    })
    .eq('id', canje.id)
    .eq('estado', 'pendiente')
    .select(CANJE_WITH_PREMIO_SELECT)
    .single();

  if (error) throw error;

  const mapped = mapCanjeRow(data, { includeQr: true });
  const premioNombre = resolvePremioNombreFromCanjeRow(canje);

  if (deps.skipNotifications !== true) {
    await notifyPadcoinsCanjeAprobadoPlayer(supabaseAdmin, mapped, { premioNombre }, deps)
      .catch((notifyErr) => {
        console.warn('[padcoinsCanjes] notify aprobado:', notifyErr.message);
      });
  }

  return mapped;
}

export async function entregarCanjePadcoins(supabaseAdmin, canjeId, adminUserId, deps = {}) {
  assertUserId(adminUserId);

  const canje = await getCanjePadcoinsById(supabaseAdmin, canjeId, deps);
  if (!canje) {
    throw buildHttpError('Canje no encontrado', 404);
  }

  if (!PADCOINS_CANJE_ENTREGABLE_ESTADOS.has(canje.estado)) {
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
    .in('estado', Array.from(PADCOINS_CANJE_ENTREGABLE_ESTADOS))
    .select(CANJE_WITH_PREMIO_SELECT)
    .single();

  if (error) throw error;

  const mapped = mapCanjeRow(data);
  const premioNombre = resolvePremioNombreFromCanjeRow(canje);

  if (deps.skipNotifications !== true) {
    await notifyPadcoinsCanjeEntregadoPlayer(supabaseAdmin, mapped, { premioNombre }, deps)
      .catch((notifyErr) => {
        console.warn('[padcoinsCanjes] notify entregado:', notifyErr.message);
      });
  }

  return mapped;
}

export async function cancelarCanjePadcoins(supabaseAdmin, canjeId, adminUserId, reason = null, deps = {}) {
  assertUserId(adminUserId);

  const canje = await getCanjePadcoinsById(supabaseAdmin, canjeId, deps);
  if (!canje) {
    throw buildHttpError('Canje no encontrado', 404);
  }

  if (!PADCOINS_CANJE_CANCELABLE_ESTADOS.has(canje.estado)) {
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
    .in('estado', Array.from(PADCOINS_CANJE_CANCELABLE_ESTADOS))
    .select(CANJE_WITH_PREMIO_SELECT)
    .maybeSingle();

  if (updateErr) throw updateErr;
  if (!updated) {
    throw buildHttpError('Canje no cancelable', 409);
  }

  try {
    await reversePadcoins(supabaseAdmin, canje.user_id, costo, {
      credit: true,
      referencia_tipo: PADCOINS_ORIGINS.CANJE_PREMIO,
      referencia_id: canje.id,
      sede_id: canje.sede_id,
      created_by: adminUserId,
      descripcion: motivo
        ? `Cancelación canje ${canje.codigo}: ${motivo}`
        : `Cancelación canje ${canje.codigo}`,
      metadata: {
        action: 'refund_cancelado',
        canje_id: canje.id,
      },
    });

    await restorePremioStockIfTracked(supabaseAdmin, canje.premio_id);
  } catch (err) {
    try {
      await supabaseAdmin
        .from('padcoins_canjes')
        .update({
          estado: originalEstado,
          updated_at: new Date().toISOString(),
        })
        .eq('id', canje.id);
    } catch (revertErr) {
      console.error('[padcoinsCanjes] revert estado tras fallo de devolución:', revertErr.message);
    }
    throw err;
  }

  const mapped = mapCanjeRow(updated);
  const premioNombre = resolvePremioNombreFromCanjeRow(canje);

  if (deps.skipNotifications !== true) {
    await notifyPadcoinsCanjeCanceladoPlayer(supabaseAdmin, mapped, {
      premioNombre,
      reason: motivo,
    }, deps).catch((notifyErr) => {
      console.warn('[padcoinsCanjes] notify cancelado:', notifyErr.message);
    });
  }

  return mapped;
}

export async function validarCanjePadcoinsAdmin(supabaseAdmin, {
  canjeId = null,
  codigo = null,
} = {}, deps = {}) {
  let canje = null;

  if (canjeId) {
    canje = await getCanjePadcoinsById(supabaseAdmin, canjeId, deps);
  } else if (codigo) {
    canje = await getCanjePadcoinsByCodigo(supabaseAdmin, codigo, deps);
  } else {
    throw buildHttpError('id o codigo es requerido');
  }

  if (!canje) {
    throw buildHttpError('Canje no encontrado', 404);
  }

  const mapped = mapCanjeRow(canje, { includeQr: true });
  return {
    canje: mapped,
    entregable: PADCOINS_CANJE_ENTREGABLE_ESTADOS.has(mapped.estado),
    cancelable: PADCOINS_CANJE_CANCELABLE_ESTADOS.has(mapped.estado),
    aprobable: mapped.estado === 'pendiente',
    vencido: mapped.estado === 'vencido',
    final: PADCOINS_CANJE_ESTADOS_FINALES.has(mapped.estado),
  };
}

export { expireDuePadcoinsCanjes } from './padcoinsCanjeExpiryService.js';
