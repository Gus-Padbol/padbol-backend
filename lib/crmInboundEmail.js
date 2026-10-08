// Adaptador de correo entrante independiente del proveedor.
// Acepta un evento canónico simulado; luego se conecta Resend/SendGrid/etc.
// sin modificar el núcleo del CRM.

export function normalizeInboundEmailEvent(event) {
  if (!event || typeof event !== 'object') return null;
  const externalId = String(event.externalId ?? event.id ?? '').trim();
  const from = String(event.from ?? event.sender ?? '').trim();
  const to = String(event.to ?? '').trim();
  const subject = String(event.subject ?? '').trim().slice(0, 512);
  const body = String(event.body ?? event.text ?? '').trim().slice(0, 4000);
  const receivedAt = event.receivedAt ?? event.date ?? new Date().toISOString();
  if (
    !externalId ||
    !/^[^@\s]+@[^@\s]+$/.test(from) ||
    !/^[^@\s]+@[^@\s]+$/.test(to) ||
    (!subject && !body)
  ) return null;
  return { externalId, from, to, subject, body, receivedAt };
}

export function emailEventToCrmIngest(event) {
  const normalized = normalizeInboundEmailEvent(event);
  if (!normalized) return null;
  return {
    source: 'email',
    sourceId: normalized.externalId,
    channel: 'email',
    email: normalized.from,
    phone: null,
    identityUsed: normalized.from,
    origin: 'institutional_email',
    subject: normalized.subject,
    body: normalized.body,
    receivedAt: normalized.receivedAt,
  };
}
