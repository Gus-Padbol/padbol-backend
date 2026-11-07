// Entrega interna compartida por alertas y Agenda. Semantica conservadora unica.
export const definitiveFailure = (error) => error?.definitive === true
  || (Number(error?.status) >= 400 && Number(error?.status) < 500 && ![408, 425, 429].includes(Number(error?.status)));

/** Claims colgados: pudo haberse enviado => ambiguous/manual, nunca reenvio automatico. */
export async function recoverStaleClaims(pool) {
  await pool.query(`update public.crm_lead_alert_deliveries set state='ambiguous', error_code='STALE_CLAIM'
    where state='claimed' and claimed_at < now() - interval '5 minutes'`);
}

/**
 * Reclama (si no es retry) y entrega una notificacion. Devuelve cantidad entregada (0 si no hay evidencia).
 * Estados: claimed -> sent | failed | ambiguous | unconfirmed.
 */
export async function claimAndDeliver({ pool, webPush, row, userId, stage, retry = false, logger = console }) {
  if (!retry) {
    const claim = await pool.query(
      `insert into public.crm_lead_alert_deliveries (alert_id, stage, recipient_id)
       values ($1,$2,$3) on conflict do nothing returning alert_id`,
      [row.id, stage, userId]);
    if (!claim.rowCount) return 0;
  }
  let out;
  try { out = await webPush.notify({ userId, payload: row.payload }); }
  catch (error) {
    const code = String(error?.code || error?.name || '');
    const state = definitiveFailure(error) ? 'failed' : 'ambiguous';
    await pool.query('update public.crm_lead_alert_deliveries set state=$4, error_code=$5, attempts=attempts+1 where alert_id=$1 and stage=$2 and recipient_id=$3',
      [row.id, stage, userId, state, code || 'SEND_FAILED']);
    return 0;
  }
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
