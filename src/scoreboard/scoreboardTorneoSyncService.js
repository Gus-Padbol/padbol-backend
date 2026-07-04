import {
  buildPartidoTorneoResultadoPayload,
  finalizarPartidoTorneo,
  partidoHasFinalResult,
  resolveGanadorEquipoId,
  resolveTorneoWinnerSide,
  resultadosTorneoCoinciden,
} from '../../lib/torneos/finalizarPartidoTorneoService.js';

const SCOREBOARD_TERMINADO_ESTADOS = new Set(['terminado', 'finalizado']);

export {
  partidoHasFinalResult,
  resolveGanadorEquipoId,
  resolveTorneoWinnerSide,
  resultadosTorneoCoinciden,
} from '../../lib/torneos/finalizarPartidoTorneoService.js';

export const SCOREBOARD_TORNEO_SYNC_SELECT = [
  'id',
  'partido_torneo_id',
  'estado',
  'sets_a',
  'sets_b',
  'sync_torneo_status',
  'synced_to_torneo_at',
].join(', ');

export const PARTIDO_TORNEO_SYNC_SELECT = [
  'id',
  'estado',
  'resultado',
  'equipo_a_id',
  'equipo_b_id',
  'ganador_equipo_id',
].join(', ');

export function isScoreboardTerminatedForSync(estado) {
  return SCOREBOARD_TERMINADO_ESTADOS.has(String(estado ?? '').trim().toLowerCase());
}

export function buildPartidoTorneoResultadoFromScoreboard(scoreboard) {
  return {
    goles_a: Number(scoreboard?.sets_a) || 0,
    goles_b: Number(scoreboard?.sets_b) || 0,
  };
}

export function isAlreadySyncedMatch(scoreboard, partido, resultadoNuevo, ganadorEquipoId) {
  if (String(scoreboard?.sync_torneo_status ?? '').toLowerCase() !== 'synced') {
    return false;
  }
  if (!partidoHasFinalResult(partido)) return false;
  if (!resultadosTorneoCoinciden(partido.resultado, resultadoNuevo)) return false;
  if (partido.ganador_equipo_id != null && ganadorEquipoId != null) {
    return Number(partido.ganador_equipo_id) === Number(ganadorEquipoId);
  }
  return true;
}

async function markScoreboardSyncStatus(supabaseAdmin, scoreboardId, status) {
  const now = new Date().toISOString();
  const patch = {
    sync_torneo_status: status,
    updated_at: now,
  };
  if (status === 'synced') {
    patch.synced_to_torneo_at = now;
  }

  const { error } = await supabaseAdmin
    .from('scoreboard_partidos')
    .update(patch)
    .eq('id', scoreboardId);

  if (error) throw error;
}

function mapFinalizeFailureReason(reason) {
  if (reason === 'ganador_equipo_id_invalido') return 'ganador_equipo_id_invalido';
  if (reason === 'partido_no_encontrado') return 'partido_no_encontrado';
  if (reason === 'resultado_invalido') return 'resultado_invalido';
  return reason;
}

/**
 * Sincroniza resultado final del scoreboard hacia partidos (torneo).
 * Solo aplica cuando partido_torneo_id está presente.
 */
export async function syncScoreboardToTorneoPartido(supabaseAdmin, scoreboardId) {
  const sid = String(scoreboardId ?? '').trim();
  if (!sid) {
    return { ok: false, status: 'failed', reason: 'scoreboard_id_invalido' };
  }

  const { data: scoreboard, error: sbErr } = await supabaseAdmin
    .from('scoreboard_partidos')
    .select(SCOREBOARD_TORNEO_SYNC_SELECT)
    .eq('id', sid)
    .maybeSingle();

  if (sbErr) throw sbErr;
  if (!scoreboard) {
    return {
      ok: false,
      status: 'failed',
      reason: 'scoreboard_no_encontrado',
      scoreboard_id: sid,
    };
  }

  const partidoTorneoId = scoreboard.partido_torneo_id;
  if (partidoTorneoId == null || partidoTorneoId === '') {
    return {
      ok: true,
      status: 'skipped',
      reason: 'sin_partido_torneo_id',
      scoreboard_id: sid,
    };
  }

  if (!isScoreboardTerminatedForSync(scoreboard.estado)) {
    return {
      ok: true,
      status: 'skipped',
      reason: 'scoreboard_no_terminado',
      scoreboard_id: sid,
      partido_torneo_id: Number(partidoTorneoId),
    };
  }

  const winnerSide = resolveTorneoWinnerSide(scoreboard.sets_a, scoreboard.sets_b);
  const resultado = buildPartidoTorneoResultadoFromScoreboard(scoreboard);

  if (!winnerSide) {
    await markScoreboardSyncStatus(supabaseAdmin, sid, 'failed');
    return {
      ok: false,
      status: 'failed',
      reason: 'resultado_invalido',
      scoreboard_id: sid,
      partido_torneo_id: Number(partidoTorneoId),
    };
  }

  const pid = Number(partidoTorneoId);
  const { data: partido, error: pErr } = await supabaseAdmin
    .from('partidos')
    .select(PARTIDO_TORNEO_SYNC_SELECT)
    .eq('id', pid)
    .maybeSingle();

  if (pErr) throw pErr;
  if (!partido) {
    await markScoreboardSyncStatus(supabaseAdmin, sid, 'failed');
    return {
      ok: false,
      status: 'failed',
      reason: 'partido_no_encontrado',
      scoreboard_id: sid,
      partido_torneo_id: pid,
    };
  }

  const ganadorEquipoId = resolveGanadorEquipoId(winnerSide, partido);
  if (!ganadorEquipoId) {
    await markScoreboardSyncStatus(supabaseAdmin, sid, 'failed');
    return {
      ok: false,
      status: 'failed',
      reason: 'ganador_equipo_id_invalido',
      scoreboard_id: sid,
      partido_torneo_id: pid,
    };
  }

  if (partidoHasFinalResult(partido)) {
    if (isAlreadySyncedMatch(scoreboard, partido, resultado, ganadorEquipoId)) {
      await markScoreboardSyncStatus(supabaseAdmin, sid, 'synced');
      return {
        ok: true,
        status: 'synced',
        reason: 'ya_sincronizado',
        scoreboard_id: sid,
        partido_torneo_id: pid,
        resultado,
        ganador_equipo_id: ganadorEquipoId,
      };
    }

    await markScoreboardSyncStatus(supabaseAdmin, sid, 'skipped');
    return {
      ok: true,
      status: 'skipped',
      reason: 'partido_ya_finalizado',
      scoreboard_id: sid,
      partido_torneo_id: pid,
    };
  }

  const finalizeResult = await finalizarPartidoTorneo(supabaseAdmin, {
    partidoId: pid,
    resultado: buildPartidoTorneoResultadoPayload(resultado),
    context: { fuente: 'scoreboard' },
  });

  if (!finalizeResult.ok) {
    await markScoreboardSyncStatus(supabaseAdmin, sid, 'failed');
    return {
      ok: false,
      status: 'failed',
      reason: mapFinalizeFailureReason(finalizeResult.reason),
      scoreboard_id: sid,
      partido_torneo_id: pid,
    };
  }

  await markScoreboardSyncStatus(supabaseAdmin, sid, 'synced');

  return {
    ok: true,
    status: 'synced',
    reason: 'synced',
    scoreboard_id: sid,
    partido_torneo_id: pid,
    resultado: finalizeResult.resultado ?? resultado,
    ganador_equipo_id: finalizeResult.ganador_equipo_id ?? ganadorEquipoId,
  };
}
