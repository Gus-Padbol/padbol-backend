import {
  finalizarPartidoTorneo,
  resolveTorneoWinnerSide,
} from './finalizarPartidoTorneoService.js';
import { onPartidoTorneoFinalizado } from './partidoTorneoFinalizadoEffectsService.js';

function parseRouteId(value) {
  const id = Number(value);
  if (!Number.isFinite(id) || id <= 0) return null;
  return id;
}

function buildPublicResultado(resultado) {
  const payload = {
    goles_a: resultado.goles_a,
    goles_b: resultado.goles_b,
  };
  if (resultado.historial_sets != null) {
    payload.historial_sets = resultado.historial_sets;
  }
  return payload;
}

function httpError(statusCode, error, code, extra = {}) {
  return {
    statusCode,
    body: {
      ok: false,
      error,
      code,
      ...extra,
    },
  };
}

/**
 * Valida body de POST manual admin para resultado de partido de torneo.
 */
export function parseResultadoManualPartidoTorneoBody(body) {
  if (body == null || typeof body !== 'object' || Array.isArray(body)) {
    return {
      valid: false,
      error: 'Body inválido',
      code: 'RESULTADO_BODY_INVALIDO',
    };
  }

  if (body.goles_a == null || body.goles_b == null) {
    return {
      valid: false,
      error: 'goles_a y goles_b son requeridos',
      code: 'RESULTADO_INCOMPLETO',
    };
  }

  const goles_a = Number(body.goles_a);
  const goles_b = Number(body.goles_b);

  if (!Number.isFinite(goles_a) || !Number.isFinite(goles_b) || goles_a < 0 || goles_b < 0) {
    return {
      valid: false,
      error: 'goles_a y goles_b deben ser números válidos mayores o iguales a 0',
      code: 'RESULTADO_INVALIDO',
    };
  }

  if (!resolveTorneoWinnerSide(goles_a, goles_b)) {
    return {
      valid: false,
      error: 'Resultado inválido: en best-of-3 uno de los equipos debe ganar 2 sets con marcador distinto',
      code: 'RESULTADO_INVALIDO',
    };
  }

  const resultado = {
    goles_a,
    goles_b,
    fuente_resultado: 'manual_admin',
  };

  if (body.historial_sets != null) {
    if (!Array.isArray(body.historial_sets)) {
      return {
        valid: false,
        error: 'historial_sets debe ser un array',
        code: 'RESULTADO_INVALIDO',
      };
    }
    resultado.historial_sets = body.historial_sets;
  }

  return { valid: true, resultado };
}

async function verifyTorneoExists(supabaseAdmin, torneoId) {
  const { data, error } = await supabaseAdmin
    .from('torneos')
    .select('id')
    .eq('id', torneoId)
    .maybeSingle();

  if (error) throw error;
  return Boolean(data?.id);
}

function mapFinalizeToHttp(finalizeResult, torneoId, partidoId) {
  const reason = finalizeResult.reason;

  if (finalizeResult.status === 'failed') {
    if (reason === 'partido_no_encontrado' || reason === 'torneo_id_no_coincide') {
      return httpError(404, 'Partido o torneo no encontrado', reason, {
        partido_id: partidoId,
        torneo_id: torneoId,
      });
    }

    if (reason === 'resultado_invalido' || reason === 'equipos_invalidos'
      || reason === 'ganador_equipo_id_invalido' || reason === 'ganador_incoherente'
      || reason === 'partido_id_invalido') {
      return httpError(400, 'Resultado inválido', reason, {
        partido_id: partidoId,
        torneo_id: torneoId,
      });
    }

    return httpError(400, 'No se pudo finalizar el partido', reason ?? 'finalizar_fallido', {
      partido_id: partidoId,
      torneo_id: torneoId,
    });
  }

  if (finalizeResult.status === 'rejected' && reason === 'partido_ya_finalizado') {
    return httpError(409, 'El partido ya está finalizado con un resultado distinto', reason, {
      partido_id: partidoId,
      torneo_id: torneoId,
    });
  }

  return null;
}

/**
 * Carga manual admin del resultado de un partido de torneo.
 * Encadena finalizarPartidoTorneo + onPartidoTorneoFinalizado.
 */
export async function cargarResultadoManualPartidoTorneo(
  supabaseAdmin,
  { torneoId, partidoId, body, actorId },
  deps = {},
) {
  const tid = parseRouteId(torneoId);
  const pid = parseRouteId(partidoId);

  if (tid == null || pid == null) {
    return httpError(400, 'torneoId y partidoId deben ser numéricos válidos', 'PARAMETROS_INVALIDOS');
  }

  const parsedBody = parseResultadoManualPartidoTorneoBody(body);
  if (!parsedBody.valid) {
    return httpError(400, parsedBody.error, parsedBody.code);
  }

  const torneoExists = await (deps.verifyTorneoExists ?? verifyTorneoExists)(supabaseAdmin, tid);
  if (!torneoExists) {
    return httpError(404, 'Torneo no encontrado', 'torneo_no_encontrado', { torneo_id: tid });
  }

  const finalizeFn = deps.finalizarPartidoTorneo ?? finalizarPartidoTorneo;
  const effectsFn = deps.onPartidoTorneoFinalizado ?? onPartidoTorneoFinalizado;

  const finalizeResult = await finalizeFn(supabaseAdmin, {
    partidoId: pid,
    torneoId: tid,
    resultado: parsedBody.resultado,
    context: {
      fuente: 'manual_admin',
      actor_id: actorId ?? null,
      allowOverwrite: false,
    },
  });

  const httpMapped = mapFinalizeToHttp(finalizeResult, tid, pid);
  if (httpMapped) return httpMapped;

  if (!finalizeResult.ok
    || (finalizeResult.status !== 'finalized' && finalizeResult.status !== 'idempotent')) {
    return httpError(500, 'Error inesperado al finalizar el partido', 'FINALIZAR_INESPERADO', {
      partido_id: pid,
      torneo_id: tid,
      reason: finalizeResult.reason ?? null,
    });
  }

  const effectsResult = await effectsFn(
    supabaseAdmin,
    {
      partidoId: pid,
      torneoId: tid,
      fuente: 'manual_admin',
      resultado: buildPublicResultado(parsedBody.resultado),
    },
    deps.effectsDeps ?? {},
  );

  return {
    statusCode: 200,
    body: {
      ok: true,
      partido_id: pid,
      torneo_id: tid,
      status: finalizeResult.status === 'idempotent' ? 'idempotent' : 'finalized',
      resultado: buildPublicResultado(finalizeResult.resultado ?? parsedBody.resultado),
      ganador_equipo_id: finalizeResult.ganador_equipo_id,
      effects: {
        advance: effectsResult.advance ?? null,
        scoreboard: effectsResult.scoreboard ?? null,
      },
    },
  };
}
