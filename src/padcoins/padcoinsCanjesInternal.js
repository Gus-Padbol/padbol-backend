import { getPremioCanjeableById } from './premiosCanjeablesService.js';
import { PADCOINS_PREMIO_IMAGEN_FALLBACK } from './padcoinsCanjesConfig.js';
import { buildCanjeQrResponse } from './padcoinsCanjeQrService.js';

export const CANJE_SELECT = [
  'id',
  'user_id',
  'sede_id',
  'premio_id',
  'monto_padcoins',
  'estado',
  'codigo',
  'created_at',
  'updated_at',
  'expires_at',
  'entregado_at',
  'entregado_por',
  'aprobado_at',
  'aprobado_por',
  'vencido_at',
].join(', ');

export const PREMIO_CANJE_EMBED = 'nombre, descripcion, imagen_url';
export const CANJE_WITH_PREMIO_SELECT = `${CANJE_SELECT}, premios_canjeables ( ${PREMIO_CANJE_EMBED} )`;

export function buildHttpError(message, status = 400) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function resolvePremioNombreFromCanjeRow(canje) {
  return canje?.premios_canjeables?.nombre ?? canje?.premio_nombre ?? null;
}

export function resolvePremioImagenFromCanjeRow(canje) {
  const raw = canje?.premios_canjeables?.imagen_url ?? canje?.premio_imagen_url ?? null;
  const trimmed = raw != null ? String(raw).trim() : '';
  return trimmed || PADCOINS_PREMIO_IMAGEN_FALLBACK;
}

export function mapCanjeRow(row, { includeQr = false } = {}) {
  if (!row) return null;

  const premio = row.premios_canjeables ?? null;
  const premioNombre = premio?.nombre ?? row.premio_nombre ?? null;
  const premioImagen = resolvePremioImagenFromCanjeRow(row);

  const mapped = {
    id: row.id,
    user_id: row.user_id,
    sede_id: row.sede_id,
    premio_id: row.premio_id,
    premio_nombre: premioNombre,
    premio_descripcion: premio?.descripcion ?? row.premio_descripcion ?? null,
    premio_imagen_url: premioImagen,
    monto_padcoins: row.monto_padcoins,
    estado: row.estado,
    codigo: row.codigo,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at ?? null,
    entregado_at: row.entregado_at ?? null,
    entregado_por: row.entregado_por ?? null,
    aprobado_at: row.aprobado_at ?? null,
    aprobado_por: row.aprobado_por ?? null,
    vencido_at: row.vencido_at ?? null,
  };

  if (includeQr) {
    Object.assign(mapped, buildCanjeQrResponse(mapped, { premioNombre }));
  }

  return mapped;
}

export async function decrementPremioStockIfTracked(supabaseAdmin, premio) {
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

export async function restorePremioStockIfTracked(supabaseAdmin, premioId) {
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
