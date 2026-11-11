const fail = () => Object.assign(Error('No se pudo consultar el historial de correo.'), {status: 503, code: 'CRM_EMAIL_HISTORY_UNAVAILABLE'});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Server-only reader: callers authorize this exact conversation before reading
// and recheck its current scope before returning the private transcript.
export async function loadCrmEmailHistory(db, conversationId) {
  if (!uuid.test(conversationId || '')) throw Object.assign(Error('Conversación no encontrada.'), {status: 404, code: 'CRM_NOT_FOUND'});
  let inbound, outbound;
  try {
    [inbound, outbound] = await Promise.all([
      db.from('crm_inbound_events').select('id,body,subject,received_at').eq('conversation_id', conversationId).eq('source_channel', 'email').order('received_at', {ascending: false}).order('id', {ascending: false}).limit(201),
      db.from('crm_replies').select('id,body,status,created_at').eq('conversation_id', conversationId).order('created_at', {ascending: false}).order('id', {ascending: false}).limit(201),
    ]);
  } catch { throw fail(); }
  if (inbound.error || outbound.error || !Array.isArray(inbound.data) || !Array.isArray(outbound.data)) throw fail();
  const delivery = new Map();
  if (outbound.data.length) {
    try {
      const receipts = await db.from('crm_email_provider_receipts').select('reply_id,delivered_at,bounced_at,failed_at,complained_at').in('reply_id',outbound.data.slice(0,200).map(row=>row.id)).limit(200);
      if (!receipts.error) for (const row of receipts.data || []) {
        const status=row.bounced_at?'bounced':row.failed_at?'failed':row.complained_at?'complained':row.delivered_at?'delivered':'unconfirmed';
        delivery.set(row.reply_id,{deliveryStatus:status,deliveryAt:row[`${status}_at`] || null});
      }
    } catch { /* Preserve readable history without inventing a delivery confirmation. */ }
  }
  return {truncated: inbound.data.length > 200 || outbound.data.length > 200,
    messages: [
      ...inbound.data.slice(0, 200).map(row => ({id: row.id, direction: 'inbound', body: row.body, subject: row.subject, at: row.received_at})),
      ...outbound.data.slice(0, 200).map(row => ({id: row.id, direction: 'outbound', body: row.body, at: row.created_at, status: row.status, ...(delivery.get(row.id) || {deliveryStatus:'unconfirmed',deliveryAt:null})})),
    ].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || String(a.id).localeCompare(String(b.id)))};
}
