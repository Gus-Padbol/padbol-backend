/** Admin jugadores list/search helpers (MEJ-04 / MEJ-05). */

export const ADMIN_JUGADORES_PAGE_SIZE_DEFAULT = 20;
export const ADMIN_JUGADORES_PAGE_SIZE_MAX = 50;
export const ADMIN_JUGADORES_SEARCH_MIN = 2;
export const ADMIN_JUGADORES_SEARCH_LIMIT_DEFAULT = 12;

const PERFIL_SELECT =
  'user_id, nombre, apellido, username, apodo, alias, email, telefono, foto_url, nivel, created_at, updated_at';

export function escapeIlike(raw) {
  return String(raw || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_')
    .replace(/"/g, '\\"');
}

export function normalizeSearchQuery(raw) {
  return String(raw || '')
    .trim()
    .replace(/^@+/, '')
    .replace(/\s+/g, ' ');
}

export function digitsOnly(raw) {
  return String(raw || '').replace(/\D/g, '');
}

export function parsePage(raw) {
  const n = parseInt(String(raw ?? '1'), 10);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

export function parseLimit(raw, fallback = ADMIN_JUGADORES_PAGE_SIZE_DEFAULT) {
  const n = parseInt(String(raw ?? ''), 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, ADMIN_JUGADORES_PAGE_SIZE_MAX);
}

export function parseSedeIdParam(raw) {
  if (raw == null || raw === '') return null;
  const n = parseInt(String(raw).trim(), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export function buildDisplayName(perfil) {
  const nombre = String(perfil?.nombre || '').trim();
  const apellido = String(perfil?.apellido || '').trim();
  const full = [nombre, apellido].filter(Boolean).join(' ').trim();
  if (full) return full;
  const saludo = String(perfil?.nombre_saludo || '').trim();
  if (saludo) return saludo;
  const username = String(perfil?.username || perfil?.apodo || perfil?.alias || '').trim();
  if (username) return username.startsWith('@') ? username.slice(1) : username;
  return String(perfil?.email || '').trim() || 'Jugador';
}

export function mapAdminJugadorRow(perfil, meta = {}) {
  const usernameRaw = String(perfil?.username || perfil?.apodo || perfil?.alias || '').trim();
  const username = usernameRaw
    ? (usernameRaw.startsWith('@') ? usernameRaw.slice(1) : usernameRaw)
    : null;
  return {
    user_id: perfil?.user_id ?? null,
    nombre: String(perfil?.nombre || '').trim() || null,
    apellido: String(perfil?.apellido || '').trim() || null,
    display_name: buildDisplayName(perfil),
    username,
    email: String(perfil?.email || '').trim().toLowerCase() || null,
    telefono: String(perfil?.telefono || '').trim() || null,
    foto_url: perfil?.foto_url ?? null,
    nivel: perfil?.nivel ?? null,
    vinculacion: meta.vinculacion || 'sin_historial',
    last_activity_at: meta.last_activity_at || perfil?.updated_at || perfil?.created_at || null,
    created_at: perfil?.created_at || null,
  };
}

/** Build PostgREST .or() filter for jugadores_perfil search. */
export function buildPerfilSearchOrFilter(q) {
  const cleaned = normalizeSearchQuery(q);
  if (cleaned.length < ADMIN_JUGADORES_SEARCH_MIN) return null;
  const escaped = escapeIlike(cleaned);
  const parts = [
    `nombre.ilike."%${escaped}%"`,
    `apellido.ilike."%${escaped}%"`,
    `username.ilike."%${escaped}%"`,
    `apodo.ilike."%${escaped}%"`,
    `alias.ilike."%${escaped}%"`,
    `email.ilike."%${escaped}%"`,
    `telefono.ilike."%${escaped}%"`,
  ];
  const digits = digitsOnly(cleaned);
  if (digits.length >= 4) {
    const digEsc = escapeIlike(digits);
    parts.push(`telefono.ilike."%${digEsc}%"`);
  }
  return parts.join(',');
}

export function resolveAdminJugadoresScope(role, requestedSedeId) {
  if (role?.rol === 'super_admin') {
    return {
      ok: true,
      sedeId: requestedSedeId,
      requireSede: false,
    };
  }
  if (role?.rol === 'admin_club') {
    if (role.sede_id == null) {
      return { ok: false, status: 403, error: 'Tu cuenta de admin no tiene sede asignada' };
    }
    if (requestedSedeId != null && requestedSedeId !== role.sede_id) {
      return { ok: false, status: 403, error: 'No podés consultar jugadores de otra sede' };
    }
    return {
      ok: true,
      sedeId: role.sede_id,
      requireSede: true,
    };
  }
  return { ok: false, status: 403, error: 'No tenés permiso para esta operación' };
}

/**
 * Collect recent player keys (user_id / email) from reservas for a sede.
 */
export async function collectSedeReservaPlayerMeta(supabaseAdmin, { sedeId, sedeNombre, sampleLimit = 2500 }) {
  let query = supabaseAdmin
    .from('reservas')
    .select('user_id, email, fecha, created_at, updated_at')
    .order('fecha', { ascending: false })
    .limit(sampleLimit);

  if (sedeId != null) {
    query = query.eq('sede_id', sedeId);
  } else if (sedeNombre) {
    query = query.eq('sede', sedeNombre);
  } else {
    return { userIds: [], emails: [], activityByUserId: new Map(), activityByEmail: new Map() };
  }

  const { data, error } = await query;
  if (error) throw error;

  const userIds = new Set();
  const emails = new Set();
  const activityByUserId = new Map();
  const activityByEmail = new Map();

  for (const row of data || []) {
    const activity = row.updated_at || row.created_at || (row.fecha ? `${row.fecha}T00:00:00` : null);
    const uid = row.user_id ? String(row.user_id) : '';
    const email = String(row.email || '').trim().toLowerCase();
    if (uid) {
      userIds.add(uid);
      if (activity && !activityByUserId.has(uid)) activityByUserId.set(uid, activity);
    }
    if (email) {
      emails.add(email);
      if (activity && !activityByEmail.has(email)) activityByEmail.set(email, activity);
    }
  }

  return {
    userIds: [...userIds],
    emails: [...emails],
    activityByUserId,
    activityByEmail,
  };
}

async function resolveSedeNombre(supabaseAdmin, sedeId) {
  if (sedeId == null) return null;
  const { data } = await supabaseAdmin
    .from('sedes')
    .select('nombre')
    .eq('id', sedeId)
    .maybeSingle();
  return data?.nombre ? String(data.nombre).trim() : null;
}

function chunk(arr, size) {
  const out = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

export async function fetchPerfilesByIdsAndEmails(supabaseAdmin, { userIds = [], emails = [] }) {
  const byId = new Map();

  for (const ids of chunk(userIds.filter(Boolean), 100)) {
    if (!ids.length) continue;
    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .select(PERFIL_SELECT)
      .in('user_id', ids);
    if (error) throw error;
    for (const row of data || []) {
      if (row?.user_id) byId.set(String(row.user_id), row);
    }
  }

  const missingEmails = emails
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => e && ![...byId.values()].some((p) => String(p.email || '').toLowerCase() === e));

  for (const emailsChunk of chunk(missingEmails, 100)) {
    if (!emailsChunk.length) continue;
    const { data, error } = await supabaseAdmin
      .from('jugadores_perfil')
      .select(PERFIL_SELECT)
      .in('email', emailsChunk);
    if (error) throw error;
    for (const row of data || []) {
      if (row?.user_id) byId.set(String(row.user_id), row);
      else if (row?.email) byId.set(`email:${String(row.email).toLowerCase()}`, row);
    }
  }

  return [...byId.values()];
}

function profileMatchesQuery(perfil, q) {
  const cleaned = normalizeSearchQuery(q).toLowerCase();
  if (!cleaned) return true;
  const digits = digitsOnly(cleaned);
  const hay = [
    perfil.nombre,
    perfil.apellido,
    perfil.username,
    perfil.apodo,
    perfil.alias,
    perfil.email,
    perfil.telefono,
    buildDisplayName(perfil),
  ]
    .map((v) => String(v || '').toLowerCase())
    .join(' ');
  if (hay.includes(cleaned)) return true;
  if (digits.length >= 4 && digitsOnly(perfil.telefono).includes(digits)) return true;
  return false;
}

/**
 * List players linked to a sede via reservation history (proxy until sede_jugadores exists).
 */
export async function listAdminJugadoresSede(supabaseAdmin, {
  sedeId,
  q = '',
  page = 1,
  limit = ADMIN_JUGADORES_PAGE_SIZE_DEFAULT,
}) {
  const sedeNombre = await resolveSedeNombre(supabaseAdmin, sedeId);
  const meta = await collectSedeReservaPlayerMeta(supabaseAdmin, { sedeId, sedeNombre });
  const perfiles = await fetchPerfilesByIdsAndEmails(supabaseAdmin, {
    userIds: meta.userIds,
    emails: meta.emails,
  });

  let rows = perfiles.map((perfil) => {
    const uid = perfil.user_id ? String(perfil.user_id) : '';
    const email = String(perfil.email || '').toLowerCase();
    const last =
      (uid && meta.activityByUserId.get(uid))
      || (email && meta.activityByEmail.get(email))
      || null;
    return mapAdminJugadorRow(perfil, {
      vinculacion: 'con_historial',
      last_activity_at: last,
    });
  });

  if (normalizeSearchQuery(q).length >= ADMIN_JUGADORES_SEARCH_MIN) {
    rows = rows.filter((r) => profileMatchesQuery(r, q));
  }

  rows.sort((a, b) => String(a.display_name || '').localeCompare(String(b.display_name || ''), 'es', { sensitivity: 'base' }));

  const total = rows.length;
  const start = (page - 1) * limit;
  const items = rows.slice(start, start + limit);
  return {
    items,
    page,
    limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / limit) || 1),
    sede_id: sedeId,
    vinculacion_mode: 'historial_reservas',
  };
}

/**
 * Global registered-player search for admin autocomplete (limited fields).
 */
export async function searchAdminJugadoresGlobal(supabaseAdmin, {
  q,
  limit = ADMIN_JUGADORES_SEARCH_LIMIT_DEFAULT,
  sedeId = null,
}) {
  const orFilter = buildPerfilSearchOrFilter(q);
  if (!orFilter) {
    return { items: [], q: normalizeSearchQuery(q) };
  }

  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select(PERFIL_SELECT)
    .or(orFilter)
    .limit(Math.min(limit * 2, ADMIN_JUGADORES_PAGE_SIZE_MAX));

  if (error) throw error;

  let sedeUserIds = new Set();
  let sedeEmails = new Set();
  if (sedeId != null) {
    const sedeNombre = await resolveSedeNombre(supabaseAdmin, sedeId);
    const meta = await collectSedeReservaPlayerMeta(supabaseAdmin, {
      sedeId,
      sedeNombre,
      sampleLimit: 1500,
    });
    sedeUserIds = new Set(meta.userIds);
    sedeEmails = new Set(meta.emails);
  }

  const items = (data || [])
    .map((perfil) => {
      const uid = perfil.user_id ? String(perfil.user_id) : '';
      const email = String(perfil.email || '').toLowerCase();
      const linked =
        (uid && sedeUserIds.has(uid))
        || (email && sedeEmails.has(email));
      return mapAdminJugadorRow(perfil, {
        vinculacion: linked ? 'con_historial' : 'registrado',
      });
    })
    .slice(0, limit);

  return { items, q: normalizeSearchQuery(q) };
}
