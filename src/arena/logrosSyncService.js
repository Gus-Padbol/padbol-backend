import { getXPJugador } from '../xp/xpService.js';
import { LIGAS, XP_VALORES } from '../xp/xpConfig.js';

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const XP_LOGRO_DESBLOQUEADO = XP_VALORES.LOGRO_DESBLOQUEADO ?? 150;

export const LOGROS_COMPORTAMIENTO = [
  { slug: 'en_cancha', nombre: 'En cancha' },
  { slug: 'primera_reserva', nombre: 'Primera reserva' },
  { slug: 'puntual', nombre: 'Puntual' },
  { slug: 'jugador_frecuente', nombre: 'Jugador frecuente' },
  { slug: 'buen_companero', nombre: 'Buen compañero' },
  { slug: 'habitue', nombre: 'Habitué' },
];

function isMissingTable(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === '42P01'
    || error?.code === 'PGRST205'
    || message.includes('does not exist')
    || message.includes('could not find the table')
  );
}

function isDuplicateError(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return error?.code === '23505' || message.includes('duplicate') || message.includes('unique');
}

function isValidUserId(userId) {
  return Boolean(userId) && UUID_REGEX.test(String(userId));
}

function calcularLiga(xpTotal) {
  let liga = 'INIT';
  for (const row of LIGAS) {
    if (xpTotal >= row.min) liga = row.nombre;
  }
  return liga;
}

function isMissingRpc(error) {
  const message = String(error?.message ?? '').toLowerCase();
  return (
    error?.code === 'PGRST202'
    || error?.code === '42883'
    || message.includes('sumar_xp')
    || message.includes('could not find the function')
    || message.includes('function') && message.includes('does not exist')
  );
}

async function sumarXPDirectoFallback(supabaseAdmin, userId, {
  tipo,
  xp,
  descripcion,
  referenciaId = null,
}) {
  const { data: perfil, error: readErr } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('xp, user_id')
    .eq('user_id', userId)
    .maybeSingle();

  if (readErr) {
    console.error('[logrosSync] fallback read jugadores_perfil:', readErr.message);
    throw readErr;
  }

  const xpAnterior = Number(perfil?.xp ?? 0);
  const xpTotal = xpAnterior + xp;
  const liga = calcularLiga(xpTotal);

  if (perfil?.user_id) {
    const { error: updateErr } = await supabaseAdmin
      .from('jugadores_perfil')
      .update({ xp: xpTotal, liga })
      .eq('user_id', userId);

    if (updateErr) {
      console.error('[logrosSync] fallback UPDATE jugadores_perfil:', updateErr.message);
      throw updateErr;
    }
  } else {
    const { error: insertErr } = await supabaseAdmin
      .from('jugadores_perfil')
      .insert({ user_id: userId, xp: xpTotal, liga });

    if (insertErr) {
      console.error('[logrosSync] fallback INSERT jugadores_perfil:', insertErr.message);
      throw insertErr;
    }
  }

  const { error: txErr } = await supabaseAdmin
    .from('xp_transacciones')
    .insert({
      user_id: userId,
      tipo,
      xp,
      descripcion,
      referencia_id: referenciaId,
      xp_total_despues: xpTotal,
      liga_despues: liga,
    });

  if (txErr && !isMissingTable(txErr)) {
    console.warn('[logrosSync] fallback xp_transacciones insert:', txErr.message);
  }

  console.log('[logrosSync] sumarXP fallback OK', { userId, xpTotal, liga, xpSumado: xp });
  return { xp_sumado: xp, xp_total: xpTotal, liga, via: 'fallback' };
}

async function sumarXPLogroDesbloqueado(supabaseAdmin, userId, slug) {
  if (!isValidUserId(userId)) {
    console.error('[logrosSync] sumarXP omitido — user_id inválido o null:', userId);
    return null;
  }

  const tipo = 'LOGRO_DESBLOQUEADO';
  const descripcion = `Logro desbloqueado: ${slug}`;
  const xp = XP_LOGRO_DESBLOQUEADO;

  console.log('[logrosSync] sumarXP RPC intento', {
    userId,
    slug,
    tipo,
    xp,
    referencia_id: slug,
  });

  const { data, error } = await supabaseAdmin.rpc('sumar_xp', {
    p_user_id: userId,
    p_tipo: tipo,
    p_xp: xp,
    p_descripcion: descripcion,
    p_referencia_id: slug,
  });

  if (!error) {
    const row = Array.isArray(data) ? data[0] : data;
    console.log('[logrosSync] sumarXP RPC OK', { userId, slug, result: row });
    return {
      xp_sumado: row?.xp_sumado ?? xp,
      xp_total: row?.xp_total ?? null,
      liga: row?.liga ?? null,
      via: 'rpc',
    };
  }

  console.warn('[logrosSync] sumarXP RPC falló', {
    userId,
    slug,
    code: error.code,
    message: error.message,
    details: error.details,
    hint: error.hint,
  });

  if (!isMissingRpc(error) && !isMissingTable(error)) {
    console.warn('[logrosSync] RPC error no reconocido como missing — intentando fallback igualmente');
  }

  try {
    return await sumarXPDirectoFallback(supabaseAdmin, userId, {
      tipo,
      xp,
      descripcion,
      referenciaId: slug,
    });
  } catch (fallbackErr) {
    console.error('[logrosSync] sumarXP fallback falló', {
      userId,
      slug,
      message: fallbackErr.message,
    });
    return null;
  }
}

function buildUserReservaFilters(user) {
  const filters = [`user_id.eq.${user.id}`];
  if (user.email) {
    filters.push(`email.eq."${String(user.email).replace(/"/g, '\\"')}"`);
  }
  return filters.join(',');
}

function parseReservaInicioMs(reserva) {
  const fecha = String(reserva?.fecha ?? '').trim().slice(0, 10);
  const horaRaw = reserva?.hora_inicio ?? reserva?.hora ?? '';
  const horaMatch = String(horaRaw).trim().match(/^(\d{1,2}):(\d{2})/);
  if (!fecha || !horaMatch) return null;
  const dt = new Date(`${fecha}T${horaMatch[1].padStart(2, '0')}:${horaMatch[2]}:00-03:00`);
  return Number.isNaN(dt.getTime()) ? null : dt.getTime();
}

function isCheckinPuntual(reserva) {
  if (!reserva?.checkin_realizado || !reserva?.checkin_at) return false;
  const inicioMs = parseReservaInicioMs(reserva);
  if (inicioMs == null) return false;
  const checkinMs = new Date(reserva.checkin_at).getTime();
  if (Number.isNaN(checkinMs)) return false;
  const diffMin = (checkinMs - inicioMs) / (1000 * 60);
  return diffMin <= 15 && diffMin >= -60;
}

export async function fetchComportamientoLogrosMetrics(supabaseAdmin, user) {
  const filters = buildUserReservaFilters(user);
  const since = new Date();
  since.setDate(since.getDate() - 30);

  const { data: reservas, error } = await supabaseAdmin
    .from('reservas')
    .select('id, estado, sede_id, sede, checkin_realizado, checkin_at, hora, hora_inicio, fecha, updated_at, created_at')
    .or(filters);

  if (error) {
    if (isMissingTable(error)) {
      return {
        checkins_count: 0,
        reservas_confirmadas: 0,
        reservas_completadas: 0,
        checkins_puntuales: 0,
        cancelaciones_30d: 0,
        max_reservas_misma_sede: 0,
      };
    }
    throw error;
  }

  const rows = reservas ?? [];
  const confirmadas = rows.filter((r) => ['confirmada', 'completada', 'pendiente'].includes(String(r.estado)));
  const completadas = rows.filter((r) => ['confirmada', 'completada'].includes(String(r.estado)));
  const checkins = rows.filter((r) => r.checkin_realizado);
  const checkinsPuntuales = checkins.filter(isCheckinPuntual).length;
  const cancelaciones30d = rows.filter((r) => {
    if (String(r.estado) !== 'cancelada') return false;
    const ts = new Date(r.updated_at ?? r.created_at ?? 0).getTime();
    return ts >= since.getTime();
  }).length;

  const sedeCounts = new Map();
  completadas.forEach((r) => {
    const key = r.sede_id != null ? String(r.sede_id) : String(r.sede ?? '').trim().toLowerCase();
    if (!key) return;
    sedeCounts.set(key, (sedeCounts.get(key) ?? 0) + 1);
  });
  const maxReservasMismaSede = sedeCounts.size
    ? Math.max(...sedeCounts.values())
    : 0;

  return {
    checkins_count: checkins.length,
    reservas_confirmadas: confirmadas.length,
    reservas_completadas: completadas.length,
    checkins_puntuales: checkinsPuntuales,
    cancelaciones_30d: cancelaciones30d,
    max_reservas_misma_sede: maxReservasMismaSede,
  };
}

export function evaluaComportamientoLogro(slug, metrics) {
  switch (slug) {
    case 'en_cancha':
      return metrics.checkins_count >= 1;
    case 'primera_reserva':
      return metrics.reservas_confirmadas >= 1;
    case 'puntual':
      return metrics.checkins_puntuales >= 3;
    case 'jugador_frecuente':
      return metrics.reservas_completadas >= 10 || Number(metrics.partidos_jugados ?? 0) >= 10;
    case 'buen_companero':
      return metrics.cancelaciones_30d === 0 && metrics.reservas_completadas >= 5;
    case 'habitue':
      return metrics.max_reservas_misma_sede >= 5;
    default:
      return false;
  }
}

export async function fetchExistingLogroSlugs(supabaseAdmin, userId) {
  const slugs = new Map();

  const { data: bySlug, error: bySlugErr } = await supabaseAdmin
    .from('logros_jugador')
    .select('slug, desbloqueado_en, created_at')
    .eq('user_id', userId);

  if (!bySlugErr && bySlug?.length) {
    bySlug.forEach((row) => {
      if (row?.slug) {
        slugs.set(String(row.slug).trim().toLowerCase(), row.desbloqueado_en ?? row.created_at ?? null);
      }
    });
    return slugs;
  }

  const { data: withLogro, error: joinErr } = await supabaseAdmin
    .from('logros_jugador')
    .select('logro_id, created_at, logros ( codigo )')
    .eq('user_id', userId);

  if (joinErr) {
    if (isMissingTable(joinErr)) return slugs;
    throw joinErr;
  }

  (withLogro ?? []).forEach((row) => {
    const codigo = row?.logros?.codigo ?? null;
    if (codigo) {
      slugs.set(String(codigo).trim().toLowerCase(), row.created_at ?? null);
    }
  });

  return slugs;
}

async function insertLogroJugador(supabaseAdmin, userId, slug) {
  const now = new Date().toISOString();

  const { error: slugErr } = await supabaseAdmin
    .from('logros_jugador')
    .insert({
      user_id: userId,
      slug,
      desbloqueado_en: now,
    });

  if (!slugErr) return true;
  if (isDuplicateError(slugErr)) return false;

  const { data: logro, error: logroErr } = await supabaseAdmin
    .from('logros')
    .select('id, codigo')
    .eq('codigo', slug)
    .maybeSingle();

  if (logroErr && !isMissingTable(logroErr)) throw logroErr;
  if (!logro?.id) {
    if (!isMissingTable(slugErr)) throw slugErr;
    return false;
  }

  const { error: insertErr } = await supabaseAdmin
    .from('logros_jugador')
    .insert({
      user_id: userId,
      logro_id: logro.id,
      contexto: { slug, desbloqueado_en: now },
    });

  if (insertErr && !isDuplicateError(insertErr)) throw insertErr;
  return !insertErr;
}

export async function sincronizarLogrosDesbloqueados(supabaseAdmin, userId, slugsNuevos) {
  if (!isValidUserId(userId)) {
    console.error('[logrosSync] sync omitido — user_id inválido:', userId);
    return { insertados: [], existentes: new Map() };
  }

  const nuevos = [...new Set((slugsNuevos ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  const existentes = await fetchExistingLogroSlugs(supabaseAdmin, userId);
  const insertados = [];

  console.log('[logrosSync] sincronizarLogrosDesbloqueados', {
    userId,
    candidatos: nuevos.length,
    yaEnDb: existentes.size,
  });

  for (const slug of nuevos) {
    if (existentes.has(slug)) continue;

    const inserted = await insertLogroJugador(supabaseAdmin, userId, slug);
    if (!inserted) {
      console.warn('[logrosSync] no se insertó logro_jugador', { userId, slug });
      continue;
    }

    existentes.set(slug, new Date().toISOString());
    insertados.push(slug);

    const xpResult = await sumarXPLogroDesbloqueado(supabaseAdmin, userId, slug);
    if (!xpResult) {
      console.warn('[logrosSync] sumarXP sin resultado para logro', { userId, slug });
    }
  }

  if (insertados.length) {
    console.log('[logrosSync] logros insertados', { userId, insertados });
  }

  return { insertados, existentes };
}

export async function sincronizarLogrosArena(supabaseAdmin, user, {
  metricDefinitions = [],
  metrics = {},
  comportamientoMetrics = null,
} = {}) {
  const userId = user?.id ?? null;
  if (!isValidUserId(userId)) {
    console.error('[logrosSync] sincronizarLogrosArena — user.id inválido:', userId, user?.email);
    return {
      insertados: [],
      existentes: new Map(),
      xp: { xp: 0, liga: 'INIT' },
      comportamientoMetrics: comportamientoMetrics ?? {},
    };
  }

  const compMetrics = comportamientoMetrics
    ?? await fetchComportamientoLogrosMetrics(supabaseAdmin, user);

  const slugsCalculados = [];

  for (const def of metricDefinitions) {
    const value = Number(metrics[def.metric] ?? 0);
    let desbloqueado = false;
    if (def.inverse) {
      desbloqueado = value > 0 && value <= def.meta;
    } else {
      desbloqueado = value >= def.meta;
    }
    if (desbloqueado) slugsCalculados.push(def.slug);
  }

  for (const def of LOGROS_COMPORTAMIENTO) {
    if (evaluaComportamientoLogro(def.slug, compMetrics)) {
      slugsCalculados.push(def.slug);
    }
  }

  const sync = await sincronizarLogrosDesbloqueados(supabaseAdmin, userId, slugsCalculados);
  const xp = await getXPJugador(supabaseAdmin, userId);

  return {
    ...sync,
    xp,
    comportamientoMetrics: compMetrics,
  };
}
