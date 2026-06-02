import { RANGOS, XP_TIPO_SUBIDA_RANGO } from './rangosConfig.js';
import { sumarXP } from '../xp/xpService.js';

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function mapRangoPublico(rango) {
  return {
    slug: rango.slug,
    nombre: rango.nombre,
    condicion: rango.condicion,
    min_logros: rango.min_logros,
  };
}

function cumpleCondicionRango(rango, { logrosCount, slugsSet }) {
  if (logrosCount < rango.min_logros) return false;

  switch (rango.condicion) {
    case 'registro':
    case 'logros':
      return true;
    case 'logros_campeon_local':
      return slugsSet.has('campeon_local');
    case 'logros_campeon_nacional':
      return slugsSet.has('campeon_nacional');
    case 'top10_fipa':
      return slugsSet.has('top10_fipa');
    case 'leyenda_fipa':
      return slugsSet.has('leyenda_fipa');
    default:
      return false;
  }
}

function indiceRango(slug) {
  const idx = RANGOS.findIndex((r) => r.slug === slug);
  return idx >= 0 ? idx : 0;
}

async function fetchLogrosDesbloqueadosData(supabaseAdmin, userId) {
  const slugs = new Set();

  const { data: bySlug, error: bySlugErr } = await supabaseAdmin
    .from('logros_jugador')
    .select('slug')
    .eq('user_id', userId);

  if (!bySlugErr && bySlug?.length) {
    bySlug.forEach((row) => {
      if (row?.slug) slugs.add(String(row.slug).trim().toLowerCase());
    });
    return { slugs, count: slugs.size };
  }

  const { data: withLogro, error: joinErr } = await supabaseAdmin
    .from('logros_jugador')
    .select('logro_id, logros ( codigo )')
    .eq('user_id', userId);

  if (joinErr) {
    if (isMissingTable(joinErr)) return { slugs: new Set(), count: 0 };
    throw joinErr;
  }

  (withLogro ?? []).forEach((row) => {
    const codigo = row?.logros?.codigo ?? null;
    if (codigo) slugs.add(String(codigo).trim().toLowerCase());
  });

  return { slugs, count: slugs.size };
}

export async function calcularRango(supabaseAdmin, userId) {
  const { slugs, count } = await fetchLogrosDesbloqueadosData(supabaseAdmin, userId);

  let rangoActual = RANGOS[0];
  for (const rango of RANGOS) {
    if (cumpleCondicionRango(rango, { logrosCount: count, slugsSet: slugs })) {
      rangoActual = rango;
    }
  }

  const idx = indiceRango(rangoActual.slug);
  const rangoSiguiente = idx < RANGOS.length - 1 ? RANGOS[idx + 1] : null;
  const logrosParaSiguiente = rangoSiguiente
    ? Math.max(0, rangoSiguiente.min_logros - count)
    : 0;

  return {
    rango_actual: mapRangoPublico(rangoActual),
    rango_siguiente: rangoSiguiente ? mapRangoPublico(rangoSiguiente) : null,
    logros_desbloqueados: count,
    logros_para_siguiente: logrosParaSiguiente,
  };
}

export async function fetchHistorialRangos(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('rangos_historial')
    .select('rango_anterior, rango_nuevo, created_at')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    if (isMissingTable(error)) return [];
    throw error;
  }

  return data ?? [];
}

export async function actualizarRango(supabaseAdmin, userId) {
  const calculado = await calcularRango(supabaseAdmin, userId);
  const nuevoSlug = calculado.rango_actual.slug;

  const { data: perfil, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('rango')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) throw error;

  const rangoAnterior = String(perfil?.rango ?? 'rookie').trim().toLowerCase() || 'rookie';

  if (rangoAnterior === nuevoSlug) {
    return {
      subio_rango: false,
      ...calculado,
    };
  }

  const idxAnterior = indiceRango(rangoAnterior);
  const idxNuevo = indiceRango(nuevoSlug);
  const subioRango = idxNuevo > idxAnterior;

  const { error: updateErr } = await supabaseAdmin
    .from('jugadores_perfil')
    .update({ rango: nuevoSlug })
    .eq('user_id', userId);

  if (updateErr) throw updateErr;

  const { error: histErr } = await supabaseAdmin
    .from('rangos_historial')
    .insert({
      user_id: userId,
      rango_anterior: rangoAnterior,
      rango_nuevo: nuevoSlug,
    });

  if (histErr && !isMissingTable(histErr)) {
    console.warn('⚠️ rangos_historial insert:', histErr.message);
  }

  let xpGanado = 0;
  if (subioRango) {
    const xpTipo = XP_TIPO_SUBIDA_RANGO[nuevoSlug];
    if (xpTipo) {
      const xpResult = await sumarXP(
        supabaseAdmin,
        userId,
        xpTipo,
        `Subida de rango a ${calculado.rango_actual.nombre}`,
        nuevoSlug,
      ).catch((err) => {
        console.warn('⚠️ XP subida rango:', err.message);
        return { xp_sumado: 0 };
      });
      xpGanado = xpResult?.xp_sumado ?? 0;
    }
  }

  return {
    subio_rango: subioRango,
    rango_anterior: rangoAnterior,
    rango_nuevo: nuevoSlug,
    xp_ganado: xpGanado,
    ...calculado,
  };
}

export async function getMiRangoPayload(supabaseAdmin, userId) {
  const [calculado, historial] = await Promise.all([
    calcularRango(supabaseAdmin, userId),
    fetchHistorialRangos(supabaseAdmin, userId),
  ]);

  return {
    ...calculado,
    historial,
  };
}

export function collectUserIdsFromEquipos(equipos) {
  const ids = new Set();
  const uuidRe = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

  for (const eq of equipos ?? []) {
    const jugadores = Array.isArray(eq.jugadores) ? eq.jugadores : [];
    for (const jugador of jugadores) {
      const uid = jugador?.user_id ?? jugador?.id ?? null;
      if (uid && uuidRe.test(String(uid))) {
        ids.add(String(uid));
      }
    }
  }

  return [...ids];
}
