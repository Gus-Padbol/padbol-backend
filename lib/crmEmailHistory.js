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
  return {truncated: inbound.data.length > 200 || outbound.data.length > 200,
    messages: [
      ...inbound.data.slice(0, 200).map(row => ({id: row.id, direction: 'inbound', body: row.body, subject: row.subject, at: row.received_at})),
      ...outbound.data.slice(0, 200).map(row => ({id: row.id, direction: 'outbound', body: row.body, at: row.created_at, status: row.status})),
    ].sort((a, b) => String(a.at || '').localeCompare(String(b.at || '')) || String(a.id).localeCompare(String(b.id)))};
}
