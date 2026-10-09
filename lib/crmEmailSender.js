import { backendRuntime } from './backendRuntime.js';

function address(value) {
  const text = String(value || '').trim();
  if (/\r|\n/.test(text)) return null;
  const match = text.match(/^(?:[^<>]+<([^<>]+)>|([^<>]+))$/);
  const email = match?.[1] || match?.[2];
  return email && /^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(email) ? text : null;
}

export function buildCrmEmailCapability(env = {}, runtime = backendRuntime(env)) {
  const provider = String(env.CRM_OUTBOUND_EMAIL_PROVIDER || '').trim().toLowerCase() || null;
  const missing = [];
  if (!provider) missing.push('CRM_OUTBOUND_EMAIL_PROVIDER');
  else if (provider !== 'resend') missing.push('SUPPORTED_CRM_EMAIL_PROVIDER');
  if (!address(env.CRM_OUTBOUND_EMAIL_FROM)) missing.push('VALID_CRM_OUTBOUND_EMAIL_FROM');
  if (!String(env.CRM_OUTBOUND_EMAIL_API_KEY || '').trim()) missing.push('CRM_OUTBOUND_EMAIL_API_KEY');
  const configured = missing.length === 0;
  return { provider, configured, enabled: configured && runtime.outboundDeliveryEnabled && env.CRM_OUTBOUND_EMAIL_ENABLED === 'true', missing };
}

export function createCrmEmailSender({ env = process.env, runtime = backendRuntime(env), fetchImpl = fetch } = {}) {
  const capability = buildCrmEmailCapability(env, runtime);
  if (!capability.enabled) return null;
  const from = address(env.CRM_OUTBOUND_EMAIL_FROM);
  const token = String(env.CRM_OUTBOUND_EMAIL_API_KEY).trim();
  return async ({ conversation, body, replyId }) => {
    const recipient = String(conversation?.contact?.email_normalized || '').trim();
    if (!address(recipient) || recipient.includes('<')) throw Object.assign(new Error('La conversación no tiene un correo de contacto válido.'), { status: 400, code: 'CRM_EMAIL_RECIPIENT_INVALID' });
    if (!replyId || !String(body || '').trim()) throw Object.assign(new Error('La respuesta de correo no es válida.'), { status: 400, code: 'CRM_EMAIL_REPLY_INVALID' });
    let response;
    try {
      response = await fetchImpl('https://api.resend.com/emails', {
        method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'Idempotency-Key': `crm-reply:${replyId}` },
        body: JSON.stringify({ from, to: [recipient], subject: 'Respuesta a tu consulta en Padbol', text: String(body).trim() }),
        signal: AbortSignal.timeout(10000),
      });
    } catch { throw Object.assign(new Error('No pudimos confirmar el envío del correo. Revisa el estado antes de intentar nuevamente.'), { status: 503, code: 'CRM_EMAIL_SEND_UNCONFIRMED' }); }
    if (response.status >= 500) throw Object.assign(new Error('No pudimos confirmar el envío del correo. Revisa el estado antes de intentar nuevamente.'), { status: 503, code: 'CRM_EMAIL_SEND_UNCONFIRMED' });
    if (!response.ok) throw Object.assign(new Error('El proveedor de correo no aceptó el envío.'), { status: 503, code: 'CRM_EMAIL_SEND_REJECTED' });
    const result = await response.json().catch(() => null);
    if (!result?.id) throw Object.assign(new Error('No pudimos confirmar el envío del correo.'), { status: 503, code: 'CRM_EMAIL_SEND_UNCONFIRMED' });
    return { providerMessageId: result.id };
  };
}
