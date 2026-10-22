import { normalizeEmail, normalizePhone } from './crmContact.js';

function invalid(message, status = 400, code = 'CRM_MANUAL_INVALID') {
  return Object.assign(new Error(message), { status, code });
}

export function matchingManualContact(rows, email, phone) {
  const unique = [...new Map((rows || []).map(row => [row.id, row])).values()];
  if (unique.length > 1) throw invalid('El correo y teléfono corresponden a contactos distintos. Revisa sus datos.', 409, 'CRM_MANUAL_IDENTITY_CONFLICT');
  const contact = unique[0];
  if (contact && ((email && contact.email_normalized && email !== contact.email_normalized)
    || (phone && contact.phone_normalized && phone !== contact.phone_normalized))) {
    throw invalid('El contacto existente tiene otra identidad de contacto. No se modificaron sus datos.', 409, 'CRM_MANUAL_IDENTITY_CONFLICT');
  }
  return contact || null;
}

export async function saveManualContact(repository, input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw invalid('Datos del contacto inválidos.');
  for (const key of ['name', 'email', 'phone']) {
    if (input[key] != null && typeof input[key] !== 'string') throw invalid('Los datos del contacto deben ser texto.');
  }
  for (const key of ['origin', 'subject', 'body', 'sede_id']) {
    if (input[key] != null && String(input[key]).trim()) throw invalid('El registro manual admite solo nombre, correo y teléfono. No guarda notas, origen ni sede.');
  }
  const nombre = String(input.name ?? '').trim();
  const rawEmail = String(input.email ?? '').trim();
  const rawPhone = String(input.phone ?? '').trim();
  if (!nombre || nombre.length > 160) throw invalid('Ingresa un nombre de hasta 160 caracteres.');
  if (rawEmail && (rawEmail.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail))) throw invalid('Ingresa un correo completo.');
  if (rawPhone && !/^\+?[0-9 ().-]+$/.test(rawPhone)) throw invalid('Ingresa un teléfono válido.');
  const email = normalizeEmail(rawEmail), phone = normalizePhone(rawPhone);
  if (rawPhone && !phone) throw invalid('El teléfono debe contener entre 8 y 15 dígitos.');
  if (!email && !phone) throw invalid('Ingresa un correo o teléfono de contacto.');
  const prior = matchingManualContact(await repository.findContactsByEmailOrPhone(email, phone), email, phone);
  const result = prior ? { contact: prior, created: false } : await repository.createManualContactRecord({ nombre, email_normalized: email, phone_normalized: phone, review_needed: false });
  const contact = result?.contact;
  if (!contact?.id) throw invalid('No se pudo confirmar el contacto guardado.', 503, 'CRM_MANUAL_UNAVAILABLE');
  return {
    ok: true, existing: !result.created,
    contact: { id: contact.id, nombre: contact.nombre ?? null, email_normalized: contact.email_normalized ?? null, phone_normalized: contact.phone_normalized ?? null },
  };
}
