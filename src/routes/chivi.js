import express from 'express';
import { sendChiviChatMessage } from '../services/chiviChat.js';

export function createChiviRouter({ getAuthenticatedUser }) {
  const router = express.Router();

  router.post('/chat', async (req, res) => {
    try {
      const { user, status, error: authError } = await getAuthenticatedUser(req);
      if (!user) {
        return res.status(status ?? 401).json({ error: authError ?? 'No autorizado' });
      }

      const { message, context } = req.body ?? {};
      const trimmedMessage = String(message ?? '').trim();
      if (!trimmedMessage) {
        return res.status(400).json({ error: 'message es requerido' });
      }

      const reply = await sendChiviChatMessage({
        message: trimmedMessage,
        userId: user.id,
        context: context && typeof context === 'object' ? context : {},
      });

      return res.json({ reply });
    } catch (err) {
      console.error('❌ Error POST /api/chivi/chat:', err.message);
      return res.status(500).json({ error: 'No pudimos procesar tu consulta' });
    }
  });

  return router;
}

export default createChiviRouter;
