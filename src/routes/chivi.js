import express from 'express';
import { sendChiviChatMessage } from '../services/chiviChat.js';

export function createChiviRouter({ getAuthenticatedUser }) {
  const router = express.Router();

  // Canal público para padbol.com: no usa sesión de Padbol Match, pero conserva
  // límites de tasa en el montaje del router y sólo entrega orientación general.
  router.post('/public-chat', async (req, res) => {
    try {
      const { mensaje, historial, locale, client_surface } = req.body ?? {};
      const message = String(mensaje ?? '').trim();
      if (!message) return res.status(400).json({ error: 'mensaje es requerido' });

      const history = Array.isArray(historial)
        ? historial.slice(-8).map((item) => ({
          role: item?.role === 'assistant' ? 'assistant' : 'user',
          content: String(item?.content ?? '').trim().slice(0, 800),
        })).filter((item) => item.content)
        : [];
      const reply = await sendChiviChatMessage({
        message,
        userId: 'padbol-public-web',
        context: { locale: String(locale ?? 'es'), client_surface: String(client_surface ?? 'public_web'), historial: history },
      });

      const commercialIntent = /(cancha|comprar|instalar|sede|punto padbol|franquicia|inver[st]|representar|licencia)/i.test(message);
      return res.json({ respuesta: reply, whatsapp_escalada: commercialIntent });
    } catch (err) {
      console.error('❌ Error POST /api/chivi/public-chat:', err.message);
      return res.status(500).json({ error: 'Chivi no pudo responder ahora.' });
    }
  });

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
