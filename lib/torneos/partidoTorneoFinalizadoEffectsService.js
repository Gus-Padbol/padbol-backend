import { advanceWinnerIfNeeded } from './bracketAdvanceService.js';
import { ensureScoreboardForCompletedBracketPartido } from './bracketScoreboardService.js';

function parsePartidoId(partidoId) {
  const id = Number(partidoId);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function buildEffectsSummary({
  ok,
  partidoId,
  torneoId,
  fuente,
  resultado,
  advance,
  scoreboard,
}) {
  const summary = {
    ok: Boolean(ok),
    partido_id: partidoId,
    fuente,
    advance,
    scoreboard,
  };

  if (torneoId != null) summary.torneo_id = Number(torneoId);
  if (resultado != null) summary.resultado = resultado;

  return summary;
}

/**
 * Orquesta side-effects posteriores a la finalización de un partido de torneo.
 * No escribe resultado en `partidos`; eso queda en finalizarPartidoTorneo.
 *
 * @param {import('@supabase/supabase-js').SupabaseClient} supabaseAdmin
 * @param {{
 *   partidoId: number|string,
 *   torneoId?: number|string,
 *   fuente?: 'scoreboard' | 'manual_admin',
 *   resultado?: object,
 *   options?: object,
 * }} params
 * @param {{
 *   advanceWinnerIfNeeded?: typeof advanceWinnerIfNeeded,
 *   ensureScoreboardForCompletedBracketPartido?: typeof ensureScoreboardForCompletedBracketPartido,
 * }} [deps]
 */
export async function onPartidoTorneoFinalizado(supabaseAdmin, params, deps = {}) {
  const partidoId = parsePartidoId(params?.partidoId);
  const fuente = params?.fuente === 'manual_admin' ? 'manual_admin' : 'scoreboard';

  if (partidoId == null) {
    return buildEffectsSummary({
      ok: false,
      partidoId: null,
      torneoId: params?.torneoId,
      fuente,
      resultado: params?.resultado,
      advance: {
        status: 'failed',
        reason: 'partido_id_invalido',
      },
      scoreboard: null,
    });
  }

  const advanceFn = deps.advanceWinnerIfNeeded ?? advanceWinnerIfNeeded;
  const ensureScoreboardFn = deps.ensureScoreboardForCompletedBracketPartido
    ?? ensureScoreboardForCompletedBracketPartido;

  let advanceResult;
  let scoreboardResult = null;
  let ok = true;

  try {
    advanceResult = await advanceFn(supabaseAdmin, { partidoId });

    if (advanceResult?.status === 'advanced' && advanceResult.destino_partido_id != null) {
      try {
        scoreboardResult = await ensureScoreboardFn(supabaseAdmin, {
          partidoId: advanceResult.destino_partido_id,
        });
      } catch (scoreboardErr) {
        ok = false;
        scoreboardResult = {
          status: 'failed',
          reason: 'exception',
          partido_id: Number(advanceResult.destino_partido_id),
          error: scoreboardErr.message,
        };
      }
    }
  } catch (advanceErr) {
    ok = false;
    advanceResult = {
      status: 'failed',
      reason: 'exception',
      partido_id: partidoId,
      error: advanceErr.message,
    };
  }

  return buildEffectsSummary({
    ok,
    partidoId,
    torneoId: params?.torneoId,
    fuente,
    resultado: params?.resultado,
    advance: advanceResult ?? null,
    scoreboard: scoreboardResult,
  });
}
