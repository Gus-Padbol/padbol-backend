// Adaptador común para formularios web. El ID debe provenir del registro
// persistido por el formulario (no de un valor aleatorio enviado por el navegador).

function clean(value, max) {
  return String(value ?? '').trim().slice(0, max);
}

function cleanFields(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).slice(0, 40).flatMap(([label, fieldValue]) => {
    const safeLabel = clean(label, 100);
    const safeValue = clean(Array.isArray(fieldValue) ? fieldValue.join(', ') : fieldValue, 1000);
    return safeLabel && safeValue ? [[safeLabel, safeValue]] : [];
  }));
}

const WORKFLOWS = new Set(['commercial_lead', 'program_registration', 'event_registration', 'support']);

function cleanRouting({ workflow, campaignId, eventId, clubId, clubName, country } = {}) {
  const normalizedWorkflow = clean(workflow, 48).toLowerCase();
  return {
    workflow: WORKFLOWS.has(normalizedWorkflow) ? normalizedWorkflow : 'commercial_lead',
    campaign_id: clean(campaignId, 160) || null,
    event_id: clean(eventId, 160) || null,
    club_id: clean(clubId, 160) || null,
    club_name: clean(clubName, 160) || null,
    country: clean(country, 120) || null,
  };
}

function cleanParticipant({ participantType, registrationMode, guardian } = {}) {
  const normalizedMode = clean(registrationMode, 48).toLowerCase();
  const guardianValue = guardian && typeof guardian === 'object' && !Array.isArray(guardian)
    ? {
        name: clean(guardian.name, 160) || null,
        email: clean(guardian.email, 320).toLowerCase() || null,
        phone: clean(guardian.phone, 64) || null,
        consent: guardian.consent === true,
      }
    : null;
  return {
    type: clean(participantType, 48).toLowerCase() || 'adult',
    registration_mode: ['pre_registered', 'walk_in'].includes(normalizedMode)
      ? normalizedMode
      : 'pre_registered',
    guardian: guardianValue,
  };
}

export function formSubmissionToCrmIngest({
  id,
  form = 'web_contact',
  email,
  phone,
  name,
  subject,
  message,
  fields,
  workflow,
  campaignId,
  eventId,
  clubId,
  clubName,
  country,
  participantType,
  registrationMode,
  guardian,
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
    qualificationData: {
      form_submission: {
        form: clean(form, 80) || 'web_contact',
        fields: cleanFields(fields),
      },
      routing: cleanRouting({ workflow, campaignId, eventId, clubId, clubName, country }),
      participant: cleanParticipant({ participantType, registrationMode, guardian }),
      lead_analysis_request: {
        status: 'pending',
      },
    },
  };
}
