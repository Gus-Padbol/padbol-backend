import { calculateSurgePrice, normalizeSurgeDeporte } from '../../src/surge.js';
import { createMembresiasSedeService } from '../../src/membresias/membresiasService.js';
import { isMissingMembresiaTableError } from '../membresiasDomain.js';

const PLATFORM_FEE_PCT = 0.03;
export const PRICE_TOLERANCE_ABS = 100;

function parsePositiveInt(value) {
  const n = parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function buildSlotInicioIso(fecha, hora) {
  const f = String(fecha ?? '').trim().slice(0, 10);
  const h = String(hora ?? '').trim().slice(0, 5);
  if (!f || !h) return null;
  return `${f}T${h}:00-03:00`;
}

async function validateAndPriceExtras(supabaseAdmin, sedeId, extrasInput = []) {
  if (!Array.isArray(extrasInput) || !extrasInput.length) return [];

  const ids = [...new Set(
    extrasInput
      .map((e) => parsePositiveInt(e?.id))
      .filter((id) => id != null),
  )];
  if (!ids.length) return [];

  const { data: rows, error } = await supabaseAdmin
    .from('sede_extras')
    .select('id, sede_id, nombre, precio, precio_moneda, activo, aprobado_super')
    .eq('sede_id', sedeId)
    .in('id', ids);

  if (error) throw error;

  const byId = new Map((rows ?? []).map((row) => [Number(row.id), row]));
  const priced = [];

  for (const raw of extrasInput) {
    const id = parsePositiveInt(raw?.id);
    if (id == null) continue;
    const row = byId.get(id);
    if (!row || row.activo === false) {
      throw Object.assign(new Error(`Extra ${id} no disponible`), { status: 400 });
    }
    if (row.aprobado_super === false) {
      throw Object.assign(new Error(`Extra ${id} no aprobado`), { status: 400 });
    }
    const cantidad = Math.max(1, parsePositiveInt(raw?.cantidad ?? raw?.quantity) ?? 1);
    const precio = Number(row.precio) || 0;
    if (precio <= 0) continue;
    priced.push({
      id: row.id,
      nombre: row.nombre,
      precio,
      moneda: row.precio_moneda || 'ARS',
      cantidad,
    });
  }

  return priced;
}

/**
 * Cotiza precio de reserva en servidor (Surge/franjas + extras + comisión).
 */
export async function quoteReservaPrice(supabaseAdmin, params = {}) {
  const sedeId = parsePositiveInt(params.sedeId ?? params.sede_id);
  if (sedeId == null) {
    throw Object.assign(new Error('sedeId inválido'), { status: 400 });
  }

  const duracionMinutos = parsePositiveInt(params.duracionMinutos ?? params.duracion_minutos ?? params.duracion) ?? 90;
  const deporte = normalizeSurgeDeporte(params.deporte ?? 'padbol');
  const slotInicio = buildSlotInicioIso(params.fecha, params.hora ?? params.hora_inicio);

  const surge = await calculateSurgePrice(
    supabaseAdmin,
    sedeId,
    deporte,
    duracionMinutos,
    { slot_inicio: slotInicio },
  );

  const { data: sedeRow } = await supabaseAdmin
    .from('sedes')
    .select('moneda')
    .eq('id', sedeId)
    .maybeSingle();

  const moneda = String(sedeRow?.moneda || params.moneda || 'ARS').trim().toUpperCase() || 'ARS';
  const extras = await validateAndPriceExtras(supabaseAdmin, sedeId, params.extras);
  const extrasSubtotal = extras.reduce((sum, e) => sum + e.precio * e.cantidad, 0);
  let base = Number(surge.precio) || 0;
  let fee = Math.round((base + extrasSubtotal) * PLATFORM_FEE_PCT);
  let total = base + extrasSubtotal + fee;
  let membresiaAplicada = null;

  const userId = params.userId ?? params.user_id ?? null;
  const email = params.email ?? null;
  if (userId || email) {
    try {
      const svc = createMembresiasSedeService({ supabaseAdmin });
      const resolved = await svc.resolveActivaForReserva({ userId, email, sedeId });
      if (resolved?.membresia && resolved?.plan) {
        const adjusted = svc.applyBenefitsToQuoteAmounts({
          base,
          extrasSubtotal,
          beneficios: resolved.plan.beneficios,
          incluidasUsadas: resolved.incluidasUsadas || 0,
          feePct: PLATFORM_FEE_PCT,
        });
        base = adjusted.base;
        fee = adjusted.fee;
        total = adjusted.total;
        membresiaAplicada = {
          membresia_id: resolved.membresia.id,
          sede_id: sedeId,
          plan_id: resolved.plan.id,
          beneficio: adjusted.beneficio_aplicado,
          descuento_monto: adjusted.descuento_monto,
          reserva_incluida: adjusted.reserva_incluida,
        };
      }
    } catch (err) {
      if (!isMissingMembresiaTableError(err) && err?.status !== 503) {
        console.warn('⚠️ membresía en quote:', err.message);
      }
    }
  }

  const pricingSnapshot = {
    base,
    extrasSubtotal,
    fee,
    total,
    moneda,
    deporte,
    duracion_minutos: duracionMinutos,
    slot_inicio: slotInicio,
    surge,
    extras,
    membresia: membresiaAplicada,
    quoted_at: new Date().toISOString(),
  };

  return {
    base,
    extrasSubtotal,
    fee,
    total,
    moneda,
    surge,
    extras,
    membresia: membresiaAplicada,
    pricing: {
      base,
      fee,
      extrasSubtotal,
      total,
    },
    pricing_snapshot: pricingSnapshot,
  };
}

export function assertClientPrecioMatchesQuote(clientPrecio, serverTotal, tolerance = PRICE_TOLERANCE_ABS) {
  if (clientPrecio == null || clientPrecio === '') return;
  const client = Number(String(clientPrecio).replace(/\./g, '').replace(',', '.'));
  if (!Number.isFinite(client)) return;
  if (Math.abs(client - serverTotal) > tolerance) {
    throw Object.assign(
      new Error('El precio enviado no coincide con el precio calculado por el servidor'),
      { status: 400, serverTotal, clientPrecio: client },
    );
  }
}
