// Avisos internos de Agenda: misma fuente (next_contact_at), mismo canal y misma entrega que alertas.
import {claimAndDeliver, recoverStaleClaims} from './crmLeadDelivery.js';

export function createAgendaReminderNotifier({ pool, webPush, now = () => new Date(), logger = console }) {
  return async function run() {
    const at = now().toISOString();
    // Reconcile ANTES del sweep: al cambiar A->B con la misma fecha, libera el unique antes de insertar.
    await pool.query('select public.crm_agenda_reminders_reconcile()');
    await pool.query('select public.crm_agenda_reminders_sweep($1)', [at]);
    await recoverStaleClaims(pool);
    const canInApp = Boolean((await pool.query("select to_regclass('public.crm_agenda_notifications') t")).rows[0]?.t);
    if (canInApp) {
      await pool.query(`update public.crm_agenda_notifications n set active=false where n.active and not exists(select 1 from public.crm_agenda_reminders r where r.id=n.reminder_id and r.active and r.advisor_id=n.user_id)`);
      await pool.query(`update public.crm_agenda_notifications n set active=false where n.active and n.user_id <> (select r.advisor_id from public.crm_agenda_reminders r where r.id=n.reminder_id)`);
    }
    const { rows } = await pool.query(
      `select r.id, r.case_type, r.case_id, r.advisor_id, r.scheduled_at, r.anticipation_hours
         from public.crm_agenda_reminders r
        where r.active and r.created_at <= $1`, [at]);
    const retries = await pool.query(
      `select r.id, r.case_type, r.case_id, r.advisor_id, r.scheduled_at, r.anticipation_hours,
              d.recipient_id, d.stage
         from public.crm_lead_alert_deliveries d
         join public.crm_agenda_reminders r on r.id = d.alert_id
        where d.state='failed' and r.active limit 100`);
    let sent = 0;
    async function details(row) {
      let conversationId = row.case_type === 'form' ? row.case_id : row.case_id;
      let ticket = null, name = null;
      try {
        if (row.case_type === 'whatsapp') {
          const linked = await pool.query('select conversation_id from public.crm_commercial_cases where id=$1', [row.case_id]);
          if (linked.rows[0]?.conversation_id) conversationId = linked.rows[0].conversation_id;
        }
        const meta = await pool.query('select c.ticket_number, ct.nombre from public.crm_conversations c left join public.crm_contacts ct on ct.id=c.contact_id where c.id=$1', [conversationId]);
        ticket = meta.rows[0]?.ticket_number || null; name = meta.rows[0]?.nombre || null;
      } catch { /* legacy fixtures without metadata still get a durable in-app row */ }
      return {conversationId, ticket, name};
    }
    for (const row of rows) {
      const meta = await details(row);
      const r = {...row, conversation_id: meta.conversationId, ticket_number: meta.ticket, contact_name: meta.name};
      const payloadOf = () => ({title:'Próxima gestión programada',body:`${meta.ticket ? `Ticket ${meta.ticket}` : 'Caso'} · ${meta.name || 'Contacto'} · ${new Date(row.scheduled_at).toLocaleString('es-AR')}`,url:`/crm-leads?conversationId=${meta.conversationId}`,kind:'agenda',anticipationHours:row.anticipation_hours});
      r.payload = payloadOf();
      try {
        if (canInApp && new Date(row.scheduled_at) > new Date(at)) await pool.query(`insert into public.crm_agenda_notifications(user_id,reminder_id,case_type,case_id,conversation_id,title,body,link) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(reminder_id,user_id) do nothing`, [row.advisor_id,row.id,row.case_type,row.case_id,meta.conversationId,r.payload.title,r.payload.body,r.payload.url]);
        sent += await claimAndDeliver({pool, webPush, row: r, userId: row.advisor_id, stage: `agenda_${row.anticipation_hours}`, logger});
      } catch (error) { logger.warn?.('no se pudo notificar agenda', row.id, error?.message || error); }
    }
    for (const r of retries.rows) {
      const row = {...r, payload: {title:'Próxima gestión programada',body:`Caso con gestión el ${new Date(r.scheduled_at).toLocaleString('es-AR')}`,url:`/crm-leads?conversationId=${r.case_id}`,kind:'agenda',anticipationHours:r.anticipation_hours}};
      try {
        await pool.query(`insert into public.crm_agenda_notifications(user_id,reminder_id,case_type,case_id,conversation_id,title,body,link) values($1,$2,$3,$4,$5,$6,$7,$8) on conflict(reminder_id,user_id) do nothing`, [row.advisor_id,row.id,row.case_type,row.case_id,row.conversation_id||row.case_id,r.payload.title,r.payload.body,r.payload.url]);
        sent += await claimAndDeliver({pool, webPush, row, userId: r.recipient_id, stage: r.stage, retry: true, logger}); }
      catch (error) { logger.warn?.('no se pudo reintentar agenda', r.id, error?.message || error); }
    }
    return { notifications: sent, reminders: rows.length, at };
  };
}
