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
    // Recupera claims colgados por caida del proceso (no toca ambiguos ni enviados).
    await pool.query(`update public.crm_lead_alert_deliveries set state='failed', error_code='STALE_CLAIM'
      where state='claimed' and claimed_at < now() - interval '5 minutes'`);

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
          // Recibo durable con estado explicito: claimed -> sent|failed|ambiguous|no_subscription.
          const claim = await pool.query(
            `insert into public.crm_lead_alert_deliveries (alert_id, stage, recipient_id)
             values ($1,$2,$3)
             on conflict (alert_id, stage, recipient_id) do update
               set state='claimed', claimed_at=now(), attempts=crm_lead_alert_deliveries.attempts+1
               where crm_lead_alert_deliveries.state='failed'
             returning alert_id`,
            [row.id, row.state, userId],
          );
          if (!claim.rowCount) continue;
          let result;
          try {
            result = await webPush.notify({ userId, payload });
          } catch (error) {
            const code = String(error?.code || error?.name || '');
            const ambiguous = error?.ambiguous === true || ['ETIMEDOUT','ECONNRESET','EAI_AGAIN','UND_ERR_CONNECT_TIMEOUT'].includes(code) || Number(error?.status) >= 500;
            // Ambiguo: NO se borra el recibo (evita duplicar); queda para revision manual.
            // Fallo determinista previo al proveedor: se marca failed para reintento del proximo ciclo.
            await pool.query(
              'update public.crm_lead_alert_deliveries set state=$4, error_code=$5, attempts=attempts+1 where alert_id=$1 and stage=$2 and recipient_id=$3',
              [row.id, row.state, userId, ambiguous ? 'ambiguous' : 'failed', code || 'SEND_FAILED']);
            throw error;
          }
          const delivered = Number(result?.sent || 0);
          if (!delivered) {
            // El proveedor no envio a ningun dispositivo: NO es exito.
            await pool.query(
              `update public.crm_lead_alert_deliveries set state='no_subscription', error_code='NO_SUBSCRIPTION', attempts=attempts+1
                where alert_id=$1 and stage=$2 and recipient_id=$3`,
              [row.id, row.state, userId]);
            continue;
          }
          const marked = await pool.query(
            `update public.crm_lead_alert_deliveries set state='sent', sent_at=now()
              where alert_id=$1 and stage=$2 and recipient_id=$3 and state='claimed'`,
            [row.id, row.state, userId]);
          if (!marked.rowCount) throw new Error('DELIVERY_MARK_FAILED');
          sent += delivered;
        }
      } catch (error) {
        logger.warn?.('no se pudo notificar la alerta', row.id, error?.message || error);
      }
    }
    return { ...result, notifications: sent };
  };
}
