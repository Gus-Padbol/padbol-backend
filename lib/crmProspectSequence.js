// Three-step outbound sequence for PADBOL PROSPECT. Sending stays disabled;
// this module only prepares copy, language and response state.
const SIGNATURE = 'Nicolás Renedo\nGeneral Manager\nPadbol International\ninfo@padbol.com';

const COPY = {
  es: [
    {
      subject: 'Una oportunidad Padbol para {{company}}',
      body: `Hola {{contact}}:\n\nMe presento: soy Nicolás Renedo, General Manager de Padbol International. Estamos desarrollando el Sistema Padbol con clubes y operadores deportivos en {{city}}.\n\nPadbol es un deporte y un sistema completo: cancha oficial, operación, Academy, Next Generation, Padbol Match y competición internacional. Será un gusto compartir el modelo y evaluar si encaja con su club.\n\n¿Le interesa una conversación breve?\n\nConocé la experiencia interactiva: {{experienceUrl}}\n\n${SIGNATURE}\n\nSi no desea recibir más mensajes, responda “BAJA”.`,
    },
    {
      subject: 'El Sistema Padbol: cancha, operación y comunidad',
      body: `Hola {{contact}}:\n\nEl Sistema Padbol no termina en una cancha. Integra una estructura técnica, un modelo de operación, formación a través de Padbol Academy, el circuito Next Generation, la comunidad de Padbol Match y competencia internacional.\n\nPara un club u operador, eso significa sumar una experiencia diferencial y una comunidad activa, no solo alquilar una instalación.\n\nPuedo compartirle cómo se aplica a {{company}} y qué información necesitamos para avanzar.\n\nConocé la experiencia interactiva: {{experienceUrl}}\n\n${SIGNATURE}\n\nSi no desea recibir más mensajes, responda “BAJA”.`,
    },
    {
      subject: 'La oportunidad de ser pionero de Padbol en su región',
      body: `Hola {{contact}}:\n\nPadbol sigue expandiéndose y cada territorio tiene un momento para construir comunidad, canchas oficiales y competencia. Si {{company}} quiere liderar ese desarrollo en {{region}}, podemos evaluar juntos el siguiente paso.\n\nNo se trata de una promesa de resultados: se trata de conocer el sistema, el mercado y las condiciones aplicables antes de decidir.\n\n¿Conversamos con nuestro equipo?\n\nConocé la experiencia interactiva: {{experienceUrl}}\n\n${SIGNATURE}\n\nSi no desea recibir más mensajes, responda “BAJA”.`,
    },
  ],
  en: [
    {
      subject: 'A Padbol opportunity for {{company}}',
      body: `Hello {{contact}},\n\nI am Nicolás Renedo, General Manager of Padbol International. We are developing the Padbol System with clubs and sports operators in {{city}}.\n\nPadbol is a sport and a complete system: an official court, operations, Academy, Next Generation, Padbol Match and international competition. I would be glad to share the model and assess whether it fits your club.\n\nWould you be open to a short conversation?\n\nExplore the interactive experience: {{experienceUrl}}\n\n${SIGNATURE}\n\nIf you do not wish to receive further messages, reply “UNSUBSCRIBE”.`,
    },
    {
      subject: 'The Padbol System: court, operations and community',
      body: `Hello {{contact}},\n\nThe Padbol System does not end with a court. It combines a technical structure, an operating model, Padbol Academy training, the Next Generation pathway, the Padbol Match community and international competition.\n\nFor a club or operator, that means adding a differentiated experience and an active community, not simply renting a facility.\n\nI can show you how it applies to {{company}} and what information we need to move forward.\n\nExplore the interactive experience: {{experienceUrl}}\n\n${SIGNATURE}\n\nIf you do not wish to receive further messages, reply “UNSUBSCRIBE”.`,
    },
    {
      subject: 'The opportunity to be a Padbol pioneer in your region',
      body: `Hello {{contact}},\n\nPadbol continues to expand, and every territory has a moment to build community, official courts and competition. If {{company}} wants to lead that development in {{region}}, we can assess the next step together.\n\nThis is not a promise of results: it is about understanding the system, the market and the applicable conditions before deciding.\n\nMay we speak with our team?\n\nExplore the interactive experience: {{experienceUrl}}\n\n${SIGNATURE}\n\nIf you do not wish to receive further messages, reply “UNSUBSCRIBE”.`,
    },
  ],
};

const STEP_DAYS = [0, 7, 14];
const SPANISH_COUNTRIES = new Set(['AR','BO','CL','CO','CR','CU','DO','EC','ES','GT','HN','MX','NI','PA','PE','PR','PY','SV','UY','VE']);

export function sequenceLanguage(countryCode, preference) {
  const preferenceValue = String(preference || '').toLowerCase();
  if (['es','en'].includes(preferenceValue)) return preferenceValue;
  return SPANISH_COUNTRIES.has(String(countryCode || '').toUpperCase()) ? 'es' : 'en';
}

export function sequenceSteps(language = 'es') {
  return STEP_DAYS.map((day, index) => ({ day, ...(COPY[language] || COPY.es)[index] }));
}

export function renderSequenceMessage(step, prospect = {}, experienceUrl = '') {
  const values = {
    company: prospect.name || prospect.legal_name || 'your organisation',
    contact: prospect.contact_name || (prospect.language === 'es' ? 'equipo' : 'team'),
    city: prospect.city || prospect.region || '',
    region: prospect.region || prospect.state || prospect.city || prospect.country || '',
    experienceUrl,
  };
  const render = value => String(value || '').replace(/\{\{\s*(company|contact|city|region|experienceUrl)\s*\}\}/gi, (_, key) => values[key] || '');
  return { subject: render(step.subject), body: render(step.body) };
}

// Categories required by the commercial pilot. Order matters: explicit
// unsubscribe/bounce wins over every other interpretation.
export function classifyProspectReply(text = '') {
  const value = String(text).toLowerCase();
  if (/(unsubscribe|opt.?out|baja|no more|stop|remove|desuscrib|do not contact)/i.test(value)) return 'opt_out';
  if (/(mailer-daemon|delivery status|undeliverable|bounce|address not found|no such user)/i.test(value)) return 'bounce';
  if (/(not interested|no thanks|no,? thank|sin interés|no gracias|not for us|not a fit)/i.test(value)) return 'not_interested';
  if (/(meeting|call|llamada|reunión|reunion|schedule|agenda|disponible|availability|hablar con)/i.test(value)) return 'meeting_request';
  if (/(price|pricing|cost|quote|proposal|propuesta|presupuesto|cotización|precio|tarifa)/i.test(value)) return 'price_request';
  if (/(information|información|informacion|send me|más info|more info|details|brochure|documentación)/i.test(value)) return 'information_request';
  if (/(interested|interesad|tell me more|quiero saber|me gustaría|i would like|sounds good)/i.test(value)) return 'interested';
  return 'ambiguous';
}

export function stopSequenceFor(classification) {
  return ['opt_out', 'bounce', 'not_interested', 'interested', 'information_request', 'price_request', 'meeting_request'].includes(classification);
}

export function statusForClassification(classification) {
  return ({ opt_out: 'opt_out', bounce: 'bounced', not_interested: 'rejected', interested: 'interested', information_request: 'responded', price_request: 'interested', meeting_request: 'interested', ambiguous: 'paused' })[classification] || 'paused';
}
