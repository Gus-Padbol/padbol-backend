import { sumarXP } from '../xp/xpService.js';

/**
 * Verifica logros ARENA tras un evento (partido, torneo, etc.).
 * Usado por POST /api/arena/logros y por handlers internos.
 */
export async function verificarLogrosArena(supabaseAdmin, userId, context = {}) {
  const desbloqueados = [];

  try {
    const { data: logros, error: logrosErr } = await supabaseAdmin
      .from('logros')
      .select('id, codigo, nombre, criterio_tipo, criterio_valor')
      .eq('activo', true);

    if (logrosErr) {
      if (isMissingTable(logrosErr)) return desbloqueados;
      throw logrosErr;
    }

    const { data: yaDesbloqueados, error: yaErr } = await supabaseAdmin
      .from('logros_jugador')
      .select('logro_id')
      .eq('user_id', userId);

    if (yaErr) {
      if (isMissingTable(yaErr)) return desbloqueados;
      throw yaErr;
    }

    const desbloqueadosSet = new Set((yaDesbloqueados ?? []).map((r) => r.logro_id));

    for (const logro of logros ?? []) {
      if (desbloqueadosSet.has(logro.id)) continue;
      if (!cumpleCriterio(logro, context)) continue;

      const { error: insertErr } = await supabaseAdmin
        .from('logros_jugador')
        .insert({
          user_id: userId,
          logro_id: logro.id,
          contexto: context,
        });

      if (insertErr) {
        console.warn('⚠️ verificarLogrosArena insert:', insertErr.message);
        continue;
      }

      await sumarXP(
        supabaseAdmin,
        userId,
        'LOGRO_DESBLOQUEADO',
        `Logro desbloqueado: ${logro.nombre ?? logro.codigo}`,
        String(logro.id),
      ).catch((err) => console.warn('⚠️ XP logro:', err.message));

      desbloqueados.push({
        id: logro.id,
        codigo: logro.codigo,
        nombre: logro.nombre,
      });
    }
  } catch (err) {
    console.warn('⚠️ verificarLogrosArena:', err.message);
  }

  return desbloqueados;
}

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function cumpleCriterio(logro, context) {
  const tipo = String(logro?.criterio_tipo ?? '').trim();
  const valor = Number(logro?.criterio_valor);

  if (tipo === 'partido_casual_ganado' && context?.evento === 'partido_resultado_confirmado') {
    return Boolean(context.ganador);
  }

  if (tipo === 'partidos_casual_jugados' && context?.evento === 'partido_resultado_confirmado') {
    const total = Number(context.partidos_casual ?? 0);
    return Number.isFinite(valor) && total >= valor;
  }

  if (tipo === 'cargar_resultado' && context?.evento === 'partido_resultado_cargado') {
    return true;
  }

  return false;
}
