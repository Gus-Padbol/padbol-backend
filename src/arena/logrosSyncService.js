import { sumarXP, getXPJugador } from '../xp/xpService.js';

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
  const nuevos = [...new Set((slugsNuevos ?? []).map((s) => String(s).trim().toLowerCase()).filter(Boolean))];
  const existentes = await fetchExistingLogroSlugs(supabaseAdmin, userId);
  const insertados = [];

  for (const slug of nuevos) {
    if (existentes.has(slug)) continue;

    const inserted = await insertLogroJugador(supabaseAdmin, userId, slug);
    if (!inserted) continue;

    existentes.set(slug, new Date().toISOString());
    insertados.push(slug);

    await sumarXP(
      supabaseAdmin,
      userId,
      'LOGRO_DESBLOQUEADO',
      `Logro desbloqueado: ${slug}`,
      slug,
    ).catch((err) => console.warn(`⚠️ XP logro ${slug}:`, err.message));
  }

  return { insertados, existentes };
}

export async function sincronizarLogrosArena(supabaseAdmin, user, {
  metricDefinitions = [],
  metrics = {},
  comportamientoMetrics = null,
} = {}) {
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

  const sync = await sincronizarLogrosDesbloqueados(supabaseAdmin, user.id, slugsCalculados);
  const xp = await getXPJugador(supabaseAdmin, user.id);

  return {
    ...sync,
    xp,
    comportamientoMetrics: compMetrics,
  };
}
