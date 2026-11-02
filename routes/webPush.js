// Endpoints de suscripcion a notificaciones web del CRM.
// La clave publica VAPID se entrega al navegador; la privada nunca sale del servidor.
import {buildLeadNotification} from '../lib/webPushNotifications.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function mountWebPushRoutes(app, { authUserFromBearer, webPush, publicKey = null, enabled = true }) {
  if (!enabled || !webPush) return { enabled: false };

  const authenticated = async (req, res) => {
    const user = await authUserFromBearer(req);
    if (!user?.id || !UUID.test(String(user.id))) {
      res.status(401).json({ error: 'No autorizado' });
      return null;
    }
    return user;
  };

  // Configuracion publica: el navegador necesita esta clave para suscribirse.
  app.get('/api/crm/push/config', async (req, res) => {
    res.json({ enabled: Boolean(publicKey), publicKey: publicKey || null });
  });

  app.post('/api/crm/push/subscribe', async (req, res) => {
    const user = await authenticated(req, res);
    if (!user) return;
    try {
      const result = await webPush.subscribe({
        userId: user.id,
        subscription: req.body?.subscription,
        userAgent: req.headers?.['user-agent'] || null,
      });
      res.json({ ok: true, id: result.id });
    } catch (error) {
      res.status(error.status || 400).json({ error: error.message || 'SUSCRIPCION_INVALIDA', code: error.message });
    }
  });

  app.post('/api/crm/push/unsubscribe', async (req, res) => {
    const user = await authenticated(req, res);
    if (!user) return;
    const result = await webPush.unsubscribe({ userId: user.id, endpoint: req.body?.endpoint });
    res.json({ ok: true, ...result });
  });

  // Notificacion de prueba al propio dispositivo. No envia nada comercial.
  app.post('/api/crm/push/test', async (req, res) => {
    const user = await authenticated(req, res);
    if (!user) return;
    const payload = buildLeadNotification({
      name: req.body?.name || 'Prueba de notificacion',
      country: req.body?.country || 'Argentina',
      origin: 'prueba del sistema',
      caseUrl: req.body?.url || '/admin/crm',
      kind: 'new',
    });
    const result = await webPush.notify({ userId: user.id, payload });
    res.json({ ok: result.sent > 0, ...result });
  });

  return { enabled: true };
}
