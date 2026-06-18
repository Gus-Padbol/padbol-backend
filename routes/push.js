import express from 'express';
import { pushSendRateLimit, pushTokensRateLimit } from '../lib/rateLimit.js';
import { requireAdminOrInternalSecret } from '../lib/authAccess.js';
import { sendPushToTokens } from '../utils/push.js';

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

  app.use('/api', router);
}
