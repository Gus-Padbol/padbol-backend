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
    // Dependencia por RETORNO local: el sweep devuelve la marca de SU ciclo.
    // Sin marca valida no se consulta ni notifica (fail-closed), para no perder eventos.
    const result = await alerts.sweep();
    const at = typeof result?.at === 'string' && !Number.isNaN(Date.parse(result.at)) ? result.at : null;
    if (!at) throw new Error('CRM_SWEEP_CYCLE_REQUIRED');
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
      const payload = payloadFor({...row, caseType: row.caseType ?? row.case_type, caseId: row.caseId ?? row.case_id});
      try {
        const target = row.state === 'escalada' && managerId && managerId !== row.advisor_id ? [row.advisor_id, managerId] : [row.advisor_id];
        for (const userId of new Set(target.filter(Boolean))) {
          // Recibo durable: una sola entrega por alerta+etapa+destinatario.
          const claim = await pool.query(
            `insert into public.crm_lead_alert_deliveries (alert_id, stage, recipient_id)
             values ($1,$2,$3) on conflict do nothing returning alert_id`,
            [row.id, row.state, userId],
          );
          if (!claim.rowCount) continue;
          try {
            const result = await webPush.notify({ userId, payload });
            sent += result.sent || 0;
            await pool.query('update public.crm_lead_alert_deliveries set sent_at=now() where alert_id=$1 and stage=$2 and recipient_id=$3', [row.id, row.state, userId]);
          } catch (error) {
            // Si el envio falla, se libera el recibo para permitir reintento acotado.
            await pool.query('delete from public.crm_lead_alert_deliveries where alert_id=$1 and stage=$2 and recipient_id=$3', [row.id, row.state, userId]);
            throw error;
          }
        }
      } catch (error) {
        logger.warn?.('no se pudo notificar la alerta', row.id, error?.message || error);
      }
    }
    return { ...result, notifications: sent };
  };
}
