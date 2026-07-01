import { parsePartidoResultado } from './clasificacionService.js';

const PARTIDO_FUENTE_SELECT = [
  'id',
  'torneo_id',
  'estado',
  'grupo',
  'equipo_a_id',
  'equipo_b_id',
  'ganador_equipo_id',
  'resultado',
  'partido_siguiente_id',
  'partido_siguiente_slot',
].join(', ');

const PARTIDO_DESTINO_SELECT = [
  'id',
  'torneo_id',
  'estado',
  'equipo_a_id',
  'equipo_b_id',
].join(', ');

const ESTADOS_DESTINO_PROTEGIDOS = new Set(['finalizado', 'en_curso']);

function normalizeEstado(estado) {
  return String(estado ?? '').trim().toLowerCase();
}

function buildResult({
  status,
  reason,
  partidoId,
  destinoPartidoId,
  slot,
  ganadorEquipoId,
}) {
  const result = {
    status,
    reason,
    partido_id: Number(partidoId),
  };
  if (destinoPartidoId != null) result.destino_partido_id = Number(destinoPartidoId);
  if (slot != null) result.slot = slot;
  if (ganadorEquipoId != null) result.ganador_equipo_id = Number(ganadorEquipoId);
  return result;
}

/**
 * @param {object} partido
 * @returns {number | null}
 */
export function getWinnerForPartido(partido) {
  const eqA = partido?.equipo_a_id;
  const eqB = partido?.equipo_b_id;
  const ganador = partido?.ganador_equipo_id;

  if (ganador != null && (ganador === eqA || ganador === eqB)) {
    return Number(ganador);
  }

  const parsed = parsePartidoResultado(partido);
  const winnerId = parsed?.winner_id;
  if (winnerId != null && (winnerId === eqA || winnerId === eqB)) {
    return Number(winnerId);
  }

  return null;
}

/**
 * @param {object} partido
 * @returns {null | {
 *   destinoPartidoId: number,
 *   slot: 'A' | 'B',
 *   column: 'equipo_a_id' | 'equipo_b_id'
 * }}
 */
export function resolveDestinoSlot(partido) {
  const destinoPartidoId = partido?.partido_siguiente_id;
  if (destinoPartidoId == null) return null;

  const slot = String(partido?.partido_siguiente_slot ?? '').trim().toUpperCase();
  if (slot === 'A') {
    return {
      destinoPartidoId: Number(destinoPartidoId),
      slot: 'A',
      column: 'equipo_a_id',
    };
  }
  if (slot === 'B') {
    return {
      destinoPartidoId: Number(destinoPartidoId),
      slot: 'B',
      column: 'equipo_b_id',
    };
  }

  return null;
}

function buildDestinoUpdatePatch(destino, column, ganadorEquipoId) {
  const patch = { [column]: ganadorEquipoId };

  const equipoA = column === 'equipo_a_id' ? ganadorEquipoId : destino.equipo_a_id;
  const equipoB = column === 'equipo_b_id' ? ganadorEquipoId : destino.equipo_b_id;
  const estado = normalizeEstado(destino.estado);

  if (
    equipoA != null
    && equipoB != null
    && !ESTADOS_DESTINO_PROTEGIDOS.has(estado)
  ) {
    patch.estado = 'pendiente';
  }

  return patch;
}

/**
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {{ partidoId: number | string }} params
 */
export async function advanceWinnerIfNeeded(supabaseAdmin, { partidoId }) {
  const id = Number(partidoId);
  if (!Number.isFinite(id) || id <= 0) {
    return buildResult({
      status: 'failed',
      reason: 'partido_not_found',
      partidoId: partidoId ?? 0,
    });
  }

  const { data: partido, error: errFuente } = await supabaseAdmin
    .from('partidos')
    .select(PARTIDO_FUENTE_SELECT)
    .eq('id', id)
    .maybeSingle();

  if (errFuente) {
    return buildResult({
      status: 'failed',
      reason: 'partido_not_found',
      partidoId: id,
    });
  }

  if (!partido) {
    return buildResult({
      status: 'failed',
      reason: 'partido_not_found',
      partidoId: id,
    });
  }

  if (normalizeEstado(partido.estado) !== 'finalizado') {
    return buildResult({
      status: 'skipped',
      reason: 'not_finalizado',
      partidoId: id,
    });
  }

  if (partido.grupo != null && String(partido.grupo).trim() !== '') {
    return buildResult({
      status: 'skipped',
      reason: 'fase_grupos',
      partidoId: id,
    });
  }

  const ganadorEquipoId = getWinnerForPartido(partido);
  if (ganadorEquipoId == null) {
    return buildResult({
      status: 'skipped',
      reason: 'no_ganador',
      partidoId: id,
    });
  }

  if (partido.partido_siguiente_id == null) {
    return buildResult({
      status: 'skipped',
      reason: 'no_destino',
      partidoId: id,
      ganadorEquipoId,
    });
  }

  const destinoSlot = resolveDestinoSlot(partido);
  if (!destinoSlot) {
    return buildResult({
      status: 'failed',
      reason: 'slot_invalido',
      partidoId: id,
      destinoPartidoId: partido.partido_siguiente_id,
      ganadorEquipoId,
    });
  }

  const { data: destino, error: errDestino } = await supabaseAdmin
    .from('partidos')
    .select(PARTIDO_DESTINO_SELECT)
    .eq('id', destinoSlot.destinoPartidoId)
    .maybeSingle();

  if (errDestino || !destino) {
    return buildResult({
      status: 'failed',
      reason: 'destino_not_found',
      partidoId: id,
      destinoPartidoId: destinoSlot.destinoPartidoId,
      slot: destinoSlot.slot,
      ganadorEquipoId,
    });
  }

  if (Number(destino.torneo_id) !== Number(partido.torneo_id)) {
    return buildResult({
      status: 'failed',
      reason: 'torneo_mismatch',
      partidoId: id,
      destinoPartidoId: destino.id,
      slot: destinoSlot.slot,
      ganadorEquipoId,
    });
  }

  const slotValue = destino[destinoSlot.column];
  if (slotValue == null) {
    const patch = buildDestinoUpdatePatch(destino, destinoSlot.column, ganadorEquipoId);
    const { error: errUpdate } = await supabaseAdmin
      .from('partidos')
      .update(patch)
      .eq('id', destino.id);

    if (errUpdate) {
      return buildResult({
        status: 'failed',
        reason: 'update_failed',
        partidoId: id,
        destinoPartidoId: destino.id,
        slot: destinoSlot.slot,
        ganadorEquipoId,
      });
    }

    return buildResult({
      status: 'advanced',
      reason: 'ganador_avanzado',
      partidoId: id,
      destinoPartidoId: destino.id,
      slot: destinoSlot.slot,
      ganadorEquipoId,
    });
  }

  if (Number(slotValue) === Number(ganadorEquipoId)) {
    return buildResult({
      status: 'skipped',
      reason: 'ya_avanzado',
      partidoId: id,
      destinoPartidoId: destino.id,
      slot: destinoSlot.slot,
      ganadorEquipoId,
    });
  }

  return buildResult({
    status: 'conflict',
    reason: 'slot_ocupado',
    partidoId: id,
    destinoPartidoId: destino.id,
    slot: destinoSlot.slot,
    ganadorEquipoId,
  });
}
