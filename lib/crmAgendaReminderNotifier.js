// Avisos internos de Agenda: misma fuente (next_contact_at), mismo canal y misma entrega que alertas.
import {claimAndDeliver, recoverStaleClaims} from './crmLeadDelivery.js';

export function createAgendaReminderNotifier({ pool, webPush, now = () => new Date(), logger = console }) {
  return async function run() {
    const at = now().toISOString();
    await pool.query('select public.crm_agenda_reminders_sweep($1)', [at]);
    await pool.query('select public.crm_agenda_reminders_reconcile()');
    await recoverStaleClaims(pool);
    const { rows } = await pool.query(
      `select r.id, r.case_type, r.case_id, r.advisor_id, r.scheduled_at, r.anticipation_hours
         from public.crm_agenda_reminders r
        where r.created_at <= $1`, [at]);
    const retries = await pool.query(
      `select r.id, r.case_type, r.case_id, r.advisor_id, r.scheduled_at, r.anticipation_hours,
              d.recipient_id, d.stage
         from public.crm_lead_alert_deliveries d
         join public.crm_agenda_reminders r on r.id = d.alert_id
        where d.state='failed' limit 100`);
    let sent = 0;
    const payloadOf = (row) => ({
      title: 'Próxima gestión programada',
      body: `Caso ${row.case_type} con gestión el ${row.scheduled_at}`,
      url: `/admin/crm/${row.case_type === 'form' ? 'formulario' : 'whatsapp'}/${row.case_id}`,
      kind: 'agenda', anticipationHours: row.anticipation_hours,
    });
    for (const row of rows) {
      const r = {...row, payload: payloadOf(row)};
      try { sent += await claimAndDeliver({pool, webPush, row: r, userId: row.advisor_id, stage: `agenda_${row.anticipation_hours}`, logger}); }
      catch (error) { logger.warn?.('no se pudo notificar agenda', row.id, error?.message || error); }
    }
    for (const r of retries.rows) {
      const row = {...r, payload: payloadOf(r)};
      try { sent += await claimAndDeliver({pool, webPush, row, userId: r.recipient_id, stage: r.stage, retry: true, logger}); }
      catch (error) { logger.warn?.('no se pudo reintentar agenda', r.id, error?.message || error); }
    }
    return { notifications: sent, reminders: rows.length, at };
  };
}
