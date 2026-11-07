// Avisos internos de Agenda: misma fuente (next_contact_at) y mismo recibo durable que las alertas.
export function createAgendaReminderNotifier({ pool, webPush, now = () => new Date(), logger = console }) {
  return async function run() {
    // Recupera claims colgados por caida del proceso (no toca ambiguos ni enviados).
    await pool.query(`update public.crm_lead_alert_deliveries set state='failed', error_code='STALE_CLAIM'
      where state='claimed' and claimed_at < now() - interval '5 minutes'`);
    const at = now().toISOString();
    await pool.query('select public.crm_agenda_reminders_sweep($1)', [at]);
    await pool.query('select public.crm_agenda_reminders_reconcile()');
    const { rows } = await pool.query(
      `select r.id, r.case_type, r.case_id, r.advisor_id, r.scheduled_at, r.anticipation_hours
         from public.crm_agenda_reminders r
        where r.created_at <= $1`, [at]);
    let sent = 0;
    for (const row of rows) {
      const payload = { title: 'Próxima gestión programada', body: `Caso ${row.case_type} con gestión el ${row.scheduled_at}`, url: `/admin/crm/${row.case_type === 'form' ? 'formulario' : 'whatsapp'}/${row.case_id}`, kind: 'agenda', anticipationHours: row.anticipation_hours };
      const userId = row.advisor_id;
      const claim = await pool.query(
        `insert into public.crm_lead_alert_deliveries (alert_id, stage, recipient_id)
         values ($1,$2,$3) on conflict do nothing returning alert_id`,
        [row.id, `agenda_${row.anticipation_hours}`, userId]);
      if (!claim.rowCount) continue;
      try { const result = await webPush.notify({ userId, payload }); sent += result.sent || 0;
        await pool.query('update public.crm_lead_alert_deliveries set sent_at=now() where alert_id=$1 and stage=$2 and recipient_id=$3', [row.id, `agenda_${row.anticipation_hours}`, userId]);
      } catch (error) {
        await pool.query('delete from public.crm_lead_alert_deliveries where alert_id=$1 and stage=$2 and recipient_id=$3', [row.id, `agenda_${row.anticipation_hours}`, userId]);
        logger.warn?.('no se pudo notificar agenda', row.id, error?.message || error);
      }
    }
    return { notifications: sent, reminders: rows.length, at };
  };
}
