// Une el motor de alertas con las notificaciones web push.
// No duplica reglas: el barrido decide el estado y aca solo se avisa.
import {buildLeadNotification} from './webPushNotifications.js';

export function caseUrl(caseType, caseId) {
  return `/admin/crm/${caseType === 'form' ? 'formulario' : 'whatsapp'}/${caseId}`;
}

export function payloadFor({ state, nombre, pais, caseType, caseId }) {
  const kind = state === 'escalada' ? 'critical' : state === 'recordatorio' ? 'reminder' : 'new';
  return buildLeadNotification({ name: nombre, country: pais, origin: caseType === 'form' ? 'formulario web' : 'WhatsApp', caseUrl: caseUrl(caseType, caseId), kind });
}

export function createLeadAlertNotifier({ pool, alerts, webPush, managerId = null, logger = console, now = () => new Date() }) {
  return async function run() {
    const at = now().toISOString();
    const result = await alerts.sweep();
    const { rows } = await pool.query(
      `select a.id, a.case_type, a.case_id, a.advisor_id, a.state, c.nombre, c.pais
         from public.crm_lead_alerts a
         left join lateral (
           select ct.nombre, nullif(conv.qualification_data->>'pais','') as pais
             from public.crm_commercial_cases cc
             join public.crm_conversations conv on conv.id = cc.conversation_id
             join public.crm_contacts ct on ct.id = conv.contact_id
            where a.case_type='whatsapp' and cc.id = a.case_id
           union all
           select ct.nombre, nullif(conv.qualification_data->>'pais','') as pais
             from public.crm_commercial_form_cases fc
             join public.crm_conversations conv on conv.id = fc.conversation_id
             join public.crm_contacts ct on ct.id = conv.contact_id
            where a.case_type='form' and fc.conversation_id = a.case_id
         ) c on true
        where a.resolved_at is null and a.updated_at = $1`,
      [at],
    );
    let sent = 0;
    for (const row of rows) {
      const payload = payloadFor(row);
      try {
        const target = row.state === 'escalada' && managerId && managerId !== row.advisor_id ? [row.advisor_id, managerId] : [row.advisor_id];
        for (const userId of new Set(target.filter(Boolean))) {
          const result = await webPush.notify({ userId, payload });
          sent += result.sent || 0;
        }
      } catch (error) {
        logger.warn?.('no se pudo notificar la alerta', row.id, error?.message || error);
      }
    }
    return { ...result, notifications: sent };
  };
}
