export const PARTIDO_TORNEO_FINALIZAR_SELECT = [
  'id',
  'torneo_id',
  'estado',
  'resultado',
  'equipo_a_id',
  'equipo_b_id',
  'ganador_equipo_id',
].join(', ');

export function unwrapResultadoJson(val, depth = 0) {
  if (val == null || depth > 4) return null;
  if (typeof val === 'string') {
    const t = val.trim();
    if (!t) return null;
    try {
      return unwrapResultadoJson(JSON.parse(t), depth + 1);
    } catch {
      return null;
    }
  }
  if (typeof val === 'object') return val;
  return null;
}

/** Ganador válido en best-of-3: 2 sets y marcador distinto. */
export function resolveTorneoWinnerSide(setsA, setsB) {
  const a = Number(setsA) || 0;
  const b = Number(setsB) || 0;
  if (a === b) return null;
  if (a >= 2 && a > b) return 'A';
  if (b >= 2 && b > a) return 'B';
  return null;
}

export function resolveGanadorEquipoId(winnerSide, partido) {
  if (winnerSide === 'A') return partido?.equipo_a_id ?? null;
  if (winnerSide === 'B') return partido?.equipo_b_id ?? null;
  return null;
}

export function partidoHasFinalResult(partido) {
  const estado = String(partido?.estado ?? '').trim().toLowerCase();
  if (estado !== 'finalizado') return false;
  const res = unwrapResultadoJson(partido?.resultado);
  if (!res) return false;
  return res.goles_a != null && res.goles_b != null;
}

export function resultadosTorneoCoinciden(existingResultado, nuevoResultado) {
  const existing = unwrapResultadoJson(existingResultado);
  const nuevo = unwrapResultadoJson(nuevoResultado) ?? nuevoResultado;
  if (!existing || !nuevo) return false;
  return Number(existing.goles_a) === Number(nuevo.goles_a)
    && Number(existing.goles_b) === Number(nuevo.goles_b);
}

export function buildPartidoTorneoResultadoPayload(resultadoInput = {}) {
  const payload = {
    goles_a: Number(resultadoInput.goles_a) || 0,
    goles_b: Number(resultadoInput.goles_b) || 0,
  };

  if (resultadoInput.historial_sets != null) {
    payload.historial_sets = resultadoInput.historial_sets;
  }
  if (resultadoInput.fuente_resultado != null) {
    payload.fuente_resultado = resultadoInput.fuente_resultado;
  }

  return payload;
}

function parsePartidoId(partidoId) {
  const id = Number(partidoId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function buildFinalizeResponse({
  ok,
  status,
  reason,
  partidoId,
  torneoId,
  resultado,
  ganadorEquipoId,
  updated,
}) {
  const response = {
    ok,
    status,
    reason,
    partido_id: partidoId,
    updated: Boolean(updated),
  };

  if (torneoId != null) response.torneo_id = Number(torneoId);
  if (resultado != null) response.resultado = resultado;
  if (ganadorEquipoId != null) response.ganador_equipo_id = Number(ganadorEquipoId);

  return response;
}

/**
 * Finaliza un partido de torneo escribiendo resultado y ganador en `partidos`.
 * Side-effects (llave, scoreboard, ranking, etc.) quedan fuera de este servicio.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabase
 * @param {{
 *   partidoId: number|string,
 *   torneoId?: number|string,
 *   resultado: {
 *     goles_a: number,
 *     goles_b: number,
 *     ganador_equipo_id?: number,
 *     historial_sets?: unknown,
 *     fuente_resultado?: string,
 *   },
 *   context?: {
 *     fuente?: 'scoreboard' | 'manual_admin',
 *     actor_id?: string,
 *     allowOverwrite?: boolean,
 *   },
 * }} params
 */
export async function finalizarPartidoTorneo(supabase, params) {
  const partidoId = parsePartidoId(params?.partidoId);
  if (partidoId == null) {
    return buildFinalizeResponse({
      ok: false,
      status: 'failed',
      reason: 'partido_id_invalido',
      partidoId: null,
      updated: false,
    });
  }

  const resultadoInput = params?.resultado ?? {};
  const resultado = buildPartidoTorneoResultadoPayload(resultadoInput);
  const winnerSide = resolveTorneoWinnerSide(resultado.goles_a, resultado.goles_b);

  if (!winnerSide) {
    return buildFinalizeResponse({
      ok: false,
      status: 'failed',
      reason: 'resultado_invalido',
      partidoId,
      resultado,
      updated: false,
    });
  }

  const { data: partido, error: fetchErr } = await supabase
    .from('partidos')
    .select(PARTIDO_TORNEO_FINALIZAR_SELECT)
    .eq('id', partidoId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (!partido) {
    return buildFinalizeResponse({
      ok: false,
      status: 'failed',
      reason: 'partido_no_encontrado',
      partidoId,
      updated: false,
    });
  }

  const torneoIdParam = params?.torneoId;
  if (torneoIdParam != null && torneoIdParam !== ''
    && Number(partido.torneo_id) !== Number(torneoIdParam)) {
    return buildFinalizeResponse({
      ok: false,
      status: 'failed',
      reason: 'torneo_id_no_coincide',
      partidoId,
      torneoId: partido.torneo_id,
      updated: false,
    });
  }

  if (partido.equipo_a_id == null || partido.equipo_b_id == null) {
    return buildFinalizeResponse({
      ok: false,
      status: 'failed',
      reason: 'equipos_invalidos',
      partidoId,
      torneoId: partido.torneo_id,
      updated: false,
    });
  }

  const computedGanadorId = resolveGanadorEquipoId(winnerSide, partido);
  if (computedGanadorId == null) {
    return buildFinalizeResponse({
      ok: false,
      status: 'failed',
      reason: 'ganador_equipo_id_invalido',
      partidoId,
      torneoId: partido.torneo_id,
      updated: false,
    });
  }

  const providedGanadorId = resultadoInput.ganador_equipo_id;
  if (providedGanadorId != null && providedGanadorId !== '') {
    if (Number(providedGanadorId) !== Number(computedGanadorId)) {
      return buildFinalizeResponse({
        ok: false,
        status: 'failed',
        reason: 'ganador_incoherente',
        partidoId,
        torneoId: partido.torneo_id,
        resultado,
        updated: false,
      });
    }
  }

  const ganadorEquipoId = Number(providedGanadorId ?? computedGanadorId);
  const allowOverwrite = params?.context?.allowOverwrite === true;
  const alreadyFinal = partidoHasFinalResult(partido);

  if (alreadyFinal) {
    const sameResult = resultadosTorneoCoinciden(partido.resultado, resultado);
    const sameGanador = partido.ganador_equipo_id == null
      || Number(partido.ganador_equipo_id) === ganadorEquipoId;

    if (sameResult && sameGanador) {
      return buildFinalizeResponse({
        ok: true,
        status: 'idempotent',
        reason: 'ya_finalizado_mismo_resultado',
        partidoId,
        torneoId: partido.torneo_id,
        resultado,
        ganadorEquipoId,
        updated: false,
      });
    }

    if (!allowOverwrite) {
      return buildFinalizeResponse({
        ok: false,
        status: 'rejected',
        reason: 'partido_ya_finalizado',
        partidoId,
        torneoId: partido.torneo_id,
        updated: false,
      });
    }
  }

  const { error: updateErr } = await supabase
    .from('partidos')
    .update({
      estado: 'finalizado',
      resultado,
      ganador_equipo_id: ganadorEquipoId,
    })
    .eq('id', partidoId);

  if (updateErr) throw updateErr;

  return buildFinalizeResponse({
    ok: true,
    status: 'finalized',
    reason: alreadyFinal && allowOverwrite ? 'sobrescrito' : 'finalizado',
    partidoId,
    torneoId: partido.torneo_id,
    resultado,
    ganadorEquipoId,
    updated: true,
  });
}
