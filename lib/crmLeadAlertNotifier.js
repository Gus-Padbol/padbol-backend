// Une el motor de alertas con las notificaciones web push.
import {buildLeadNotification} from './webPushNotifications.js';

export function caseUrl(caseType, caseId) {
  return `/admin/crm/${caseType === 'form' ? 'formulario' : 'whatsapp'}/${caseId}`;
}
export function payloadFor({ state, nombre, pais, caseType, caseId }) {
  const kind = state === 'escalada' ? 'critical' : state === 'recordatorio' ? 'reminder' : 'new';
  return buildLeadNotification({ name: nombre, country: pais, origin: caseType === 'form' ? 'formulario web' : 'WhatsApp', caseUrl: caseUrl(caseType, caseId), kind });
}
const definitive = (error) => error?.definitive === true || (Number(error?.status) >= 400 && Number(error?.status) < 500 && ![408, 425, 429].includes(Number(error?.status)));

export function createLeadAlertNotifier({ pool, alerts, webPush, managerId = null, logger = console, now = () => new Date() }) {
  return async function run() {
    const result = await alerts.sweep();
    const at = typeof result?.at === 'string' && !Number.isNaN(Date.parse(result.at)) ? result.at : null;
    if (!at) throw new Error('CRM_SWEEP_CYCLE_REQUIRED');
    // Claims colgados: pudo haberse enviado antes de caer => ambiguo/manual, NUNCA reenvio automatico.
    await pool.query(`update public.crm_lead_alert_deliveries set state='ambiguous', error_code='STALE_CLAIM'
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
        where a.resolved_at is null and a.updated_at = $1`, [at]);
    // Reintentos durables independientes del reloj: entregas failed con la alerta aun vigente.
    const retries = await pool.query(
      `select a.id, a.case_type, a.case_id, a.state, c.nombre, c.pais, d.recipient_id, d.stage
         from public.crm_lead_alert_deliveries d
         join public.crm_lead_alerts a on a.id = d.alert_id and a.resolved_at is null
         left join public.crm_commercial_cases cc on a.case_type='whatsapp' and cc.id = a.case_id
         left join public.crm_conversations conv on conv.id = cc.conversation_id
         left join public.crm_contacts c on c.id = conv.contact_id
        where d.state='failed' limit 100`);

    let sent = 0;
    async function deliver({ row, userId, stage, retry }) {
      const payload = payloadFor({...row, caseType: row.caseType ?? row.case_type, caseId: row.caseId ?? row.case_id});
      if (!retry) {
        const claim = await pool.query(
          `insert into public.crm_lead_alert_deliveries (alert_id, stage, recipient_id)
           values ($1,$2,$3) on conflict do nothing returning alert_id`,
          [row.id, stage, userId]);
        if (!claim.rowCount) return 0;
      }
      let out;
      try { out = await webPush.notify({ userId, payload }); }
      catch (error) {
        const code = String(error?.code || error?.name || '');
        const state = definitive(error) ? 'failed' : 'ambiguous';
        await pool.query('update public.crm_lead_alert_deliveries set state=$4, error_code=$5, attempts=attempts+1 where alert_id=$1 and stage=$2 and recipient_id=$3',
          [row.id, stage, userId, state, code || 'SEND_FAILED']);
        return 0;
      }
      // Resultado del adaptador: solo es exito si acredita destinatarios entregados.
      const delivered = Number(out?.delivered ?? out?.sent ?? 0);
      if (!delivered) {
        await pool.query(`update public.crm_lead_alert_deliveries set state='unconfirmed', error_code='NO_DELIVERY_EVIDENCE', attempts=attempts+1
          where alert_id=$1 and stage=$2 and recipient_id=$3`, [row.id, stage, userId]);
        return 0;
      }
      const marked = await pool.query(`update public.crm_lead_alert_deliveries set state='sent', sent_at=now()
        where alert_id=$1 and stage=$2 and recipient_id=$3`, [row.id, stage, userId]);
      if (!marked.rowCount) { logger.warn?.('no se pudo marcar sent', row.id); return 0; }
      return delivered;
    }
    for (const row of rows) {
      const target = row.state === 'escalada' && managerId && managerId !== row.advisor_id ? [row.advisor_id, managerId] : [row.advisor_id];
      for (const userId of new Set(target.filter(Boolean))) {
        try { sent += await deliver({ row, userId, stage: row.state, retry: false }); }
        catch (error) { logger.warn?.('no se pudo notificar la alerta', row.id, error?.message || error); }
      }
    }
    for (const r of retries.rows) {
      try { sent += await deliver({ row: r, userId: r.recipient_id, stage: r.stage, retry: true }); }
      catch (error) { logger.warn?.('no se pudo reintentar la alerta', r.id, error?.message || error); }
    }
    return { ...result, notifications: sent };
  };
}
