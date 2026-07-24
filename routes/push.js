import express from 'express';
import { pushSendRateLimit, pushTokensRateLimit } from '../lib/rateLimit.js';
import { requireAdminOrInternalSecret } from '../lib/authAccess.js';
import { sendPushToTokens } from '../utils/push.js';

const ADMIN_PUSH_ROLES = new Set(['super_admin', 'admin_nacional', 'admin_club']);
const ADMIN_PUSH_WEEKLY_QUOTA = Math.max(1, Number.parseInt(process.env.ADMIN_PUSH_WEEKLY_QUOTA || '10', 10) || 10);
const ADMIN_PUSH_HISTORY_TABLE = 'admin_push_notifications';

function startOfCurrentWeekIso(now = new Date()) {
  const date = new Date(now);
  const day = date.getUTCDay();
  const delta = day === 0 ? 6 : day - 1;
  date.setUTCDate(date.getUTCDate() - delta);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

function normalizeAdminPushSegment(raw = {}) {
  const type = String(raw?.type || '').trim().toLowerCase();
  if (!type) return null;
  return {
    type,
    pais: String(raw?.pais || '').trim() || null,
    sedeId: raw?.sedeId ?? raw?.sede_id ?? null,
    deporte: String(raw?.deporte || '').trim().toLowerCase() || null,
    userId: String(raw?.userId ?? raw?.user_id ?? '').trim() || null,
    email: String(raw?.email || '').trim().toLowerCase() || null,
  };
}

function isMissingAdminPushTable(error) {
  return error?.code === '42P01'
    || String(error?.message || '').toLowerCase().includes(ADMIN_PUSH_HISTORY_TABLE);
}

async function requirePushAdmin(req, res, {
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const { user, status, error: authError } = await getAuthenticatedUser(req);
  if (!user) {
    res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
    return null;
  }
  const email = String(user.email || '').trim().toLowerCase();
  const row = await fetchUserRoleRowForAuthUser(user);
  const role = String(row?.role || row?.rol || '').trim().toLowerCase()
    || (legacySuperAdminEmails.includes(email) ? 'super_admin' : '');
  if (!ADMIN_PUSH_ROLES.has(role)) {
    res.status(403).json({ error: 'No tenés permiso para enviar notificaciones' });
    return null;
  }
  return {
    user,
    role,
    sedeId: row?.sede_id != null && Number.isFinite(Number(row.sede_id)) ? Number(row.sede_id) : null,
    pais: String(row?.pais || '').trim() || null,
  };
}

function assertSegmentAllowed(auth, segment) {
  if (!segment) return 'Segmento inválido';
  if (auth.role === 'super_admin') {
    if (['todos_usuarios', 'pais', 'sede', 'deporte', 'jugador'].includes(segment.type)) return null;
  }
  if (auth.role === 'admin_nacional') {
    if (['todos_pais', 'sede', 'jugador'].includes(segment.type)) return null;
  }
  if (auth.role === 'admin_club') {
    if (['sede_mia', 'jugador'].includes(segment.type)) return null;
  }
  return 'El segmento no corresponde al alcance del administrador';
}

async function fetchProfilesForSegment(supabaseAdmin, auth, segment) {
  let query = supabaseAdmin
    .from('jugadores_perfil')
    .select('user_id, email, nombre, apellido, apodo, pais, sede_id, deportes')
    .not('user_id', 'is', null)
    .limit(10000);

  if (segment.type === 'jugador') {
    if (segment.userId) query = query.eq('user_id', segment.userId);
    else if (segment.email) query = query.eq('email', segment.email);
    else return [];
  } else if (segment.type === 'pais') {
    if (!segment.pais) return [];
    query = query.eq('pais', segment.pais);
  } else if (segment.type === 'todos_pais') {
    if (!auth.pais) return [];
    query = query.eq('pais', auth.pais);
  } else if (segment.type === 'sede') {
    const sedeId = Number(segment.sedeId);
    if (!Number.isFinite(sedeId)) return [];
    query = query.eq('sede_id', sedeId);
  } else if (segment.type === 'sede_mia') {
    if (auth.sedeId == null) return [];
    query = query.eq('sede_id', auth.sedeId);
  }

  const { data, error } = await query;
  if (error) throw error;
  let profiles = data || [];

  if (segment.type === 'deporte') {
    const sport = String(segment.deporte || '').toLowerCase();
    profiles = profiles.filter((row) => {
      const values = Array.isArray(row?.deportes) ? row.deportes : [];
      return values.some((value) => String(value || '').trim().toLowerCase() === sport);
    });
  }
  if (auth.role === 'admin_club') {
    profiles = profiles.filter((row) => Number(row?.sede_id) === auth.sedeId);
  } else if (auth.role === 'admin_nacional') {
    profiles = profiles.filter((row) => String(row?.pais || '').trim() === auth.pais);
  }
  return profiles;
}

async function fetchTokensForProfiles(supabaseAdmin, profiles) {
  const userIds = [...new Set((profiles || []).map((row) => row?.user_id).filter(Boolean))];
  if (!userIds.length) return [];
  const tokens = new Set();
  const { data: tokenRows, error: tokenError } = await supabaseAdmin
    .from('push_tokens')
    .select('user_id, token')
    .in('user_id', userIds);
  if (!tokenError) {
    for (const row of tokenRows || []) {
      if (String(row?.token || '').startsWith('ExponentPushToken[')) tokens.add(row.token);
    }
  }
  const { data: legacyRows } = await supabaseAdmin
    .from('jugadores_perfil')
    .select('user_id, push_token, expo_push_token')
    .in('user_id', userIds);
  for (const row of legacyRows || []) {
    const token = row?.push_token || row?.expo_push_token;
    if (String(token || '').startsWith('ExponentPushToken[')) tokens.add(token);
  }
  return [...tokens];
}

async function readAdminPushQuota(supabaseAdmin, auth) {
  const targetedUnlimited = auth.role === 'super_admin';
  let query = supabaseAdmin
    .from(ADMIN_PUSH_HISTORY_TABLE)
    .select('id', { count: 'exact', head: true })
    .eq('admin_user_id', auth.user.id)
    .gte('created_at', startOfCurrentWeekIso());
  if (targetedUnlimited) query = query.neq('segment_type', 'jugador');
  const { count, error } = await query;
  if (error) throw error;
  const used = Math.max(0, Number(count) || 0);
  return {
    limit: ADMIN_PUSH_WEEKLY_QUOTA,
    used,
    remaining: Math.max(0, ADMIN_PUSH_WEEKLY_QUOTA - used),
    unlimitedTargeted: targetedUnlimited,
  };
}

export {
  assertSegmentAllowed,
  normalizeAdminPushSegment,
  startOfCurrentWeekIso,
};

export function mountPushRoutes(app, {
  supabaseAdmin,
  getAuthenticatedUser,
  fetchUserRoleRowForAuthUser,
  legacySuperAdminEmails = [],
}) {
  const router = express.Router();

  router.post('/push-tokens', pushTokensRateLimit, async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const token = req.body?.token ?? req.body?.push_token ?? req.body?.expo_push_token ?? null;
      const platform = req.body?.platform ?? null;

      if (!token || !String(token).startsWith('ExponentPushToken[')) {
        return res.status(400).json({ error: 'token Expo válido es requerido' });
      }

      const row = {
        user_id: user.id,
        token: String(token),
        platform: platform ? String(platform) : null,
        created_at: new Date().toISOString(),
      };

      const { error } = await supabaseAdmin
        .from('push_tokens')
        .upsert(row, { onConflict: 'user_id,platform' });

      if (error) {
        const { error: legacyErr } = await supabaseAdmin
          .from('jugadores_perfil')
          .update({ push_token: row.token, expo_push_token: row.token })
          .eq('user_id', user.id);

        if (legacyErr) throw error;
      } else {
        await supabaseAdmin
          .from('jugadores_perfil')
          .update({ push_token: row.token, expo_push_token: row.token })
          .eq('user_id', user.id);
      }

      console.log(`✓ POST /api/push-tokens — ${user.id} (${platform ?? 'unknown'})`);
      res.json({ ok: true });
    } catch (err) {
      console.error('❌ POST /api/push-tokens:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  router.post('/push/send', pushSendRateLimit, async (req, res) => {
    try {
      const auth = await requireAdminOrInternalSecret(req, res, {
        getAuthenticatedUser,
        fetchUserRoleRowForAuthUser,
        legacySuperAdminEmails,
      });
      if (!auth) return;

      const { tokens, title, body, data } = req.body ?? {};
      const tokenList = Array.isArray(tokens) ? tokens : tokens ? [tokens] : [];

      if (!tokenList.length || !title || !body) {
        return res.status(400).json({ error: 'tokens, title y body son requeridos' });
      }

      const result = await sendPushToTokens(tokenList, title, body, data ?? {});
      res.json({ ok: true, ...result });
    } catch (err) {
      console.error('❌ POST /api/push/send:', err.message);
      res.status(500).json({ error: err.message });
    }
  });

  const adminDeps = {
    getAuthenticatedUser,
    fetchUserRoleRowForAuthUser,
    legacySuperAdminEmails,
  };

  router.get('/push/admin-quota', async (req, res) => {
    try {
      const auth = await requirePushAdmin(req, res, adminDeps);
      if (!auth) return;
      return res.json(await readAdminPushQuota(supabaseAdmin, auth));
    } catch (error) {
      if (isMissingAdminPushTable(error)) {
        return res.status(503).json({
          error: 'El módulo de notificaciones todavía no está configurado',
          code: 'ADMIN_PUSH_NOT_CONFIGURED',
        });
      }
      console.error('❌ GET /api/push/admin-quota:', error.message);
      return res.status(500).json({ error: 'No se pudo cargar el cupo de notificaciones' });
    }
  });

  router.get('/push/admin-history', async (req, res) => {
    try {
      const auth = await requirePushAdmin(req, res, adminDeps);
      if (!auth) return;
      let query = supabaseAdmin
        .from(ADMIN_PUSH_HISTORY_TABLE)
        .select('id, title, body, segment, segment_type, recipients, sent_count, status, created_at')
        .order('created_at', { ascending: false })
        .limit(50);
      if (auth.role !== 'super_admin') query = query.eq('admin_user_id', auth.user.id);
      const { data, error } = await query;
      if (error) throw error;
      return res.json((data || []).map((row) => ({
        id: row.id,
        titulo: row.title,
        cuerpo: row.body,
        segmento: row.segment,
        cantidad_enviadas: row.sent_count,
        destinatarios: row.recipients,
        estado: row.status,
        created_at: row.created_at,
      })));
    } catch (error) {
      if (isMissingAdminPushTable(error)) {
        return res.status(503).json({
          error: 'El módulo de notificaciones todavía no está configurado',
          code: 'ADMIN_PUSH_NOT_CONFIGURED',
        });
      }
      console.error('❌ GET /api/push/admin-history:', error.message);
      return res.status(500).json({ error: 'No se pudo cargar el historial de notificaciones' });
    }
  });

  router.post('/push/admin-segment-preview', async (req, res) => {
    try {
      const auth = await requirePushAdmin(req, res, adminDeps);
      if (!auth) return;
      const segment = normalizeAdminPushSegment(req.body?.segment);
      const segmentError = assertSegmentAllowed(auth, segment);
      if (segmentError) return res.status(400).json({ error: segmentError });
      const profiles = await fetchProfilesForSegment(supabaseAdmin, auth, segment);
      const tokens = await fetchTokensForProfiles(supabaseAdmin, profiles);
      return res.json({ recipients: profiles.length, withPushToken: tokens.length });
    } catch (error) {
      console.error('❌ POST /api/push/admin-segment-preview:', error.message);
      return res.status(500).json({ error: 'No se pudo calcular la audiencia' });
    }
  });

  router.get('/push/admin-search-players', async (req, res) => {
    try {
      const auth = await requirePushAdmin(req, res, adminDeps);
      if (!auth) return;
      const needle = String(req.query.q || '').trim().toLowerCase().slice(0, 80);
      if (needle.length < 2) return res.json([]);
      let query = supabaseAdmin
        .from('jugadores_perfil')
        .select('user_id, email, nombre, apellido, apodo, pais, sede_id')
        .not('user_id', 'is', null)
        .limit(300);
      if (auth.role === 'admin_club') query = query.eq('sede_id', auth.sedeId);
      if (auth.role === 'admin_nacional' && auth.pais) query = query.eq('pais', auth.pais);
      const { data, error } = await query;
      if (error) throw error;
      const matches = (data || [])
        .filter((row) => [row.nombre, row.apellido, row.apodo, row.email]
          .some((value) => String(value || '').toLowerCase().includes(needle)))
        .slice(0, 20)
        .map((row) => ({
          userId: row.user_id,
          email: row.email || null,
          nombre: [row.nombre, row.apellido].filter(Boolean).join(' ').trim() || row.apodo || row.email || 'Jugador',
          pais: row.pais || null,
          sedeId: row.sede_id ?? null,
        }));
      return res.json(matches);
    } catch (error) {
      console.error('❌ GET /api/push/admin-search-players:', error.message);
      return res.status(500).json({ error: 'No se pudieron buscar jugadores' });
    }
  });

  router.post('/push/send-admin', pushSendRateLimit, async (req, res) => {
    try {
      const auth = await requirePushAdmin(req, res, adminDeps);
      if (!auth) return;
      const title = String(req.body?.title || '').trim().slice(0, 50);
      const body = String(req.body?.body || '').trim().slice(0, 150);
      const segment = normalizeAdminPushSegment(req.body?.segment);
      const segmentError = assertSegmentAllowed(auth, segment);
      if (segmentError) return res.status(400).json({ error: segmentError });
      if (!title || !body) return res.status(400).json({ error: 'Título y mensaje son obligatorios' });

      const quota = await readAdminPushQuota(supabaseAdmin, auth);
      const consumesQuota = !(segment.type === 'jugador' && quota.unlimitedTargeted);
      if (consumesQuota && quota.remaining <= 0) {
        return res.status(429).json({ error: 'Se alcanzó el cupo semanal de notificaciones', quota });
      }

      const profiles = await fetchProfilesForSegment(supabaseAdmin, auth, segment);
      const tokens = await fetchTokensForProfiles(supabaseAdmin, profiles);
      const result = await sendPushToTokens(tokens, title, body, {
        type: 'admin_broadcast',
        segment: segment.type,
      });
      const sentCount = tokens.length;
      const { error: historyError } = await supabaseAdmin
        .from(ADMIN_PUSH_HISTORY_TABLE)
        .insert({
          admin_user_id: auth.user.id,
          admin_email: String(auth.user.email || '').trim().toLowerCase() || null,
          admin_role: auth.role,
          segment,
          segment_type: segment.type,
          title,
          body,
          recipients: profiles.length,
          sent_count: sentCount,
          status: result?.ok ? 'sent' : 'failed',
        });
      if (historyError) throw historyError;
      const nextQuota = consumesQuota
        ? { ...quota, used: quota.used + 1, remaining: Math.max(0, quota.remaining - 1) }
        : quota;
      return res.json({ ok: true, cantidad_enviadas: sentCount, recipients: profiles.length, quota: nextQuota });
    } catch (error) {
      if (isMissingAdminPushTable(error)) {
        return res.status(503).json({
          error: 'El módulo de notificaciones todavía no está configurado',
          code: 'ADMIN_PUSH_NOT_CONFIGURED',
        });
      }
      console.error('❌ POST /api/push/send-admin:', error.message);
      return res.status(500).json({ error: 'No se pudo enviar la notificación' });
    }
  });

  app.use('/api', router);
}
