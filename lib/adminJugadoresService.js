/** Admin jugadores list/search + vinculación formal sede↔jugador (MEJ-04 / MEJ-05). */

export const ADMIN_JUGADORES_PAGE_SIZE_DEFAULT = 20;
export const ADMIN_JUGADORES_PAGE_SIZE_MAX = 50;
export const ADMIN_JUGADORES_SEARCH_MIN = 2;
export const ADMIN_JUGADORES_SEARCH_LIMIT_DEFAULT = 12;

export const ADMIN_JUGADORES_ORDER_DEFAULT = 'name_asc';
export const ADMIN_JUGADORES_ORDENES = Object.freeze([
  'name_asc',
  'name_desc',
  'activity_desc',
  'activity_asc',
]);
export const ADMIN_JUGADORES_VINCULACION_FILTERS = Object.freeze([
  'con_historial',
  'vinculado',
  'sin_historial',
]);

export const SEDE_JUGADOR_ESTADOS = Object.freeze(['activo', 'inactivo']);
export const SEDE_JUGADOR_ORIGENES = Object.freeze([
  'manual',
  'reserva',
  'torneo',
  'membresia',
  'importacion',
]);

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// jugadores_perfil en prod no tiene updated_at (pedirla → 42703).
const PERFIL_SELECT =
  'user_id, nombre, apellido, username, apodo, alias, email, telefono, foto_url, nivel, created_at';

const VINCULACION_SELECT =
  'id, sede_id, user_id, estado, origen, created_at, updated_at, desvinculado_at';

export function httpError(status, message, code) {
  const err = new Error(message);
  err.status = status;
  if (code) err.code = code;
  return err;
}

export function isMissingSedeJugadoresTableError(error) {
  const message = String(error?.message || error?.details || error || '');
  return (
    error?.code === 'PGRST205'
    || error?.code === '42P01'
    || (message.includes('sede_jugadores') && (
      message.includes('does not exist')
      || message.includes('Could not find the table')
      || message.includes('schema cache')
    ))
  );
}

export function isValidUserId(raw) {
  return UUID_REGEX.test(String(raw || '').trim());
}

export function normalizeOrigen(raw, fallback = 'manual') {
  const v = String(raw ?? '').trim().toLowerCase();
  return SEDE_JUGADOR_ORIGENES.includes(v) ? v : fallback;
}

export function parseVinculadoFilter(raw) {
  if (raw == null || raw === '') return null;
  const v = String(raw).trim().toLowerCase();
  if (['1', 'true', 'si', 'sí', 'yes'].includes(v)) return true;
  if (['0', 'false', 'no'].includes(v)) return false;
  return null;
}

export function parseOrden(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return ADMIN_JUGADORES_ORDENES.includes(v) ? v : ADMIN_JUGADORES_ORDER_DEFAULT;
}

export function parseVinculacionFilter(raw) {
  const v = String(raw ?? '').trim().toLowerCase();
  return ADMIN_JUGADORES_VINCULACION_FILTERS.includes(v) ? v : '';
}

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

/**
 * Strict sede_id for the players list: only a positive integer (digits) is
 * accepted. `1abc`, `0`, `-2` and `1.5` are invalid; they are never coerced nor
 * treated as "todos". Other endpoints keep parseSedeIdParam.
 */
export function parseSedeIdParamStrict(raw) {
  if (raw == null || raw === '') return null;
  const text = String(raw).trim();
  if (!/^[1-9]\d*$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
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

export function mapVinculacionPublica(linkRow = null) {
  if (!linkRow || String(linkRow.estado) !== 'activo') {
    return {
      vinculado: false,
      vinculacion_id: null,
      vinculacion_estado: linkRow?.estado ? String(linkRow.estado) : null,
      vinculacion_origen: null,
      vinculado_desde: null,
    };
  }
  return {
    vinculado: true,
    vinculacion_id: linkRow.id ?? null,
    vinculacion_estado: 'activo',
    vinculacion_origen: linkRow.origen ? String(linkRow.origen) : null,
    vinculado_desde: linkRow.created_at || null,
  };
}

export function mapAdminJugadorRow(perfil, meta = {}) {
  const usernameRaw = String(perfil?.username || perfil?.apodo || perfil?.alias || '').trim();
  const username = usernameRaw
    ? (usernameRaw.startsWith('@') ? usernameRaw.slice(1) : usernameRaw)
    : null;
  const linkFields = mapVinculacionPublica(meta.link || null);
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
    last_activity_at: meta.last_activity_at || perfil?.created_at || null,
    created_at: perfil?.created_at || null,
    ...linkFields,
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
  // reservas en prod no tiene updated_at (pedirla → 42703).
  let query = supabaseAdmin
    .from('reservas')
    .select('user_id, email, fecha, created_at')
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
    const activity = row.created_at || (row.fecha ? `${row.fecha}T00:00:00` : null);
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

async function assertSedeExists(supabaseAdmin, sedeId) {
  const { data, error } = await supabaseAdmin
    .from('sedes')
    .select('id, nombre')
    .eq('id', sedeId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw httpError(400, 'Sede inválida', 'SEDE_INVALIDA');
  return data;
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
 * Fetch active formal links for a sede. Graceful if table missing.
 */
export async function fetchSedeJugadoresActivos(supabaseAdmin, sedeId) {
  if (sedeId == null) return { missingTable: false, rows: [], byUserId: new Map() };
  const { data, error } = await supabaseAdmin
    .from('sede_jugadores')
    .select(VINCULACION_SELECT)
    .eq('sede_id', sedeId)
    .eq('estado', 'activo')
    .limit(5000);

  if (error) {
    if (isMissingSedeJugadoresTableError(error)) {
      return { missingTable: true, rows: [], byUserId: new Map() };
    }
    throw error;
  }

  const rows = data || [];
  const byUserId = new Map();
  for (const row of rows) {
    if (row?.user_id) byUserId.set(String(row.user_id), row);
  }
  return { missingTable: false, rows, byUserId };
}

/**
 * Merge reservation-history players + formally linked players (dedupe by user_id).
 * Pure helper for tests.
 */
export function mergeAdminJugadoresRoster({
  perfilesHistorial = [],
  perfilesVinculados = [],
  activityByUserId = new Map(),
  activityByEmail = new Map(),
  linksByUserId = new Map(),
}) {
  const byUserId = new Map();

  for (const perfil of perfilesHistorial) {
    const uid = perfil?.user_id ? String(perfil.user_id) : '';
    if (!uid) continue;
    const email = String(perfil.email || '').toLowerCase();
    const last =
      activityByUserId.get(uid)
      || (email && activityByEmail.get(email))
      || null;
    const link = linksByUserId.get(uid) || null;
    byUserId.set(uid, mapAdminJugadorRow(perfil, {
      vinculacion: 'con_historial',
      last_activity_at: last,
      link,
    }));
  }

  for (const perfil of perfilesVinculados) {
    const uid = perfil?.user_id ? String(perfil.user_id) : '';
    if (!uid) continue;
    const link = linksByUserId.get(uid) || null;
    const existing = byUserId.get(uid);
    if (existing) {
      byUserId.set(uid, {
        ...existing,
        ...mapVinculacionPublica(link),
      });
      continue;
    }
    const email = String(perfil.email || '').toLowerCase();
    const last =
      activityByUserId.get(uid)
      || (email && activityByEmail.get(email))
      || null;
    byUserId.set(uid, mapAdminJugadorRow(perfil, {
      vinculacion: link ? 'vinculado' : 'sin_historial',
      last_activity_at: last,
      link,
    }));
  }

  return [...byUserId.values()];
}

function activityTimestamp(row) {
  const raw = row?.last_activity_at;
  const parsed = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Deterministic in-memory ordering for the sede roster (before slicing). */
export function sortAdminJugadoresRows(rows, orden = ADMIN_JUGADORES_ORDER_DEFAULT) {
  const out = Array.isArray(rows) ? [...rows] : [];
  const byName = (a, b) => String(a.display_name || '')
    .localeCompare(String(b.display_name || ''), 'es', { sensitivity: 'base' });
  const byRecent = (a, b) => activityTimestamp(b) - activityTimestamp(a);

  switch (parseOrden(orden)) {
    case 'name_desc':
      return out.sort((a, b) => byName(b, a));
    case 'activity_desc':
      return out.sort((a, b) => byRecent(a, b) || byName(a, b));
    case 'activity_asc':
      return out.sort((a, b) => -byRecent(a, b) || byName(a, b));
    case 'name_asc':
    default:
      return out.sort(byName);
  }
}

/**
 * List players for a sede: reservation history ∪ formal active links.
 * `vinculacion` and `orden` filter/sort before pagination, so total and pages
 * stay consistent with the visible rows.
 */
export async function listAdminJugadoresSede(supabaseAdmin, {
  sedeId,
  q = '',
  page = 1,
  limit = ADMIN_JUGADORES_PAGE_SIZE_DEFAULT,
  vinculado = null,
  vinculacion = '',
  orden = ADMIN_JUGADORES_ORDER_DEFAULT,
}) {
  const sedeNombre = await resolveSedeNombre(supabaseAdmin, sedeId);
  const meta = await collectSedeReservaPlayerMeta(supabaseAdmin, { sedeId, sedeNombre });
  const links = await fetchSedeJugadoresActivos(supabaseAdmin, sedeId);

  const linkUserIds = links.rows.map((r) => String(r.user_id)).filter(Boolean);
  const allUserIds = [...new Set([...meta.userIds, ...linkUserIds])];

  const perfiles = await fetchPerfilesByIdsAndEmails(supabaseAdmin, {
    userIds: allUserIds,
    emails: meta.emails,
  });

  const perfilById = new Map(
    perfiles.filter((p) => p?.user_id).map((p) => [String(p.user_id), p]),
  );
  const perfilesHistorial = meta.userIds
    .map((id) => perfilById.get(String(id)))
    .filter(Boolean);
  // Also include email-only historial perfiles already in `perfiles`
  for (const p of perfiles) {
    if (!p?.user_id) continue;
    const uid = String(p.user_id);
    const email = String(p.email || '').toLowerCase();
    const inHistorial =
      meta.userIds.includes(uid)
      || (email && meta.emails.includes(email));
    if (inHistorial && !perfilesHistorial.some((x) => String(x.user_id) === uid)) {
      perfilesHistorial.push(p);
    }
  }

  const perfilesVinculados = linkUserIds
    .map((id) => perfilById.get(String(id)))
    .filter(Boolean);

  let rows = mergeAdminJugadoresRoster({
    perfilesHistorial,
    perfilesVinculados,
    activityByUserId: meta.activityByUserId,
    activityByEmail: meta.activityByEmail,
    linksByUserId: links.byUserId,
  });

  if (normalizeSearchQuery(q).length >= ADMIN_JUGADORES_SEARCH_MIN) {
    rows = rows.filter((r) => profileMatchesQuery(r, q));
  }

  if (vinculado === true) {
    rows = rows.filter((r) => r.vinculado === true);
  } else if (vinculado === false) {
    rows = rows.filter((r) => r.vinculado !== true);
  }

  const vinculacionNorm = parseVinculacionFilter(vinculacion);
  if (vinculacionNorm) {
    rows = rows.filter((r) => String(r.vinculacion || '') === vinculacionNorm);
  }

  const ordenNorm = parseOrden(orden);
  rows = sortAdminJugadoresRows(rows, ordenNorm);

  const total = rows.length;
  const start = (page - 1) * limit;
  const items = rows.slice(start, start + limit);
  return {
    items,
    page,
    limit,
    total,
    total_pages: Math.max(1, Math.ceil(total / limit) || 1),
    scope: 'sede',
    sede_id: sedeId,
    vinculacion_mode: links.missingTable
      ? 'historial_reservas'
      : 'sede_jugadores_y_historial',
    vinculacion: vinculacionNorm || null,
    orden: ordenNorm,
    q: normalizeSearchQuery(q),
  };
}

const GLOBAL_LIST_FIELDS =
  'id, user_id, nombre, apellido, nombre_saludo, username, apodo, alias, created_at';

/** Escape LIKE wildcards for a parameterized PostgreSQL ILIKE ... ESCAPE '\'. */
export function escapeSqlIlike(raw) {
  return String(raw || '')
    .replace(/\\/g, '\\\\')
    .replace(/%/g, '\\%')
    .replace(/_/g, '\\_');
}

function globalListOrderClause(orden, prefix = '') {
  const p = prefix ? `${prefix}.` : '';
  switch (parseOrden(orden)) {
    case 'name_desc':
      return `COALESCE(${p}nombre, '') DESC, COALESCE(${p}apellido, '') DESC, ${p}id ASC`;
    case 'activity_desc':
      return `${p}created_at DESC NULLS LAST, ${p}id ASC`;
    case 'activity_asc':
      return `${p}created_at ASC NULLS LAST, ${p}id ASC`;
    case 'name_asc':
    default:
      return `COALESCE(${p}nombre, '') ASC, COALESCE(${p}apellido, '') ASC, ${p}id ASC`;
  }
}

/**
 * Parameterized, read-only SQL for the global roster.
 *
 * Identity: user_id, else lowercased email, else id. `DISTINCT ON` collapses
 * duplicate profile rows BEFORE count/limit/offset (schema has no accredited
 * UNIQUE user_id), keeping the lowest id as deterministic representative.
 * The page subquery and the total come from the same statement/snapshot, and
 * the LEFT JOIN keeps total available even when the requested page is empty.
 */
export function buildAdminJugadoresGlobalQuery({
  q = '',
  orden = ADMIN_JUGADORES_ORDER_DEFAULT,
  limit = ADMIN_JUGADORES_PAGE_SIZE_DEFAULT,
  offset = 0,
} = {}) {
  const cleaned = normalizeSearchQuery(q);
  const params = [];
  let where = 'TRUE';

  if (cleaned.length >= ADMIN_JUGADORES_SEARCH_MIN) {
    const pattern = `%${escapeSqlIlike(cleaned)}%`;
    params.push(pattern);
    const term = `$${params.length}`;
    const clauses = [
      `nombre ILIKE ${term} ESCAPE '\\'`,
      `apellido ILIKE ${term} ESCAPE '\\'`,
      `username ILIKE ${term} ESCAPE '\\'`,
      `apodo ILIKE ${term} ESCAPE '\\'`,
      `alias ILIKE ${term} ESCAPE '\\'`,
      `email ILIKE ${term} ESCAPE '\\'`,
      `telefono ILIKE ${term} ESCAPE '\\'`,
    ];
    const digits = digitsOnly(cleaned);
    if (digits.length >= 4) {
      params.push(`%${escapeSqlIlike(digits)}%`);
      clauses.push(
        `regexp_replace(COALESCE(telefono, ''), '\\D', '', 'g') ILIKE $${params.length} ESCAPE '\\'`,
      );
    }
    where = `(${clauses.join(' OR ')})`;
  }

  const safeLimit = Math.max(
    1,
    Math.min(Number(limit) || ADMIN_JUGADORES_PAGE_SIZE_DEFAULT, ADMIN_JUGADORES_PAGE_SIZE_MAX),
  );
  const safeOffset = Math.max(0, Number(offset) || 0);
  params.push(safeLimit, safeOffset);
  const limitParam = `$${params.length - 1}`;
  const offsetParam = `$${params.length}`;
  const pageOrder = globalListOrderClause(orden);
  const outerOrder = globalListOrderClause(orden, 'p');

  const sql = `WITH base AS (
  SELECT ${GLOBAL_LIST_FIELDS},
         COALESCE(
           'user:' || NULLIF(user_id::text, ''),
           'email:' || NULLIF(lower(btrim(email)), ''),
           'id:' || id::text
         ) AS identity_key
  FROM public.jugadores_perfil
  WHERE ${where}
),
dedup AS MATERIALIZED (
  SELECT DISTINCT ON (identity_key) *
  FROM base
  ORDER BY identity_key ASC, id ASC
),
page AS (
  SELECT * FROM dedup
  ORDER BY ${pageOrder}
  LIMIT ${limitParam} OFFSET ${offsetParam}
)
SELECT p.id, p.user_id, p.nombre, p.apellido, p.nombre_saludo,
       p.username, p.apodo, p.alias, p.created_at, t.total
FROM (SELECT COUNT(*)::bigint AS total FROM dedup) t
LEFT JOIN page p ON TRUE
ORDER BY ${outerOrder}`;

  return {
    sql,
    params,
    q: cleaned,
    orden: parseOrden(orden),
    limit: safeLimit,
    offset: safeOffset,
  };
}

/** Display name from public-ish profile fields only (never email/phone). */
export function buildGlobalDisplayName(perfil) {
  const nombre = String(perfil?.nombre || '').trim();
  const apellido = String(perfil?.apellido || '').trim();
  const full = [nombre, apellido].filter(Boolean).join(' ').trim();
  if (full) return full;
  const saludo = String(perfil?.nombre_saludo || '').trim();
  if (saludo) return saludo;
  const username = String(perfil?.username || perfil?.apodo || perfil?.alias || '').trim();
  if (username) return username.startsWith('@') ? username.slice(1) : username;
  return 'Jugador';
}

/**
 * Minimal DTO for "Todos los jugadores": UUID, name/alias, link label and
 * registration date. No email, phone, photo or level in this bulk load.
 */
export function mapAdminJugadorGlobalRow(row) {
  const usernameRaw = String(row?.username || row?.apodo || row?.alias || '').trim();
  const userId = row?.user_id ? String(row.user_id) : null;
  return {
    user_id: userId,
    // Stable row key for React lists when there is no auth UUID (never fabricated).
    row_key: userId ? `user:${userId}` : (row?.id != null ? `profile:${row.id}` : null),
    nombre: String(row?.nombre || '').trim() || null,
    apellido: String(row?.apellido || '').trim() || null,
    display_name: buildGlobalDisplayName(row),
    username: usernameRaw
      ? (usernameRaw.startsWith('@') ? usernameRaw.slice(1) : usernameRaw)
      : null,
    vinculacion: 'registrado',
    last_activity_at: row?.created_at || null,
    created_at: row?.created_at || null,
  };
}

/**
 * Global list of registered players (Super Admin "todos los jugadores").
 *
 * Uses the existing PostgreSQL pool with a parameterized read-only query
 * (no PostgREST row cap, no scan/truncation, no writes). A present-but-invalid
 * relationship filter is rejected; `activity_*` is the registration date.
 */
export async function listAdminJugadoresGlobal(pgPool, {
  q = '',
  page = 1,
  limit = ADMIN_JUGADORES_PAGE_SIZE_DEFAULT,
  vinculado = null,
  vinculacion = '',
  orden = ADMIN_JUGADORES_ORDER_DEFAULT,
} = {}) {
  if (vinculado !== null || parseVinculacionFilter(vinculacion)) {
    throw httpError(400, 'El filtro de vinculación requiere una sede', 'VINCULADO_REQUIRES_SEDE');
  }
  if (!pgPool || typeof pgPool.query !== 'function') {
    throw httpError(503, 'Base de datos no disponible para listar jugadores', 'JUGADORES_DB_UNAVAILABLE');
  }

  const cleaned = normalizeSearchQuery(q);
  const ordenNorm = parseOrden(orden);
  const base = {
    items: [],
    page,
    limit,
    total: 0,
    total_pages: 1,
    scope: 'global',
    sede_id: null,
    vinculacion_mode: 'registrados',
    vinculacion: null,
    orden: ordenNorm,
    q: cleaned,
  };

  // Empty q lists everyone; 1-char q stays empty (same min as search).
  if (cleaned.length > 0 && cleaned.length < ADMIN_JUGADORES_SEARCH_MIN) {
    return base;
  }

  const offset = (page - 1) * limit;
  const query = buildAdminJugadoresGlobalQuery({ q: cleaned, orden: ordenNorm, limit, offset });
  const { rows } = await pgPool.query(query.sql, query.params);
  const dbRows = Array.isArray(rows) ? rows : [];
  const total = dbRows.length ? Number(dbRows[0]?.total) || 0 : 0;
  const items = dbRows
    .filter((row) => row && row.id != null)
    .map((row) => mapAdminJugadorGlobalRow(row));

  return {
    ...base,
    items,
    total,
    total_pages: Math.max(1, Math.ceil(total / limit) || 1),
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
  let linksByUserId = new Map();
  if (sedeId != null) {
    const sedeNombre = await resolveSedeNombre(supabaseAdmin, sedeId);
    const meta = await collectSedeReservaPlayerMeta(supabaseAdmin, {
      sedeId,
      sedeNombre,
      sampleLimit: 1500,
    });
    sedeUserIds = new Set(meta.userIds);
    sedeEmails = new Set(meta.emails);
    const links = await fetchSedeJugadoresActivos(supabaseAdmin, sedeId);
    linksByUserId = links.byUserId;
  }

  const items = (data || [])
    .map((perfil) => {
      const uid = perfil.user_id ? String(perfil.user_id) : '';
      const email = String(perfil.email || '').toLowerCase();
      const hasHistorial =
        (uid && sedeUserIds.has(uid))
        || (email && sedeEmails.has(email));
      const link = uid ? (linksByUserId.get(uid) || null) : null;
      let vinculacion = 'registrado';
      if (hasHistorial) vinculacion = 'con_historial';
      else if (link) vinculacion = 'vinculado';
      return mapAdminJugadorRow(perfil, {
        vinculacion,
        link,
      });
    })
    .slice(0, limit);

  return { items, q: normalizeSearchQuery(q) };
}

async function loadPerfilOr404(supabaseAdmin, userId) {
  const { data, error } = await supabaseAdmin
    .from('jugadores_perfil')
    .select(PERFIL_SELECT)
    .eq('user_id', userId)
    .maybeSingle();
  if (error) throw error;
  if (!data) throw httpError(404, 'Jugador no encontrado', 'JUGADOR_NOT_FOUND');
  return data;
}

async function findSedeJugadorRow(supabaseAdmin, sedeId, userId) {
  const { data, error } = await supabaseAdmin
    .from('sede_jugadores')
    .select(`${VINCULACION_SELECT}, notas, created_by`)
    .eq('sede_id', sedeId)
    .eq('user_id', userId)
    .order('updated_at', { ascending: false })
    .limit(5);

  if (error) {
    if (isMissingSedeJugadoresTableError(error)) {
      throw httpError(503, 'Vinculación sede↔jugador aún no disponible — migración SQL pendiente', 'SEDE_JUGADORES_PENDING');
    }
    throw error;
  }
  return (data && data[0]) || null;
}

function mapVinculacionActionResponse(row, { idempotent = false, reactivated = false } = {}) {
  const out = {
    ok: true,
    vinculacion: {
      id: row.id,
      sede_id: row.sede_id,
      user_id: row.user_id,
      estado: row.estado,
      origen: row.origen,
      created_at: row.created_at,
      updated_at: row.updated_at,
      desvinculado_at: row.desvinculado_at ?? null,
      // notas intentionally omitted from roster list; returned on write for admin UX
      notas: row.notas ?? null,
    },
  };
  if (idempotent) out.idempotent = true;
  if (reactivated) out.reactivated = true;
  return out;
}

/**
 * Idempotent formal link of player to sede.
 */
export async function vincularJugadorSede(supabaseAdmin, {
  role,
  userId,
  sedeId: requestedSedeId,
  origen,
  notas,
  adminUserId = null,
}) {
  const uid = String(userId || '').trim();
  if (!isValidUserId(uid)) throw httpError(400, 'userId inválido', 'USER_ID_INVALID');

  const scope = resolveAdminJugadoresScope(role, requestedSedeId);
  if (!scope.ok) throw httpError(scope.status, scope.error);
  if (scope.sedeId == null) {
    throw httpError(400, 'sede_id es requerido', 'SEDE_REQUIRED');
  }

  await assertSedeExists(supabaseAdmin, scope.sedeId);
  await loadPerfilOr404(supabaseAdmin, uid);

  const origenNorm = normalizeOrigen(origen, 'manual');
  const notasNorm = notas != null ? String(notas).trim().slice(0, 1000) || null : null;
  const now = new Date().toISOString();

  let existing;
  try {
    existing = await findSedeJugadorRow(supabaseAdmin, scope.sedeId, uid);
  } catch (err) {
    if (err?.status) throw err;
    if (isMissingSedeJugadoresTableError(err)) {
      throw httpError(503, 'Vinculación sede↔jugador aún no disponible — migración SQL pendiente', 'SEDE_JUGADORES_PENDING');
    }
    throw err;
  }

  if (existing && String(existing.estado) === 'activo') {
    return mapVinculacionActionResponse(existing, { idempotent: true });
  }

  if (existing) {
    const patch = {
      estado: 'activo',
      origen: origenNorm,
      updated_at: now,
      desvinculado_at: null,
    };
    if (notasNorm !== null) patch.notas = notasNorm;

    const { data, error } = await supabaseAdmin
      .from('sede_jugadores')
      .update(patch)
      .eq('id', existing.id)
      .select(`${VINCULACION_SELECT}, notas, created_by`)
      .single();
    if (error) {
      if (isMissingSedeJugadoresTableError(error)) {
        throw httpError(503, 'Vinculación sede↔jugador aún no disponible — migración SQL pendiente', 'SEDE_JUGADORES_PENDING');
      }
      throw error;
    }
    return mapVinculacionActionResponse(data, { reactivated: true });
  }

  const insertRow = {
    sede_id: scope.sedeId,
    user_id: uid,
    estado: 'activo',
    origen: origenNorm,
    notas: notasNorm,
    created_by: adminUserId || null,
    created_at: now,
    updated_at: now,
    desvinculado_at: null,
  };

  const { data, error } = await supabaseAdmin
    .from('sede_jugadores')
    .insert([insertRow])
    .select(`${VINCULACION_SELECT}, notas, created_by`)
    .single();

  if (error) {
    if (isMissingSedeJugadoresTableError(error)) {
      throw httpError(503, 'Vinculación sede↔jugador aún no disponible — migración SQL pendiente', 'SEDE_JUGADORES_PENDING');
    }
    // Unique race: treat as idempotent fetch
    if (error.code === '23505') {
      const again = await findSedeJugadorRow(supabaseAdmin, scope.sedeId, uid);
      if (again) return mapVinculacionActionResponse(again, { idempotent: true });
    }
    throw error;
  }

  return mapVinculacionActionResponse(data);
}

/**
 * Soft-unlink: keeps row history (estado=inactivo). Idempotent if already inactive/absent.
 */
export async function desvincularJugadorSede(supabaseAdmin, {
  role,
  userId,
  sedeId: requestedSedeId,
}) {
  const uid = String(userId || '').trim();
  if (!isValidUserId(uid)) throw httpError(400, 'userId inválido', 'USER_ID_INVALID');

  const scope = resolveAdminJugadoresScope(role, requestedSedeId);
  if (!scope.ok) throw httpError(scope.status, scope.error);
  if (scope.sedeId == null) {
    throw httpError(400, 'sede_id es requerido', 'SEDE_REQUIRED');
  }

  await assertSedeExists(supabaseAdmin, scope.sedeId);

  let existing;
  try {
    existing = await findSedeJugadorRow(supabaseAdmin, scope.sedeId, uid);
  } catch (err) {
    if (err?.status) throw err;
    if (isMissingSedeJugadoresTableError(err)) {
      throw httpError(503, 'Vinculación sede↔jugador aún no disponible — migración SQL pendiente', 'SEDE_JUGADORES_PENDING');
    }
    throw err;
  }

  if (!existing) {
    return {
      ok: true,
      idempotent: true,
      vinculacion: null,
      message: 'Sin vinculación activa',
    };
  }

  if (String(existing.estado) !== 'activo') {
    return mapVinculacionActionResponse(existing, { idempotent: true });
  }

  const now = new Date().toISOString();
  const { data, error } = await supabaseAdmin
    .from('sede_jugadores')
    .update({
      estado: 'inactivo',
      desvinculado_at: now,
      updated_at: now,
    })
    .eq('id', existing.id)
    .select(`${VINCULACION_SELECT}, notas, created_by`)
    .single();

  if (error) {
    if (isMissingSedeJugadoresTableError(error)) {
      throw httpError(503, 'Vinculación sede↔jugador aún no disponible — migración SQL pendiente', 'SEDE_JUGADORES_PENDING');
    }
    throw error;
  }

  return mapVinculacionActionResponse(data);
}
