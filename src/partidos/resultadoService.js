import { sumarXP } from '../xp/xpService.js';
import { verificarLogrosArena } from '../arena/arenaLogrosService.js';
import { actualizarRango } from '../rangos/rangosService.js';
import { sendPushToUser } from '../../utils/push.js';
import { createNotificacion } from '../../utils/notificaciones.js';
import {
  isEquiposAsignacionValida,
  normalizeEquipoUserIds,
  sortJugadoresRowsForEquipos,
} from './equiposService.js';
import { processCasualMatchPadcoinsAfterResultConfirmed } from '../matches/matchRewardsService.js';

function parseResultadoBody(body) {
  const resultado = body?.resultado ?? body;
  const equipo1 = Number(resultado?.equipo1);
  const equipo2 = Number(resultado?.equipo2);

  if (!Number.isFinite(equipo1) || !Number.isFinite(equipo2)) {
    return { valid: false, error: 'resultado.equipo1 y resultado.equipo2 son requeridos' };
  }

  if (equipo1 < 0 || equipo2 < 0) {
    return { valid: false, error: 'Los puntajes no pueden ser negativos' };
  }

  if (equipo1 === equipo2) {
    return { valid: false, error: 'Debe haber un ganador' };
  }

  const ganador = equipo1 > equipo2 ? 'equipo1' : 'equipo2';

  return {
    valid: true,
    resultado: { equipo1, equipo2 },
    ganador,
  };
}

function resultadosCoinciden(a, b) {
  return a?.equipo1 === b?.equipo1 && a?.equipo2 === b?.equipo2;
}

function isMatchPast(fecha, hora) {
  if (!fecha) return false;
  const time = hora ? String(hora).slice(0, 5) : '23:59';
  const matchDate = new Date(`${fecha}T${time}:00`);
  return !Number.isNaN(matchDate.getTime()) && matchDate.getTime() <= Date.now();
}

export function partidoTieneResultadoCargado(partido) {
  if (partido?.resultado_json?.cargas && Object.keys(partido.resultado_json.cargas).length > 0) {
    return true;
  }
  return Boolean(partido?.resultado) || partido?.estado === 'finalizado';
}

export async function resolveCapitanesPartido(supabaseAdmin, partidoId, capitanUserId) {
  const { data: partido, error: partidoErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('equipos_asignacion, capitan_email')
    .eq('id', partidoId)
    .maybeSingle();

  if (partidoErr) throw partidoErr;

  const { data: jugadores, error } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('user_id, email, joined_at')
    .eq('partido_id', partidoId)
    .order('joined_at', { ascending: true });

  if (error) throw error;

  if (isEquiposAsignacionValida(partido?.equipos_asignacion)) {
    const equipo2Ids = normalizeEquipoUserIds(partido.equipos_asignacion.equipo2);
    const capitanEquipo2 = equipo2Ids[0] ?? null;

    return {
      capitan1: capitanUserId ?? null,
      capitan2: capitanEquipo2,
      capitanes: [capitanUserId, capitanEquipo2].filter(Boolean),
    };
  }

  const sorted = sortJugadoresRowsForEquipos(
    jugadores ?? [],
    capitanUserId,
    partido?.capitan_email ?? null,
  );
  const midpoint = Math.ceil(sorted.length / 2);
  const capitanEquipo2 = sorted[midpoint]?.user_id ?? null;

  return {
    capitan1: capitanUserId ?? null,
    capitan2: capitanEquipo2,
    capitanes: [capitanUserId, capitanEquipo2].filter(Boolean),
  };
}

export function userEsCapitanPartido(userId, capitanes) {
  return capitanes.capitanes.includes(userId);
}

async function otorgarXpPartidoConfirmado(supabaseAdmin, partido, capitanes, ganador, cargas) {
  const xpResults = [];

  for (const capitanId of capitanes.capitanes) {
    try {
      const xpConfirmado = await sumarXP(
        supabaseAdmin,
        capitanId,
        'PARTIDO_CASUAL_CONFIRMADO',
        `Partido casual confirmado #${partido.id}`,
        String(partido.id),
      );
      xpResults.push({ userId: capitanId, tipo: 'PARTIDO_CASUAL_CONFIRMADO', ...xpConfirmado });

      const capitanGanador =
        (ganador === 'equipo1' && capitanId === capitanes.capitan1)
        || (ganador === 'equipo2' && capitanId === capitanes.capitan2);

      if (capitanGanador) {
        const xpVictoria = await sumarXP(
          supabaseAdmin,
          capitanId,
          'VICTORIA_CASUAL',
          `Victoria en partido casual #${partido.id}`,
          String(partido.id),
        );
        xpResults.push({ userId: capitanId, tipo: 'VICTORIA_CASUAL', ...xpVictoria });
      }

      if (cargas[capitanId]) {
        const xpCarga = await sumarXP(
          supabaseAdmin,
          capitanId,
          'CARGAR_RESULTADO',
          `Resultado cargado partido #${partido.id}`,
          String(partido.id),
        );
        xpResults.push({ userId: capitanId, tipo: 'CARGAR_RESULTADO', ...xpCarga });
      }

      await verificarLogrosArena(supabaseAdmin, capitanId, {
        evento: 'partido_resultado_confirmado',
        partido_id: partido.id,
        ganador: capitanGanador,
      });

      await actualizarRango(supabaseAdmin, capitanId).catch((err) =>
        console.warn('⚠️ actualizarRango partido:', err.message),
      );
    } catch (err) {
      console.warn(`⚠️ XP/logros partido casual ${partido.id} capitan ${capitanId}:`, err.message);
    }
  }

  return xpResults;
}

async function notificarDisputa(supabaseAdmin, partido, capitanes, otroCapitanId) {
  const titulo = 'Resultado en disputa';
  const mensaje = `Los resultados cargados no coinciden en el partido #${partido.id}. Revisá con el otro capitán.`;

  for (const capitanId of capitanes.capitanes) {
    if (capitanId === otroCapitanId) continue;

    await createNotificacion(supabaseAdmin, {
      user_id: capitanId,
      tipo: 'partido_disputa',
      titulo,
      mensaje,
      data: { partido_id: partido.id, type: 'partido_disputa' },
    });

    await sendPushToUser(supabaseAdmin, capitanId, {
      title: titulo,
      body: mensaje,
      data: { type: 'partido_disputa', partido_id: String(partido.id) },
    }).catch((err) => console.warn('⚠️ Push disputa:', err.message));
  }
}

/**
 * POST /api/partidos/:id/resultado — confirmación dual de capitanes.
 */
export async function procesarResultadoPartidoCasual({
  supabaseAdmin,
  partidoId,
  user,
  body,
  deps = {},
}) {
  const processPadcoinsFn = deps.processCasualMatchPadcoinsAfterResultConfirmed
    ?? processCasualMatchPadcoinsAfterResultConfirmed;
  const validation = parseResultadoBody(body);
  if (!validation.valid) {
    return { status: 400, body: { error: validation.error } };
  }

  const { data: partido, error: fetchErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, capitan_user_id, estado, fecha, hora, sede_nombre, resultado_json, resultado, ganador')
    .eq('id', partidoId)
    .maybeSingle();

  if (fetchErr) throw fetchErr;
  if (!partido) {
    return { status: 404, body: { error: 'Partido no encontrado' } };
  }

  if (partido.estado !== 'completo' && partido.estado !== 'en_disputa') {
    return { status: 400, body: { error: 'Solo se puede cargar resultado en partidos completos' } };
  }

  if (!isMatchPast(partido.fecha, partido.hora)) {
    return { status: 400, body: { error: 'El partido aún no finalizó' } };
  }

  const capitanes = await resolveCapitanesPartido(
    supabaseAdmin,
    partidoId,
    partido.capitan_user_id,
  );

  if (!userEsCapitanPartido(user.id, capitanes)) {
    return { status: 403, body: { error: 'Solo los capitanes pueden cargar el resultado' } };
  }

  const prevJson = partido.resultado_json ?? { cargas: {}, estado_confirmacion: 'pendiente' };
  const cargas = { ...(prevJson.cargas ?? {}) };

  cargas[user.id] = {
    ...validation.resultado,
    cargado_at: new Date().toISOString(),
  };

  const capitanIds = capitanes.capitanes;
  const cargasCapitanes = capitanIds.filter((id) => cargas[id]);

  if (cargasCapitanes.length < 2) {
    const resultadoJson = {
      cargas,
      estado_confirmacion: 'pendiente',
    };

    const { error: updateErr } = await supabaseAdmin
      .from('partidos_abiertos')
      .update({ resultado_json: resultadoJson })
      .eq('id', partidoId);

    if (updateErr) throw updateErr;

    await verificarLogrosArena(supabaseAdmin, user.id, {
      evento: 'partido_resultado_cargado',
      partido_id: partidoId,
    });

    await actualizarRango(supabaseAdmin, user.id).catch((err) =>
      console.warn('⚠️ actualizarRango partido carga:', err.message),
    );

    return {
      status: 200,
      body: {
        success: true,
        estado_confirmacion: 'pendiente',
        mensaje: 'Resultado guardado. Esperando confirmación del otro capitán.',
      },
    };
  }

  const [carga1, carga2] = cargasCapitanes.map((id) => cargas[id]);

  if (!resultadosCoinciden(carga1, carga2)) {
    const resultadoJson = {
      cargas,
      estado_confirmacion: 'en_disputa',
    };

    const { error: updateErr } = await supabaseAdmin
      .from('partidos_abiertos')
      .update({
        resultado_json: resultadoJson,
        estado: 'en_disputa',
      })
      .eq('id', partidoId);

    if (updateErr) throw updateErr;

    const otroCapitan = capitanIds.find((id) => id !== user.id);
    await notificarDisputa(supabaseAdmin, partido, capitanes, otroCapitan);

    return {
      status: 200,
      body: {
        success: true,
        estado_confirmacion: 'en_disputa',
        mensaje: 'Los resultados no coinciden. El partido quedó en disputa.',
      },
    };
  }

  const resultadoFinal = validation.resultado;
  const ganador = validation.ganador;

  const { error: updateErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .update({
      resultado_json: {
        cargas,
        estado_confirmacion: 'confirmado',
        confirmado_at: new Date().toISOString(),
      },
      resultado: resultadoFinal,
      ganador,
      estado: 'finalizado',
    })
    .eq('id', partidoId);

  if (updateErr) throw updateErr;

  const xpResults = await otorgarXpPartidoConfirmado(
    supabaseAdmin,
    partido,
    capitanes,
    ganador,
    cargas,
  ).catch((err) => {
    console.warn(`⚠️ XP partido casual ${partidoId}:`, err.message);
    return [];
  });

  const padcoinsResult = await processPadcoinsFn(
    supabaseAdmin,
    partidoId,
  ).catch((err) => {
    console.warn(`⚠️ PadCoins partido casual ${partidoId}:`, err.message);
    return null;
  });

  const padcoinsBody = padcoinsResult?.attendance_pending
    ? {
      acreditado: false,
      attendance_pending: true,
      reason: padcoinsResult.reason ?? 'attendance_window_open',
    }
    : padcoinsResult?.acreditado
      ? {
        acreditado: true,
        total: padcoinsResult.total_padcoins ?? 0,
        credits: (padcoinsResult.credits ?? []).filter((c) => c.acreditado).length,
      }
      : {
        acreditado: false,
        reason: padcoinsResult?.reason ?? null,
      };

  return {
    status: 200,
    body: {
      success: true,
      estado_confirmacion: 'confirmado',
      ganador,
      resultado: resultadoFinal,
      xp: xpResults,
      padcoins: padcoinsBody,
    },
  };
}

export async function notifyCapitanesCargarResultado(supabaseAdmin, partidoId) {
  const { data: partido, error } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, capitan_user_id, resultado_json, resultado, estado')
    .eq('id', partidoId)
    .maybeSingle();

  if (error) throw error;
  if (!partido || partidoTieneResultadoCargado(partido)) return;

  const capitanes = await resolveCapitanesPartido(
    supabaseAdmin,
    partidoId,
    partido.capitan_user_id,
  );

  const title = '¿Cómo salió el partido?';
  const body = 'Cargá el resultado y sumá XP a tu perfil ARENA';

  for (const capitanId of capitanes.capitanes) {
    await sendPushToUser(supabaseAdmin, capitanId, {
      title,
      body,
      data: { type: 'cargar_resultado', partido_id: String(partidoId) },
    }).catch((err) => console.warn('⚠️ Push cargar resultado:', err.message));
  }
}
