/**
 * Búsqueda pública de jugadores (canónica).
 * No expone email/teléfono/documento ni datos admin.
 */

export const SEARCH_MIN_CHARS = 2;
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;
export const CONTEXTOS = Object.freeze(['perfil', 'equipo', 'partido', 'comunidad']);

export function httpError(status, message) {
  const err = new Error(message);
  err.status = status;
  return err;
}

export function normalizeSearchQuery(raw) {
  let q = String(raw ?? '').trim();
  q = q.replace(/^@+/, '').trim();
  return q;
}

export function escapeIlikeTerm(raw) {
  return String(raw ?? '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/"/g, '\\"');
}

export function parseSearchLimit(raw) {
  const n = parseInt(String(raw ?? SEARCH_DEFAULT_LIMIT), 10);
  if (!Number.isFinite(n) || n < 1) return SEARCH_DEFAULT_LIMIT;
  return Math.min(n, SEARCH_MAX_LIMIT);
}

export function parseSearchPage(raw) {
  const n = parseInt(String(raw ?? '1'), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function normalizeContexto(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return CONTEXTOS.includes(v) ? v : 'perfil';
}

export function buildNombreCompleto(nombre, apellido) {
  return [String(nombre ?? '').trim(), String(apellido ?? '').trim()].filter(Boolean).join(' ').trim();
}

export function mapJugadorBusquedaPublica(row, {
  viewerId = null,
  blockedIds = new Set(),
  excludeIds = new Set(),
  contexto = 'perfil',
  partidoExcluded = new Set(),
} = {}) {
  if (!row?.user_id) return null;
  const uid = String(row.user_id);
  if (excludeIds.has(uid)) return null;
  if (blockedIds.has(uid)) return null;

  const nombre = String(row.nombre ?? '').trim();
  const apellido = String(row.apellido ?? '').trim();
  const aliasRaw = String(row.username ?? row.apodo ?? row.alias ?? '').trim();
  const alias = aliasRaw
    ? (aliasRaw.startsWith('@') ? aliasRaw : `@${aliasRaw}`)
    : null;
  const display_name = buildNombreCompleto(nombre, apellido)
    || String(row.nombre_saludo ?? '').trim()
    || alias
    || 'Jugador';

  const es_mi_perfil = Boolean(viewerId && uid === String(viewerId));
  const bloqueado = Boolean(viewerId && blockedIds.has(uid));
  const inPartido = partidoExcluded.has(uid);

  const flags = {
    es_mi_perfil,
    bloqueado: false, // blocked users are filtered out; keep false for visible rows
    puede_invitar_equipo: !es_mi_perfil && !bloqueado,
    puede_invitar_partido: !es_mi_perfil && !bloqueado && !inPartido,
    puede_seguir: !es_mi_perfil && !bloqueado && contexto !== 'equipo',
  };

  if (contexto === 'partido' && inPartido) {
    flags.puede_invitar_partido = false;
    flags.motivo_no_elegible = 'ya_en_partido';
  }

  return {
    user_id: row.user_id,
    nombre: nombre || null,
    apellido: apellido || null,
    display_name,
    alias,
    foto_url: row.foto_url ?? null,
    pais: row.pais ?? null,
    ciudad: row.ciudad ?? row.localidad ?? null,
    nivel: row.nivel ?? null,
    ranking_resumen: row.rango || row.liga
      ? { rango: row.rango ?? null, liga: row.liga ?? null, xp: row.xp ?? null }
      : null,
    sede_principal: row.sede_id != null || row.club
      ? { sede_id: row.sede_id ?? null, nombre: row.club ?? null }
      : null,
    ...flags,
  };
}

/** Shape legacy GET /api/usuarios/buscar */
export function mapLegacyUsuariosBuscar(item) {
  if (!item) return null;
  return {
    user_id: item.user_id,
    nombre: item.display_name || item.nombre || 'Jugador',
    username: item.alias ? String(item.alias).replace(/^@/, '') : null,
    foto_url: item.foto_url ?? null,
    nivel: item.nivel ?? 'Intermedio',
  };
}

/** Shape legacy GET /api/equipos/buscar-jugador */
export function mapLegacyEquiposBuscar(item) {
  if (!item) return null;
  return {
    user_id: item.user_id,
    nombre: item.nombre,
    apellido: item.apellido,
    alias: item.alias,
    foto_url: item.foto_url,
    nivel: item.nivel,
    display_name: item.display_name,
  };
}

export function assertSearchQueryLength(q) {
  if (!q || q.length < SEARCH_MIN_CHARS) {
    return httpError(400, `Ingresá al menos ${SEARCH_MIN_CHARS} caracteres`);
  }
  return null;
}

export async function loadBlockedUserIds(supabaseAdmin, viewerId) {
  if (!viewerId) return new Set();
  try {
    const { data, error } = await supabaseAdmin
      .from('comunidad_bloqueos')
      .select('blocker_user_id,blocked_user_id')
      .or(`blocker_user_id.eq.${viewerId},blocked_user_id.eq.${viewerId}`);
    if (error) {
      // tabla ausente / pre-migración comunidad: no bloquear búsqueda
      if (/schema cache|does not exist|Could not find/i.test(error.message || '')) {
        return new Set();
      }
      throw error;
    }
    const set = new Set();
    for (const p of data || []) {
      if (String(p.blocker_user_id) === String(viewerId)) set.add(String(p.blocked_user_id));
      if (String(p.blocked_user_id) === String(viewerId)) set.add(String(p.blocker_user_id));
    }
    return set;
  } catch {
    return new Set();
  }
}

/**
 * IDs a excluir por contexto partido (capitan, jugadores, pendientes/invitados).
 */
export async function loadPartidoExcludeUserIds(supabaseAdmin, partidoId, { isSolicitudPendienteActiva } = {}) {
  const set = new Set();
  if (!partidoId) return set;

  const { data: partido, error: partidoErr } = await supabaseAdmin
    .from('partidos_abiertos')
    .select('id, capitan_user_id, fecha, hora, duracion_minutos, reserva_id')
    .eq('id', partidoId)
    .maybeSingle();
  if (partidoErr) throw partidoErr;
  if (partido?.capitan_user_id) set.add(String(partido.capitan_user_id));

  const { data: jugadores, error: jErr } = await supabaseAdmin
    .from('partidos_abiertos_jugadores')
    .select('user_id')
    .eq('partido_id', partidoId);
  if (jErr) throw jErr;
  for (const row of jugadores || []) {
    if (row.user_id) set.add(String(row.user_id));
  }

  const { data: solicitudes, error: sErr } = await supabaseAdmin
    .from('solicitudes_partido')
    .select('solicitante_id, estado, created_at, expires_at')
    .eq('partido_id', partidoId)
    .in('estado', ['pendiente', 'invitado']);
  if (sErr) throw sErr;
  for (const row of solicitudes || []) {
    if (!row.solicitante_id) continue;
    if (typeof isSolicitudPendienteActiva === 'function' && !isSolicitudPendienteActiva(row, partido)) {
      continue;
    }
    set.add(String(row.solicitante_id));
  }
  return set;
}

export async function searchJugadoresPublicos(supabaseAdmin, {
  q,
  viewerId = null,
  page = 1,
  limit = SEARCH_DEFAULT_LIMIT,
  sedeId = null,
  pais = null,
  nivel = null,
  deporte = null,
  excluirUserId = null,
  contexto = 'perfil',
  partidoId = null,
  isSolicitudPendienteActiva = null,
  strictMinChars = false,
} = {}) {
  const query = normalizeSearchQuery(q);
  if (query.length < SEARCH_MIN_CHARS) {
    if (strictMinChars) {
      const err = assertSearchQueryLength(query);
      if (err) throw err;
    }
    return { items: [], page: 1, limit: parseSearchLimit(limit), q: query, total_estimate: 0 };
  }

  const lim = parseSearchLimit(limit);
  const pg = parseSearchPage(page);
  const offset = (pg - 1) * lim;
  const ctx = normalizeContexto(contexto);
  const escaped = escapeIlikeTerm(query);

  const excludeIds = new Set();
  if (viewerId) excludeIds.add(String(viewerId));
  if (excluirUserId) excludeIds.add(String(excluirUserId));

  const blockedIds = await loadBlockedUserIds(supabaseAdmin, viewerId);
  for (const id of blockedIds) excludeIds.add(id);

  let partidoExcluded = new Set();
  if (partidoId || ctx === 'partido') {
    const pid = partidoId || null;
    if (pid) {
      partidoExcluded = await loadPartidoExcludeUserIds(supabaseAdmin, pid, {
        isSolicitudPendienteActiva,
      });
      // En contexto partido los ya invitados se marcan; no se ocultan del todo salvo exclude explícito legacy
    }
  }

  // Fetch a bit more to allow post-filter; avoid N+1
  const fetchLimit = Math.min(lim + excludeIds.size + 20, 100);
  let qb = supabaseAdmin
    .from('jugadores_perfil')
    .select('user_id,nombre,apellido,nombre_saludo,apodo,username,alias,foto_url,nivel,pais,ciudad,localidad,sede_id,club,xp,liga,rango,deportes')
    .or(
      [
        `nombre.ilike."%${escaped}%"`,
        `apellido.ilike."%${escaped}%"`,
        `apodo.ilike."%${escaped}%"`,
        `username.ilike."%${escaped}%"`,
        `alias.ilike."%${escaped}%"`,
        `nombre_saludo.ilike."%${escaped}%"`,
      ].join(','),
    )
    .not('user_id', 'is', null)
    .range(offset, offset + fetchLimit - 1);

  if (sedeId != null) qb = qb.eq('sede_id', sedeId);
  if (pais) qb = qb.ilike('pais', `%${escapeIlikeTerm(pais)}%`);
  if (nivel) qb = qb.ilike('nivel', `%${escapeIlikeTerm(nivel)}%`);

  const { data, error } = await qb;
  if (error) throw error;

  let rows = data || [];
  if (deporte) {
    const needle = String(deporte).trim().toLowerCase();
    rows = rows.filter((row) => {
      const d = row.deportes;
      if (!d) return false;
      if (typeof d === 'string') return d.toLowerCase().includes(needle);
      if (Array.isArray(d)) return d.some((x) => String(x).toLowerCase().includes(needle));
      return JSON.stringify(d).toLowerCase().includes(needle);
    });
  }

  // Prefer exact alias / full name matches first
  const qLower = query.toLowerCase();
  rows.sort((a, b) => {
    const score = (row) => {
      const un = String(row.username ?? row.apodo ?? '').toLowerCase();
      const full = buildNombreCompleto(row.nombre, row.apellido).toLowerCase();
      if (un === qLower) return 0;
      if (full === qLower) return 1;
      if (un.startsWith(qLower)) return 2;
      if (full.startsWith(qLower)) return 3;
      return 4;
    };
    return score(a) - score(b);
  });

  const items = [];
  for (const row of rows) {
    if (items.length >= lim) break;
    // En contexto partido: no ocultar siempre, marcar no elegible
    const excludeForMap = new Set(excludeIds);
    if (ctx === 'partido') {
      // no agregar partidoExcluded a exclude — se marca en flags
    } else if (ctx === 'equipo' || ctx === 'perfil' || ctx === 'comunidad') {
      // blocked already in excludeIds
    }
    const mapped = mapJugadorBusquedaPublica(row, {
      viewerId,
      blockedIds,
      excludeIds: excludeForMap,
      contexto: ctx,
      partidoExcluded,
    });
    if (mapped) items.push(mapped);
  }

  return {
    items,
    page: pg,
    limit: lim,
    q: query,
    contexto: ctx,
    has_more: rows.length > lim,
  };
}
