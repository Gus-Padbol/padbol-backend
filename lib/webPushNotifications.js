// Notificaciones web push para la PWA del CRM.
// La clave privada VAPID se lee del entorno del servidor y nunca se persiste ni se registra.
import webpush from 'web-push';

const MAX_ENDPOINT = 2000;

export function buildLeadNotification({ name, country, origin, caseUrl, kind = 'new' } = {}) {
  const who = String(name || 'un interesado').trim();
  const where = String(country || '').trim();
  const from = String(origin || 'consulta').trim();
  const url = String(caseUrl || '/admin/crm');
  if (kind === 'reminder') {
    return {
      title: 'RECORDATORIO URGENTE — LEAD PENDIENTE',
      body: `Nicolás, tenés pendiente la atención de ${who}${where ? `, de ${where}` : ''}. La consulta ingresó hace 24 horas y todavía no tiene atención registrada.`,
      url, tag: `lead-24h:${url}`,
    };
  }
  if (kind === 'critical') {
    return {
      title: 'ALERTA CRÍTICA — LEAD SIN ATENDER',
      body: `La consulta de ${who}${where ? `, de ${where}` : ''} lleva 48 horas sin atención registrada. Es necesario contactar al interesado o documentar la gestión.`,
      url, tag: `lead-48h:${url}`,
    };
  }
  return {
    title: 'NUEVO LEAD — PADBOL',
    body: `Ingresó una nueva consulta de ${who}${where ? `, de ${where}` : ''}. Origen: ${from}. Acción: ATENDER CONSULTA.`,
    url, tag: `lead-new:${url}`,
  };
}

// Envia con VAPID. Se construye solo si ambas claves existen en el entorno.
export function createVapidSender({ publicKey, privateKey, subject = 'mailto:soporte@padbol.com' } = {}) {
  if (!publicKey || !privateKey) return null;
  webpush.setVapidDetails(subject, publicKey, privateKey);
  return async ({ subscription, payload }) => {
    await webpush.sendNotification(
      { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
      JSON.stringify(payload),
      { TTL: 900, urgency: 'high' },
    );
  };
}

export function createWebPushService({ pool, send = null, logger = console, now = () => new Date() } = {}) {
  if (!pool?.query) throw new Error('WEB_PUSH_POOL_REQUIRED');

  async function subscribe({ userId, subscription, userAgent = null } = {}) {
    const endpoint = String(subscription?.endpoint || '').trim();
    const p256dh = String(subscription?.keys?.p256dh || '').trim();
    const auth = String(subscription?.keys?.auth || '').trim();
    if (!userId) throw Object.assign(new Error('USER_REQUIRED'), { status: 400 });
    if (!endpoint || endpoint.length > MAX_ENDPOINT || !/^https:\/\//.test(endpoint)) throw Object.assign(new Error('INVALID_ENDPOINT'), { status: 400 });
    if (!p256dh || !auth) throw Object.assign(new Error('INVALID_KEYS'), { status: 400 });
    const { rows } = await pool.query(
      `insert into public.push_web_subscriptions (user_id, endpoint, p256dh, auth, user_agent, last_seen_at)
       values ($1,$2,$3,$4,$5,$6)
       on conflict (endpoint) do update set user_id=excluded.user_id, p256dh=excluded.p256dh, auth=excluded.auth,
         user_agent=excluded.user_agent, last_seen_at=excluded.last_seen_at, revoked_at=null, failure_count=0
       returning id`,
      [userId, endpoint, p256dh, auth, userAgent ? String(userAgent).slice(0, 400) : null, now().toISOString()],
    );
    return { id: rows[0].id };
  }

  async function unsubscribe({ userId, endpoint } = {}) {
    const { rowCount } = await pool.query(
      'update public.push_web_subscriptions set revoked_at=now() where user_id=$1 and endpoint=$2 and revoked_at is null',
      [userId, String(endpoint || '')],
    );
    return { revoked: rowCount };
  }

  async function notify({ userId, payload } = {}) {
    if (typeof send !== 'function') return { sent: 0, skipped: 'NO_TRANSPORT' };
    const { rows } = await pool.query(
      'select id, endpoint, p256dh, auth from public.push_web_subscriptions where user_id=$1 and revoked_at is null',
      [userId],
    );
    let sent = 0;
    for (const row of rows) {
      try {
        await send({ subscription: row, payload });
        sent += 1;
      } catch (error) {
        const gone = [404, 410].includes(Number(error?.statusCode));
        await pool.query(
          gone
            ? 'update public.push_web_subscriptions set revoked_at=now() where id=$1'
            : 'update public.push_web_subscriptions set failure_count=failure_count+1 where id=$1',
          [row.id],
        );
        logger.warn?.('push web fallido', row.id, error?.message || error);
      }
    }
    return { sent, total: rows.length };
  }

  return { subscribe, unsubscribe, notify };
}
