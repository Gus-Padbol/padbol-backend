/**
 * Panel de push para administradores.
 *
 * La resolución de alcance y el envío viven del lado servidor. Nunca se acepta
 * un user_id como autorización suficiente ni se exponen tokens Expo al panel.
 */

import { randomUUID } from 'node:crypto';
import { hasCompleteTerritorialScope } from './adminTerritorialScope.js';

const ADMIN_PUSH_ROLES = new Set(['super_admin', 'admin_nacional', 'admin_cadena', 'admin_club']);
const ADMIN_IDEMPOTENCY_RE = /^[A-Za-z0-9._:-]{16,120}$/;

const WEEKLY_LIMITS = {
  admin_club: 3,
  admin_nacional: 2,
  admin_cadena: 3,
  super_admin: 1,
};

function httpError(message, status = 500, code = 'ADMIN_PUSH_ERROR') {
  const error = new Error(message);
  error.status = status;
  error.code = code;
  return error;
}

function normalizeGeo(raw) {
  return String(raw || '')
    .replace(/^[\p{Emoji_Presentation}\s]*/u, '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function geoMatches(adminRaw, targetRaw) {
  const a = normalizeGeo(adminRaw);
  const b = normalizeGeo(targetRaw);
  if (!a || !b) return false;
  return a === b;
}

export function isAdminPushTargetedSegment(segment) {
  return String(segment?.type || '').trim().toLowerCase() === 'jugador';
}

export function adminPushCategoryForSegment() {
  // El panel permite texto libre; no puede convertirlo en aviso operativo.
  return 'marketing';
}

function effectiveAdminRole(scope) {
  if (scope?.superA) return 'super_admin';
  return String(scope?.rol || '').trim().toLowerCase();
}

function nationalTerritory(scope) {
  // Match the legacy admin_nacional default resolved by server.js.
  return { ...scope, alcance: scope?.alcance || 'pais' };
}

function hasCountrywideScope(scope) {
  const territory = nationalTerritory(scope);
  return territory.alcance === 'pais' && hasCompleteTerritorialScope(territory);
}

function assertNationalTerritory(scope) {
  if (effectiveAdminRole(scope) !== 'admin_nacional') return;
  const territory = nationalTerritory(scope);
  if (hasCompleteTerritorialScope(territory)) return;
  if (territory.alcance === 'sede' && Number.isInteger(scope.sedeId) && scope.sedeId > 0) return;
  throw httpError('El alcance territorial está incompleto', 403, 'ADMIN_PUSH_SCOPE_DENIED');
}

function weekAgoIso() {
  return new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
}

export async function countAdminPushSendsThisWeek(supabase, adminUserId, { onlyBroadcast = false } = {}) {
  const uid = String(adminUserId || '').trim();
  if (!uid) return 0;
  const { data, error } = await supabase
    .from('notificaciones_admin_log')
    .select('id, segmento')
    .eq('admin_user_id', uid)
    .gte('created_at', weekAgoIso());
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  if (!onlyBroadcast) return rows.length;
  return rows.filter((row) => {
    try {
      const segment = typeof row.segmento === 'string' ? JSON.parse(row.segmento) : row.segmento;
      return !isAdminPushTargetedSegment(segment);
    } catch {
      return true;
    }
  }).length;
}

export async function getAdminPushQuota(supabase, scope) {
  const role = effectiveAdminRole(scope);
  const limit = WEEKLY_LIMITS[role] ?? 0;
  const used = await countAdminPushSendsThisWeek(supabase, scope?.authUserId, {
    onlyBroadcast: role === 'super_admin',
  });
  return {
    role,
    limit,
    used,
    remaining: Math.max(0, limit - used),
    unlimitedTargeted: role === 'super_admin',
    weekStartsAt: weekAgoIso(),
  };
}

export function parseAdminPushSegment(raw) {
  if (raw && typeof raw === 'object') return raw;
  if (typeof raw === 'string' && raw.trim()) {
    try {
      return JSON.parse(raw);
    } catch {
      return { type: String(raw).trim() };
    }
  }
  return {};
}

async function fetchAllRows(buildQuery, pageSize = 1000) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const { data, error } = await buildQuery().range(offset, offset + pageSize - 1);
    if (error) throw error;
    const page = Array.isArray(data) ? data : [];
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
}

async function userIdsFromSedeActivity(supabase, sedeId) {
  const sid = Number(sedeId);
  if (!Number.isFinite(sid)) return [];
  const [reservas, perfiles] = await Promise.all([
    fetchAllRows(() => supabase.from('reservas').select('user_id').eq('sede_id', sid).not('user_id', 'is', null)),
    fetchAllRows(() => supabase.from('jugadores_perfil').select('user_id').eq('sede_id', sid).not('user_id', 'is', null)),
  ]);
  const ids = new Set();
  for (const row of [...(reservas || []), ...(perfiles || [])]) {
    const userId = String(row?.user_id || '').trim();
    if (userId) ids.add(userId);
  }
  return [...ids];
}

async function allowedSedeIds(scope, sedesPermitidasPorScopeFn) {
  const allowed = await sedesPermitidasPorScopeFn(scope);
  return (allowed?.sedes || []).map((sede) => Number(sede.id)).filter(Number.isFinite);
}

async function assertChainNotificationsEnabled(scope, supabase) {
  if (effectiveAdminRole(scope) !== 'admin_cadena') return;
  if (!scope?.organizacionId) {
    throw httpError('Tu usuario no tiene una organización multisede asignada', 403, 'ADMIN_PUSH_SCOPE_DENIED');
  }
  const { data, error } = await supabase
    .from('organizaciones')
    .select('estado, funciones_habilitadas')
    .eq('id', scope.organizacionId)
    .maybeSingle();
  if (error) throw error;
  if (!data || data.estado !== 'activa' || !(data.funciones_habilitadas || []).includes('notificaciones')) {
    throw httpError('Las notificaciones no están habilitadas para esta cadena', 403, 'ADMIN_PUSH_SCOPE_DENIED');
  }
}

async function exactPlayerProfile(supabase, segment) {
  const requestedUserId = String(segment?.userId || segment?.user_id || '').trim();
  const requestedEmail = String(segment?.email || '').trim().toLowerCase();
  if (!requestedUserId && !requestedEmail) {
    throw httpError('Indica el jugador destinatario', 400, 'ADMIN_PUSH_PLAYER_REQUIRED');
  }
  let query = supabase
    .from('jugadores_perfil')
    .select('user_id, email, pais, nombre, apellido, apodo, alias')
    .not('user_id', 'is', null);
  query = requestedUserId ? query.eq('user_id', requestedUserId) : query.ilike('email', requestedEmail);
  const { data, error } = await query.limit(2);
  if (error) throw error;
  const rows = Array.isArray(data) ? data : [];
  if (rows.length !== 1) {
    throw httpError(
      rows.length > 1 ? 'El destinatario no es unívoco' : 'Jugador no encontrado',
      rows.length > 1 ? 409 : 404,
      rows.length > 1 ? 'ADMIN_PUSH_PLAYER_AMBIGUOUS' : 'ADMIN_PUSH_PLAYER_NOT_FOUND',
    );
  }
  const player = rows[0];
  if (requestedEmail && String(player.email || '').trim().toLowerCase() !== requestedEmail) {
    throw httpError('Los datos del destinatario no coinciden', 400, 'ADMIN_PUSH_PLAYER_MISMATCH');
  }
  return player;
}

async function assertPlayerInsideScope({ supabase, scope, player, sedesPermitidasPorScopeFn }) {
  const role = effectiveAdminRole(scope);
  if (role === 'super_admin') return;
  if (role === 'admin_nacional' && hasCountrywideScope(scope)) {
    if (!geoMatches(scope?.pais || scope?.paisNorm, player?.pais)) {
      throw httpError('El jugador no pertenece a tu país', 403, 'ADMIN_PUSH_TARGET_OUT_OF_SCOPE');
    }
    return;
  }
  if (role === 'admin_club' || role === 'admin_cadena' || role === 'admin_nacional') {
    const sedeIds = await allowedSedeIds(scope, sedesPermitidasPorScopeFn);
    const scopedUsers = new Set();
    for (const sedeId of sedeIds) {
      const userIds = await userIdsFromSedeActivity(supabase, sedeId);
      userIds.forEach((userId) => scopedUsers.add(String(userId)));
    }
    if (!scopedUsers.has(String(player?.user_id))) {
      throw httpError('El jugador no pertenece a tu ámbito', 403, 'ADMIN_PUSH_TARGET_OUT_OF_SCOPE');
    }
    return;
  }
  throw httpError('No tienes permiso para ese destinatario', 403, 'ADMIN_PUSH_TARGET_OUT_OF_SCOPE');
}

export async function validateAdminPushSegment(scope, rawSegment, { supabase, sedesPermitidasPorScopeFn }) {
  const role = effectiveAdminRole(scope);
  if (!ADMIN_PUSH_ROLES.has(role)) {
    throw httpError('No tienes permiso para enviar notificaciones push', 403, 'ADMIN_PUSH_FORBIDDEN');
  }
  assertNationalTerritory(scope);
  await assertChainNotificationsEnabled(scope, supabase);

  const segment = parseAdminPushSegment(rawSegment);
  const type = String(segment?.type || '').trim().toLowerCase();
  if (!type) throw httpError('Segmento inválido', 400, 'ADMIN_PUSH_SEGMENT_INVALID');

  if (type === 'jugador') {
    const player = await exactPlayerProfile(supabase, segment);
    await assertPlayerInsideScope({ supabase, scope, player, sedesPermitidasPorScopeFn });
    return {
      type: 'jugador',
      userId: String(player.user_id),
      email: String(player.email || '').trim().toLowerCase() || null,
    };
  }

  if (role === 'super_admin') {
    if (type === 'todos_usuarios') return { type };
    if (type === 'pais') {
      const pais = String(segment.pais || '').trim();
      if (!pais) throw httpError('Selecciona un país', 400, 'ADMIN_PUSH_SEGMENT_INVALID');
      return { type, pais };
    }
    if (type === 'ciudad') {
      const ciudad = String(segment.ciudad || '').trim();
      const pais = String(segment.pais || '').trim();
      if (!ciudad) throw httpError('Selecciona una ciudad', 400, 'ADMIN_PUSH_SEGMENT_INVALID');
      return { type, ciudad, pais: pais || null };
    }
    if (type === 'sede') {
      const sedeId = Number(segment.sedeId ?? segment.sede_id);
      if (!Number.isInteger(sedeId) || sedeId <= 0) {
        throw httpError('Selecciona una sede', 400, 'ADMIN_PUSH_SEGMENT_INVALID');
      }
      return { type, sedeId };
    }
    if (type === 'deporte') {
      const deporte = String(segment.deporte || '').trim().toLowerCase();
      if (!deporte) throw httpError('Selecciona un deporte', 400, 'ADMIN_PUSH_SEGMENT_INVALID');
      return { type, deporte };
    }
  }

  if (role === 'admin_nacional') {
    if (type === 'todos_pais') {
      if (!hasCountrywideScope(scope)) {
        throw httpError('El país completo excede tu ámbito', 403, 'ADMIN_PUSH_TARGET_OUT_OF_SCOPE');
      }
      return { type, pais: scope.pais || scope.paisNorm };
    }
    if (type === 'sede') {
      const sedeId = Number(segment.sedeId ?? segment.sede_id);
      if (!Number.isInteger(sedeId) || sedeId <= 0) {
        throw httpError('Selecciona una sede', 400, 'ADMIN_PUSH_SEGMENT_INVALID');
      }
      const allowed = await allowedSedeIds(scope, sedesPermitidasPorScopeFn);
      if (!allowed.includes(sedeId)) {
        throw httpError('La sede no pertenece a tu país', 403, 'ADMIN_PUSH_TARGET_OUT_OF_SCOPE');
      }
      return { type, sedeId };
    }
    if (type === 'ciudad') {
      const ciudad = String(segment.ciudad || '').trim();
      if (!ciudad) throw httpError('Selecciona una ciudad', 400, 'ADMIN_PUSH_SEGMENT_INVALID');
      const allowed = await sedesPermitidasPorScopeFn(scope);
      const citySedes = (allowed?.sedes || []).filter((sede) => normalizeGeo(sede?.ciudad) === normalizeGeo(ciudad));
      if (!citySedes.length) {
        throw httpError('La ciudad no pertenece a tu país', 403, 'ADMIN_PUSH_TARGET_OUT_OF_SCOPE');
      }
      if (!hasCountrywideScope(scope)) {
        // Only server-resolved venue IDs may define a regional audience. Player
        // profiles do not provide an authoritative province/city assignment.
        const sedeIds = citySedes.map((sede) => Number(sede.id)).filter(Number.isFinite);
        return { type, ciudad, pais: scope.pais || scope.paisNorm, sedeIds };
      }
      return { type, ciudad, pais: scope.pais || scope.paisNorm };
    }
  }

  if (role === 'admin_cadena') {
    const sedeIds = await allowedSedeIds(scope, sedesPermitidasPorScopeFn);
    if (type === 'toda_cadena') return { type, sedeIds };
    if (type === 'sede') {
      const sedeId = Number(segment.sedeId ?? segment.sede_id);
      if (!Number.isInteger(sedeId) || sedeId <= 0) {
        throw httpError('Selecciona una sede', 400, 'ADMIN_PUSH_SEGMENT_INVALID');
      }
      if (!sedeIds.includes(sedeId)) {
        throw httpError('La sede no pertenece a tu organización', 403, 'ADMIN_PUSH_TARGET_OUT_OF_SCOPE');
      }
      return { type, sedeId };
    }
  }

  if (role === 'admin_club' && type === 'sede_mia') {
    if (scope.sedeId == null) throw httpError('Sin sede asignada', 403, 'ADMIN_PUSH_SCOPE_DENIED');
    return { type: 'sede', sedeId: Number(scope.sedeId) };
  }

  throw httpError('Segmento no permitido para tu rol', 403, 'ADMIN_PUSH_SEGMENT_FORBIDDEN');
}

function distinctUserIds(rows) {
  return [...new Set((rows || []).map((row) => String(row?.user_id || '').trim()).filter(Boolean))];
}

function profileMatchesDeporte(row, deporte) {
  const expected = String(deporte || '').trim().toLowerCase();
  let raw = row?.deportes_preferidos;
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw); } catch { raw = []; }
  }
  return Array.isArray(raw) && raw.some((item) => String(item || '').trim().toLowerCase() === expected);
}

export async function resolveAdminPushRecipientUserIds(supabase, scope, segment) {
  if (segment.type === 'jugador') return [String(segment.userId)];
  if (segment.type === 'todos_usuarios') {
    const rows = await fetchAllRows(() => (
      supabase.from('jugadores_perfil').select('user_id').not('user_id', 'is', null)
    ));
    return distinctUserIds(rows);
  }
  if (segment.type === 'todos_pais' || segment.type === 'pais') {
    const targetCountry = segment.pais || scope.pais;
    const rows = await fetchAllRows(() => (
      supabase.from('jugadores_perfil').select('user_id, pais').not('user_id', 'is', null)
    ));
    return distinctUserIds(rows.filter((row) => geoMatches(targetCountry, row.pais)));
  }
  if (segment.type === 'ciudad') {
    if (Array.isArray(segment.sedeIds)) {
      const ids = new Set();
      for (const sedeId of segment.sedeIds) {
        const users = await userIdsFromSedeActivity(supabase, sedeId);
        users.forEach((id) => ids.add(id));
      }
      return [...ids];
    }
    const rows = await fetchAllRows(() => (
      supabase.from('jugadores_perfil').select('user_id, ciudad, pais').not('user_id', 'is', null)
    ));
    return distinctUserIds(rows.filter((row) => (
      normalizeGeo(row.ciudad) === normalizeGeo(segment.ciudad) &&
      (!segment.pais || geoMatches(segment.pais, row.pais))
    )));
  }
  if (segment.type === 'sede') return userIdsFromSedeActivity(supabase, segment.sedeId);
  if (segment.type === 'toda_cadena') {
    const ids = new Set();
    for (const sedeId of segment.sedeIds || []) {
      const users = await userIdsFromSedeActivity(supabase, sedeId);
      users.forEach((id) => ids.add(id));
    }
    return [...ids];
  }
  if (segment.type === 'deporte') {
    const rows = await fetchAllRows(() => (
      supabase.from('jugadores_perfil').select('user_id, deportes_preferidos').not('user_id', 'is', null)
    ));
    return distinctUserIds(rows.filter((row) => profileMatchesDeporte(row, segment.deporte)));
  }
  return [];
}

export async function assertAdminPushRateLimit(supabase, scope, segment) {
  const role = effectiveAdminRole(scope);
  if (role === 'super_admin' && isAdminPushTargetedSegment(segment)) return;
  const limit = WEEKLY_LIMITS[role] ?? 0;
  const used = await countAdminPushSendsThisWeek(supabase, scope.authUserId, {
    onlyBroadcast: role === 'super_admin',
  });
  if (used >= limit) {
    const error = httpError('Alcanzaste el límite de envíos esta semana', 429, 'ADMIN_PUSH_QUOTA_EXCEEDED');
    error.quota = { limit, used, remaining: 0 };
    throw error;
  }
}

export async function searchAdminPushPlayers(supabase, scope, query, sedesPermitidasPorScopeFn) {
  const q = String(query || '').trim().toLowerCase();
  if (q.length < 2) return [];
  assertNationalTerritory(scope);
  await assertChainNotificationsEnabled(scope, supabase);
  let rows = await fetchAllRows(() => (
    supabase
      .from('jugadores_perfil')
      .select('user_id, nombre, apellido, apodo, alias, email, pais')
      .not('user_id', 'is', null)
  ));
  const role = effectiveAdminRole(scope);
  if (role === 'admin_nacional' && hasCountrywideScope(scope)) {
    rows = rows.filter((row) => geoMatches(scope.pais || scope.paisNorm, row.pais));
  } else if (role === 'admin_club' || role === 'admin_cadena' || role === 'admin_nacional') {
    const venueIds = await allowedSedeIds(scope, sedesPermitidasPorScopeFn);
    const scopedIds = new Set();
    for (const venueId of venueIds) {
      const userIds = await userIdsFromSedeActivity(supabase, venueId);
      userIds.forEach((id) => scopedIds.add(String(id)));
    }
    rows = rows.filter((row) => scopedIds.has(String(row.user_id)));
  }
  return rows
    .filter((row) => [row.nombre, row.apellido, row.apodo, row.alias, row.email].join(' ').toLowerCase().includes(q))
    .slice(0, 20);
}

export function buildAdminPushIdempotencyKey(adminUserId, suppliedKey) {
  const raw = String(suppliedKey || '').trim();
  const requestKey = ADMIN_IDEMPOTENCY_RE.test(raw) ? raw : randomUUID();
  return `admin:${String(adminUserId || '').trim()}:${requestKey}`.slice(0, 180);
}

export function registerAdminPushRoutes(app, deps) {
  const { supabase, pushService, authUserFromBearer, adminListScopeFromRequest, sedesPermitidasPorScope } = deps;

  async function pushScope(req) {
    const scope = await adminListScopeFromRequest(req);
    if (!scope) throw httpError('No autorizado', 401, 'AUTH_REQUIRED');
    if (!scope.authUserId) {
      const user = await authUserFromBearer(req);
      if (!user?.id) throw httpError('No autorizado', 401, 'AUTH_REQUIRED');
      scope.authUserId = user.id;
    }
    if (!ADMIN_PUSH_ROLES.has(effectiveAdminRole(scope))) {
      throw httpError('No tienes permiso', 403, 'ADMIN_PUSH_FORBIDDEN');
    }
    return scope;
  }

  function sendError(res, error, route) {
    console.error(`❌ ${route}:`, error?.message || error);
    return res.status(error?.status || 500).json({
      error: error?.message || 'Error de notificaciones push',
      code: error?.code || 'ADMIN_PUSH_ERROR',
      quota: error?.quota || undefined,
    });
  }

  app.get('/api/push/admin-quota', async (req, res) => {
    try {
      const scope = await pushScope(req);
      return res.json(await getAdminPushQuota(supabase, scope));
    } catch (error) {
      return sendError(res, error, 'GET /api/push/admin-quota');
    }
  });

  app.get('/api/push/admin-history', async (req, res) => {
    try {
      const scope = await pushScope(req);
      const { data, error } = await supabase
        .from('notificaciones_admin_log')
        .select('id, titulo, mensaje, segmento, cantidad_enviadas, estado, created_at')
        .eq('admin_user_id', scope.authUserId)
        .order('created_at', { ascending: false })
        .limit(20);
      if (error) throw error;
      return res.json(Array.isArray(data) ? data : []);
    } catch (error) {
      return sendError(res, error, 'GET /api/push/admin-history');
    }
  });

  app.post('/api/push/admin-segment-preview', async (req, res) => {
    try {
      const scope = await pushScope(req);
      const segment = await validateAdminPushSegment(scope, req.body?.segment, {
        supabase,
        sedesPermitidasPorScopeFn: sedesPermitidasPorScope,
      });
      const userIds = await resolveAdminPushRecipientUserIds(supabase, scope, segment);
      // El panel acepta texto libre: incluso un envío individual requiere opt-in
      // promocional. Los avisos operativos se generan sólo desde eventos tipados.
      const category = adminPushCategoryForSegment(segment);
      const tokenRows = await pushService.fetchEligibleTokens(userIds, category);
      return res.json({ recipients: userIds.length, withPushToken: tokenRows.length, category, segment });
    } catch (error) {
      return sendError(res, error, 'POST /api/push/admin-segment-preview');
    }
  });

  app.get('/api/push/admin-search-players', async (req, res) => {
    try {
      const scope = await pushScope(req);
      const rows = await searchAdminPushPlayers(supabase, scope, req.query?.q, sedesPermitidasPorScope);
      return res.json(rows.map((row) => ({
        userId: row.user_id,
        nombre: [row.nombre, row.apellido].filter(Boolean).join(' ').trim() || row.apodo || row.alias || 'Jugador',
        email: row.email || '',
        apodo: row.apodo || '',
      })));
    } catch (error) {
      return sendError(res, error, 'GET /api/push/admin-search-players');
    }
  });

  app.post('/api/push/send-admin', async (req, res) => {
    try {
      const scope = await pushScope(req);
      const title = String(req.body?.title || req.body?.titulo || '').trim().slice(0, 50);
      const body = String(req.body?.body || req.body?.mensaje || '').trim().slice(0, 150);
      if (!title || !body) throw httpError('Título y mensaje son obligatorios', 400, 'ADMIN_PUSH_CONTENT_INVALID');
      const segment = await validateAdminPushSegment(scope, req.body?.segment, {
        supabase,
        sedesPermitidasPorScopeFn: sedesPermitidasPorScope,
      });
      await assertAdminPushRateLimit(supabase, scope, segment);
      const userIds = await resolveAdminPushRecipientUserIds(supabase, scope, segment);
      if (!userIds.length) throw httpError('No hay destinatarios para este segmento', 400, 'ADMIN_PUSH_NO_RECIPIENTS');

      const category = adminPushCategoryForSegment(segment);
      const idempotencyKey = buildAdminPushIdempotencyKey(scope.authUserId, req.body?.idempotencyKey);
      const delivery = await pushService.dispatch({
        idempotencyKey,
        userIds,
        title,
        body,
        category,
        data: { type: 'admin_message', route: 'Notificaciones', params: {} },
        source: 'admin_panel',
        actorUserId: scope.authUserId,
      });

      const logPayload = {
        admin_user_id: scope.authUserId,
        titulo: title,
        mensaje: body,
        segmento: segment,
        cantidad_enviadas: delivery.accepted,
        estado: delivery.status,
        idempotency_key: idempotencyKey,
        push_job_id: delivery.jobId,
      };
      const { data: inserted, error: logError } = await supabase
        .from('notificaciones_admin_log')
        .upsert(logPayload, { onConflict: 'idempotency_key', ignoreDuplicates: true })
        .select('*')
        .maybeSingle();
      if (logError) throw logError;
      let logRow = inserted;
      if (!logRow) {
        const { data: existing, error: existingError } = await supabase
          .from('notificaciones_admin_log')
          .select('*')
          .eq('idempotency_key', idempotencyKey)
          .maybeSingle();
        if (existingError) throw existingError;
        logRow = existing;
      }

      const quota = await getAdminPushQuota(supabase, scope);
      return res.json({
        ok: true,
        duplicate: delivery.duplicate,
        log: logRow,
        recipients: userIds.length,
        cantidad_enviadas: delivery.accepted,
        estado: delivery.status,
        category,
        quota,
      });
    } catch (error) {
      return sendError(res, error, 'POST /api/push/send-admin');
    }
  });
}
