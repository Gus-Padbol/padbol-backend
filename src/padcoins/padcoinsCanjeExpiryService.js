import { PADCOINS_ORIGINS } from './padcoinsConfig.js';
import { PADCOINS_CANJE_DEFAULT_VALIDEZ_DIAS } from './padcoinsCanjesConfig.js';
import {
  notifyPadcoinsCanjeVencidoPlayer,
} from './padcoinsCanjesNotificationService.js';
import {
  restorePremioStockIfTracked,
} from './padcoinsCanjesInternal.js';
import { reversePadcoins } from './padcoinsService.js';

export function resolveCanjeExpiresAt({
  createdAt,
  expiresAt = null,
  validezDias = PADCOINS_CANJE_DEFAULT_VALIDEZ_DIAS,
}) {
  if (expiresAt) {
    const parsed = new Date(expiresAt);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }

  const created = new Date(createdAt ?? Date.now());
  if (Number.isNaN(created.getTime())) {
    return null;
  }

  const days = Number.parseInt(String(validezDias ?? PADCOINS_CANJE_DEFAULT_VALIDEZ_DIAS), 10);
  const safeDays = Number.isInteger(days) && days > 0 ? days : PADCOINS_CANJE_DEFAULT_VALIDEZ_DIAS;
  const expires = new Date(created.getTime() + safeDays * 24 * 60 * 60 * 1000);
  return expires.toISOString();
}

export function isCanjeExpired(canje, nowMs = Date.now()) {
  const expiresAt = canje?.expires_at ?? resolveCanjeExpiresAt({
    createdAt: canje?.created_at,
    validezDias: canje?.premios_canjeables?.canje_validez_dias ?? canje?.canje_validez_dias,
  });
  if (!expiresAt) return false;
  const expiresMs = new Date(expiresAt).getTime();
  if (Number.isNaN(expiresMs)) return false;
  return expiresMs <= nowMs;
}

export async function vencerCanjePadcoins(supabaseAdmin, canje, deps = {}) {
  const costo = Number(canje.monto_padcoins);
  const now = new Date().toISOString();

  const { data: updated, error: updateErr } = await supabaseAdmin
    .from('padcoins_canjes')
    .update({
      estado: 'vencido',
      vencido_at: now,
      updated_at: now,
    })
    .eq('id', canje.id)
    .in('estado', ['pendiente', 'aprobado'])
    .select('*')
    .maybeSingle();

  if (updateErr) throw updateErr;
  if (!updated) {
    return { updated: false, reason: 'not_vencible' };
  }

  try {
    await reversePadcoins(supabaseAdmin, canje.user_id, costo, {
      credit: true,
      referencia_tipo: PADCOINS_ORIGINS.CANJE_PREMIO,
      referencia_id: canje.id,
      sede_id: canje.sede_id,
      descripcion: `Vencimiento canje ${canje.codigo}`,
      metadata: {
        action: 'refund_vencido',
        canje_id: canje.id,
      },
    });

    await restorePremioStockIfTracked(supabaseAdmin, canje.premio_id);
  } catch (err) {
    try {
      await supabaseAdmin
        .from('padcoins_canjes')
        .update({
          estado: canje.estado,
          vencido_at: null,
          updated_at: new Date().toISOString(),
        })
        .eq('id', canje.id);
    } catch (revertErr) {
      console.error('[padcoinsCanjes] revert estado tras fallo de vencimiento:', revertErr.message);
    }
    throw err;
  }

  if (deps.skipNotifications !== true) {
    await notifyPadcoinsCanjeVencidoPlayer(supabaseAdmin, updated, {
      premioNombre: deps.premioNombre ?? canje.premio_nombre ?? null,
    }, deps).catch((notifyErr) => {
      console.warn('[padcoinsCanjes] notify vencido:', notifyErr.message);
    });
  }

  return { updated: true, canje: updated };
}

export async function expireDuePadcoinsCanjes(supabaseAdmin, {
  batchSize = 100,
  nowMs = Date.now(),
  deps = {},
} = {}) {
  const nowIso = new Date(nowMs).toISOString();

  const { data, error } = await supabaseAdmin
    .from('padcoins_canjes')
    .select('*, premios_canjeables ( nombre )')
    .in('estado', ['pendiente', 'aprobado'])
    .lte('expires_at', nowIso)
    .order('expires_at', { ascending: true })
    .limit(batchSize);

  if (error) throw error;

  const results = [];
  for (const row of data ?? []) {
    const premioNombre = row.premios_canjeables?.nombre ?? null;
    const result = await vencerCanjePadcoins(supabaseAdmin, row, {
      ...deps,
      premioNombre,
    });
    results.push({ canje_id: row.id, ...result });
  }

  return {
    processed: results.length,
    vencidos: results.filter((item) => item.updated).length,
    results,
  };
}
