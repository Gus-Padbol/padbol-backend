// Adaptador común para formularios web. El ID debe provenir del registro
// persistido por el formulario (no de un valor aleatorio enviado por el navegador).

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

export function formSubmissionToCrmIngest({
  id,
  form = 'web_contact',
  email,
  phone,
  name,
  subject,
  message,
} = {}) {
  const sourceId = clean(id, 512);
  const emailValue = clean(email, 320).toLowerCase();
  const phoneValue = clean(phone, 64);
  if (!sourceId || (!emailValue && !phoneValue)) return null;
  return {
    source: 'form',
    sourceId,
    // El formulario crea una consulta escrita que se responde por correo.
    channel: 'email',
    email: emailValue || null,
    phone: phoneValue || null,
    nombre: clean(name, 160) || null,
    identityUsed: emailValue || phoneValue,
    origin: `web_form:${clean(form, 80) || 'web_contact'}`,
    subject: clean(subject, 512) || 'Consulta desde formulario web',
    body: clean(message, 4000) || null,
  };
}
