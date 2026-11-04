const TEMPLATES = {
  venue_sale: {
    en: {subject:'A Padbol court opportunity for {{company}}', body:'Hello {{contact}},\n\nI am reaching out from Padbol International. We are expanding the Padbol System with sports operators and venue owners in {{city}}.\n\nPadbol combines football, tennis and squash in one court and is designed to add a differentiated experience to existing indoor sports facilities. I would be glad to share the operator model and next steps.\n\nWould you be open to a short conversation?\n\nBest regards,\nPadbol International Commercial Team'},
    es: {subject:'Una oportunidad de cancha Padbol para {{company}}', body:'Hola {{contact}}:\n\nTe escribo del equipo comercial de Padbol Internacional. Estamos expandiendo el Sistema Padbol con operadores deportivos y dueños de instalaciones en {{city}}.\n\nPadbol combina fútbol, tenis y squash en una sola cancha y está pensado para sumar una experiencia diferencial a complejos indoor existentes. Con gusto comparto el modelo de operación y los próximos pasos.\n\n¿Te interesa una conversación breve?\n\nSaludos,\nEquipo Comercial — Padbol Internacional'},
  },
  representation: {
    en: {subject:'Padbol representation in {{region}}', body:'Hello {{contact}},\n\nWe are evaluating representation partners for the Padbol System in {{region}}. Your organisation’s experience with sports operations and facilities is relevant to that conversation.\n\nI would like to share the territorial model and understand your current footprint.\n\nBest regards,\nPadbol International Commercial Team'},
    es: {subject:'Representación Padbol en {{region}}', body:'Hola {{contact}}:\n\nEstamos evaluando socios de representación para el Sistema Padbol en {{region}}. La experiencia de su organización en operación deportiva e instalaciones es relevante para esa conversación.\n\nMe gustaría compartir el modelo territorial y conocer su presencia actual.\n\nSaludos,\nEquipo Comercial — Padbol Internacional'},
  },
  franchise: {
    en: {subject:'A Padbol franchise conversation for {{company}}', body:'Hello {{contact}},\n\nPadbol International is expanding its franchise and multi-site model with selected sports operators. {{company}} looks like a potential fit for a conversation about the model, investment profile and territory.\n\nWould you be open to reviewing the opportunity?\n\nBest regards,\nPadbol International Commercial Team'},
    es: {subject:'Conversación sobre franquicia Padbol para {{company}}', body:'Hola {{contact}}:\n\nPadbol Internacional está expandiendo su modelo de franquicia y multisede con operadores deportivos seleccionados. {{company}} puede ser un interlocutor relevante para conversar sobre el modelo, el perfil de inversión y el territorio.\n\n¿Te interesa conocer la oportunidad?\n\nSaludos,\nEquipo Comercial — Padbol Internacional'},
  },
  investor: {
    en: {subject:'Padbol sports investment opportunity', body:'Hello {{contact}},\n\nWe are sharing a sports infrastructure opportunity with investors and operators evaluating differentiated indoor sports concepts. Padbol is an international sport and operating system with a court, league and venue model.\n\nWould a short introduction be useful?\n\nBest regards,\nPadbol International Commercial Team'},
    es: {subject:'Oportunidad de inversión deportiva Padbol', body:'Hola {{contact}}:\n\nCompartimos una oportunidad de infraestructura deportiva con inversores y operadores que evalúan conceptos indoor diferenciales. Padbol es un deporte internacional y un sistema de operación con cancha, liga y modelo de sede.\n\n¿Te resultaría útil una introducción breve?\n\nSaludos,\nEquipo Comercial — Padbol Internacional'},
  },
  chain: {
    en: {subject:'A multi-site Padbol opportunity for {{company}}', body:'Hello {{contact}},\n\nWe are mapping multi-site sports operators for a Padbol pilot in {{region}}. {{company}}’s footprint could be relevant for a small number of locations.\n\nI would be glad to share the operating model and pilot criteria.\n\nBest regards,\nPadbol International Commercial Team'},
    es: {subject:'Oportunidad Padbol multisede para {{company}}', body:'Hola {{contact}}:\n\nEstamos relevando operadores deportivos multisede para un piloto Padbol en {{region}}. La presencia de {{company}} podría ser relevante para un número acotado de sedes.\n\nCon gusto comparto el modelo de operación y los criterios del piloto.\n\nSaludos,\nEquipo Comercial — Padbol Internacional'},
  },
};
import { sequenceSteps } from './crmProspectSequence.js';
const STEP_DAYS = [0,7,14];

export function templateFor(opportunityType, language='en') {
  const key = Object.hasOwn(TEMPLATES, opportunityType) ? opportunityType : 'venue_sale';
  return TEMPLATES[key][language] || TEMPLATES[key].en;
}

function render(text, prospect = {}) {
  return String(text || '').replace(/\{\{\s*(company|contact|city|region|country|experienceUrl)\s*\}\}/gi, (_, key) => {
    const map = {company: prospect.name, contact: prospect.contact_name || 'there', city: prospect.city, region: prospect.region || prospect.state || prospect.city, country: prospect.country, experienceUrl: process.env.PADBOL_EXPERIENCE_URL || ''};
    return String(map[key] || '').trim() || '';
  });
}

export function campaignSteps({opportunityType='venue_sale', language='en', subject, body} = {}) {
  if (!subject && !body) return sequenceSteps(language);
  const base = templateFor(opportunityType, language);
  return STEP_DAYS.map(day => ({
    day,
    subject: subject || (day === 0 ? base.subject : `${day === 7 ? 'Following up' : 'Last note'}: ${base.subject}`),
    body: body || base.body,
  }));
}

export function renderCampaignMessage(step, prospect, language='en') {
  return {subject: render(step.subject, prospect), body: render(step.body, prospect)};
}

export function classifyProspectResponse(text='') {
  const value = String(text).toLowerCase();
  if (/(unsubscribe|opt.?out|baja|no more|stop|remove|desuscrib)/i.test(value)) return 'opt_out';
  if (/(bounce|mailer-daemon|delivery status|undeliverable)/i.test(value)) return 'bounce';
  if (/(out of office|automatic reply|auto.?reply|vacation|ausencia)/i.test(value)) return 'automatic_reply';
  if (/(not interested|no thanks|no,? thank|sin interés|no gracias|remove me)/i.test(value)) return 'rejected';
  if (/(price|pricing|cost|proposal|propuesta|información|information|send me|más info)/i.test(value)) return 'information_request';
  if (/(meeting|call|llamada|reunión|schedule|agenda|disponible)/i.test(value)) return 'interest';
  if (/(negotiat|negociaci|contract|contrato|terms|condiciones)/i.test(value)) return 'negotiation';
  if (/(interested|interesad|tell me more|contame|quiero saber)/i.test(value)) return 'interest';
  if (/^\s*$/.test(value)) return 'ambiguous';
  return 'ambiguous';
}
