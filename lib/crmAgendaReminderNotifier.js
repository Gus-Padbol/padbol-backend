// Avisos internos de Agenda: in-app durable y push best-effort. Sin envíos retroactivos.
import {claimAndDeliver, recoverStaleClaims} from './crmLeadDelivery.js';

export function createAgendaReminderNotifier({ pool, webPush, now = () => new Date(), logger = console }) {
  return async function run() {
    const at = now().toISOString();
    const canInApp = Boolean((await pool.query("select to_regclass('public.crm_agenda_notifications') t")).rows[0]?.t);
    await pool.query('select public.crm_agenda_reminders_reconcile()');
    await pool.query('select public.crm_agenda_reminders_sweep($1)', [at]);
    await recoverStaleClaims(pool);
    if (canInApp) {
      await pool.query(`update public.crm_agenda_notifications n set active=false where n.active and not exists(select 1 from public.crm_agenda_reminders r where r.id=n.reminder_id and r.active and r.advisor_id=n.user_id)`);
      await pool.query(`update public.crm_agenda_notifications n set active=false where n.active and n.user_id <> (select r.advisor_id from public.crm_agenda_reminders r where r.id=n.reminder_id)`);
    }
    const { rows } = await pool.query(
      `select r.id, r.case_type, r.case_id, r.advisor_id, r.scheduled_at, r.anticipation_hours
         from public.crm_agenda_reminders r
        where r.active and r.created_at <= $1 and r.scheduled_at > $1`, [at]);
    const retries = await pool.query(
      `select r.id, r.case_type, r.case_id, r.advisor_id, r.scheduled_at, r.anticipation_hours,
              d.recipient_id, d.stage
         from public.crm_lead_alert_deliveries d
         join public.crm_agenda_reminders r on r.id = d.alert_id
        where d.state='failed' and r.active and r.scheduled_at > $1 limit 100`, [at]);
    const formatWhen = value => `${new Intl.DateTimeFormat('es-AR',{timeZone:'America/Argentina/Buenos_Aires',dateStyle:'short',timeStyle:'short'}).format(new Date(value))} (Argentina)`;
    const ticketLabel = value => value ? (String(value).startsWith('PB-') ? `Ticket ${value}` : `Ticket PB-${value}`) : 'Caso';
    async function details(row) {
      let conversationId = row.case_id;
      let ticket = null, name = null;
      try {
        if (row.case_type === 'whatsapp') {
          const linked = await pool.query('select conversation_id from public.crm_commercial_cases where id=$1', [row.case_id]);
          if (linked.rows[0]?.conversation_id) conversationId = linked.rows[0].conversation_id;
        }
        const meta = await pool.query('select c.ticket_number, ct.nombre from public.crm_conversations c left join public.crm_contacts ct on ct.id=c.contact_id where c.id=$1', [conversationId]);
        ticket = meta.rows[0]?.ticket_number || null; name = meta.rows[0]?.nombre || null;
      } catch { /* legacy fixture: keep operational fallback */ }
      return {conversationId, ticket, name};
    }
    const payloadFor = (row, meta) => ({
      title: 'Próxima gestión programada',
      body: `${ticketLabel(meta.ticket)} · ${meta.name || 'Contacto'} · ${formatWhen(row.scheduled_at)}`,
      url: `/crm-leads?conversationId=${meta.conversationId}`,
      kind: 'agenda', anticipationHours: row.anticipation_hours,
    });
    let pushSent = 0, inAppCreated = 0;
    for (const row of rows) {
      const meta = await details(row);
      const r = {...row, conversation_id: meta.conversationId, ticket_number: meta.ticket, contact_name: meta.name, payload: payloadFor(row, meta)};
      try {
        if (canInApp) {
          const ins = await pool.query(`insert into public.crm_agenda_notifications(user_id,reminder_id,case_type,case_id,conversation_id,title,body,link) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(reminder_id,user_id) do nothing`, [row.advisor_id,row.id,row.case_type,row.case_id,meta.conversationId,r.payload.title,r.payload.body,r.payload.url]);
          if (ins.rowCount) inAppCreated++;
        }
        pushSent += await claimAndDeliver({pool, webPush, row: r, userId: row.advisor_id, stage: `agenda_${row.anticipation_hours}`, logger});
      } catch (error) { logger.warn?.('no se pudo notificar agenda', row.id, error?.message || error); }
    }
    for (const r of retries.rows) {
      const meta = await details(r);
      const row = {...r, conversation_id: meta.conversationId, ticket_number: meta.ticket, contact_name: meta.name, payload: payloadFor(r, meta)};
      try {
        if (canInApp) {
          const ins = await pool.query(`insert into public.crm_agenda_notifications(user_id,reminder_id,case_type,case_id,conversation_id,title,body,link) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(reminder_id,user_id) do nothing`, [r.recipient_id,r.id,r.case_type,r.case_id,meta.conversationId,row.payload.title,row.payload.body,row.payload.url]);
          if (ins.rowCount) inAppCreated++;
        }
        pushSent += await claimAndDeliver({pool, webPush, row, userId: r.recipient_id, stage: r.stage, retry: true, logger});
      } catch (error) { logger.warn?.('no se pudo reintentar agenda', r.id, error?.message || error); }
    }
    return {notifications: pushSent, pushSent, inAppCreated, reminders: rows.length, at};
  };
}
