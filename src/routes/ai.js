import express from 'express';
import { buildAiChatErrorResponse, processAiChatRequest } from '../ai/gateway/chatGateway.js';
import { getAiProvider } from '../ai/providers/index.js';

export function createAiRouter({ getAuthenticatedUser, pgPool, provider = getAiProvider() }) {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const result = await processAiChatRequest({
        user,
        body: req.body ?? {},
        pgPool,
        provider,
      });

      return res.json({
        ok: true,
        reply: result.reply,
        skill: result.skill,
        prompt_version: result.prompt_version,
        provider: result.provider,
      });
    } catch (err) {
      const { status, body } = buildAiChatErrorResponse(err);
      return res.status(status).json(body);
    }
  });

  return router;
}

export default createAiRouter;
