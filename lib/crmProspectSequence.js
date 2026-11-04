import crypto from 'node:crypto';

// Three-step outbound sequence for PADBOL PROSPECT. This module prepares copy,
// language and response state only. send_enabled stays false; no message is
// delivered by this file.
const SIGNATURE = 'Nicolás Renedo\nGeneral Manager\nPadbol International\ninfo@padbol.com\nwww.padbol.com';
const LEGAL = 'Padbol International · Entertainment and Sports Services LLC · info@padbol.com · www.padbol.com';

const COPY = {
  es: [
    {
      subject: 'Una nueva oportunidad deportiva y comercial para su club',
      body: `{{greeting}}

Soy Nicolás Renedo, de Padbol Internacional.

Estamos desarrollando Padbol en distintos mercados del mundo y creemos que {{club}} podría encontrar una oportunidad interesante para incorporar una nueva actividad deportiva y comercial.

Padbol es mucho más que una cancha.

Es un deporte innovador que combina elementos del fútbol, pádel, voleibol, tenis y squash, acompañado de un sistema integral que incluye equipamiento oficial, formación, herramientas digitales, programas de desarrollo deportivo y competiciones internacionales.

Nuestro objetivo es ayudar a clubes y operadores deportivos a incorporar una actividad diferente, atraer nuevos jugadores y desarrollar nuevas oportunidades de negocio.

Los invitamos a descubrir el Sistema Padbol:

{{experienceUrl}}

Allí podrán conocer el deporte, nuestras instalaciones y el ecosistema internacional que hemos desarrollado.

Si consideran que Padbol podría encajar en {{club}}, estaremos encantados de conversar sobre su proyecto y evaluar juntos las posibilidades.

Un cordial saludo,

${SIGNATURE}

Si no desea recibir más comunicaciones comerciales, puede responder BAJA.
También puede gestionar su baja aquí: {{unsubscribeUrl}}

{{legal}}`,
    },
    {
      subject: '¿Cómo puede Padbol generar nuevas oportunidades para su club?',
      body: `{{greeting}}

Hace unos días les presentamos Padbol y la posibilidad de incorporar una nueva actividad deportiva a {{club}}.

Hoy queremos compartirles algo que consideramos especialmente importante: Padbol no es solamente una cancha, sino un sistema diseñado para desarrollar una actividad deportiva y comercial sostenible.

Además del alquiler de canchas, Padbol permite desarrollar diferentes actividades:

* Escuelas y formación: programas de enseñanza y desarrollo de jugadores mediante Padbol Academy.
* Competencias y torneos: actividades que ayudan a construir una comunidad de jugadores habituales.
* Next Generation: iniciativas orientadas a incorporar nuevas generaciones al deporte.
* Padbol Match: nuestra plataforma digital para reservas, organización de actividades, competiciones y rankings.
* Desarrollo internacional: integración en una red deportiva con presencia en distintos países.

Todo esto permite que cada club pueda explorar diferentes oportunidades de actividad e ingresos, adaptadas a su mercado y a sus instalaciones.

Los invitamos a conocer más sobre el Sistema Padbol:

{{experienceUrl}}

Si les interesa evaluar cómo podría incorporarse Padbol a {{club}}, podemos conversar sobre las instalaciones necesarias, las distintas configuraciones y los modelos comerciales disponibles.

Estaremos encantados de conocer sus planes.

Un cordial saludo,

${SIGNATURE}

Si no desea recibir más comunicaciones comerciales, puede responder BAJA.
También puede gestionar su baja aquí: {{unsubscribeUrl}}

{{legal}}`,
    },
    {
      subject: 'Sea pionero de Padbol en su ciudad',
      body: `{{greeting}}

Hace unos días les presentamos Padbol y las oportunidades que ofrece nuestro sistema deportivo y comercial.

Hoy queremos invitarlos a considerar algo diferente:

¿Y si {{club}} pudiera convertirse en uno de los pioneros de Padbol en su ciudad?

Padbol nació como un deporte innovador y hoy tiene presencia en más de 30 países, con una comunidad internacional que continúa desarrollándose.

Estamos trabajando para ampliar esa presencia y generar nuevas oportunidades para clubes, emprendedores y operadores deportivos.

Ser pionero significa tener la oportunidad de introducir una actividad diferente, desarrollar una nueva comunidad de jugadores y posicionarse desde las primeras etapas de crecimiento del deporte en su mercado.

Y no se trata de comenzar desde cero.

El Sistema Padbol reúne canchas oficiales, formación, herramientas digitales, programas deportivos, competiciones y acompañamiento para facilitar su desarrollo.

Nos gustaría conocer su visión y explorar si {{club}} podría formar parte de esta nueva etapa.

¿Les interesaría mantener una breve conversación con nuestro equipo comercial?

Podemos evaluar juntos las posibilidades de incorporar Padbol a sus instalaciones y desarrollar el deporte en su ciudad.

Conozca más sobre el Sistema Padbol:

{{experienceUrl}}

Un cordial saludo,

${SIGNATURE}

Si no desea recibir más comunicaciones comerciales, puede responder BAJA.
También puede gestionar su baja aquí: {{unsubscribeUrl}}

{{legal}}`,
    },
  ],
  en: [
    {
      subject: 'A new sports and business opportunity for your club',
      body: `{{greeting}}

My name is Nicolás Renedo, and I represent Padbol International.

We are expanding Padbol into new markets around the world, and we believe {{club}} could find an interesting opportunity to introduce a new sporting and business activity.

Padbol is much more than a court.

It is an innovative sport combining elements of football, padel, volleyball, tennis and squash, supported by a complete ecosystem that includes official equipment, training, digital tools, sports development programmes and international competitions.

Our goal is to help sports clubs and operators introduce a distinctive activity, attract new players and develop additional business opportunities.

We invite you to discover the Padbol System:

{{experienceUrl}}

There, you can explore the sport, our facilities and the international ecosystem we have developed.

If you believe Padbol could be a good fit for {{club}}, we would be delighted to discuss your project and explore the possibilities together.

Best regards,

${SIGNATURE}

If you prefer not to receive further commercial communications, please reply UNSUBSCRIBE.
You can also manage your unsubscribe here: {{unsubscribeUrl}}

{{legal}}`,
    },
    {
      subject: 'How can Padbol create new opportunities for your club?',
      body: `{{greeting}}

A few days ago, we introduced Padbol and the possibility of bringing a new sporting activity to {{club}}.

Today, we would like to share something particularly important: Padbol is not simply a court, but a system designed to develop a sustainable sporting and commercial activity.

Beyond court rentals, Padbol offers opportunities to develop several complementary activities:

* Schools and training: teaching programmes and player development through Padbol Academy.
* Competitions and tournaments: activities that help build a community of regular players.
* Next Generation: initiatives designed to introduce younger generations to the sport.
* Padbol Match: our digital platform for bookings, activity management, competitions and rankings.
* International development: participation in an international sporting network with a presence in different countries.

Together, these elements allow each club to explore different sporting and revenue opportunities, adapted to its market and facilities.

We invite you to discover more about the Padbol System:

{{experienceUrl}}

If you are interested in exploring how Padbol could become part of {{club}}, we would be pleased to discuss the facility requirements, different configurations and available business models.

We would be delighted to learn more about your plans.

Best regards,

${SIGNATURE}

If you prefer not to receive further commercial communications, please reply UNSUBSCRIBE.
You can also manage your unsubscribe here: {{unsubscribeUrl}}

{{legal}}`,
    },
    {
      subject: 'Be a Padbol pioneer in your city',
      body: `{{greeting}}

A few days ago, we introduced Padbol and the opportunities offered by our sporting and commercial system.

Today, we would like to invite you to consider something different:

What if {{club}} could become one of the Padbol pioneers in your city?

Padbol was born as an innovative sport and today has a presence in more than 30 countries, with an international community that continues to develop.

We are working to expand that presence and create new opportunities for clubs, entrepreneurs and sports operators.

Being a pioneer means having the opportunity to introduce a distinctive activity, develop a new community of players and establish an early position as the sport grows in your market.

And you would not be starting from scratch.

The Padbol System brings together official courts, training, digital tools, sports development programmes, competitions and support to facilitate its growth.

We would be interested in learning about your vision and exploring whether {{club}} could become part of this next stage.

Would you be interested in a brief conversation with our commercial team?

We can explore together the possibilities of incorporating Padbol into your facilities and developing the sport in your city.

Discover more about the Padbol System:

{{experienceUrl}}

Best regards,

${SIGNATURE}

If you prefer not to receive further commercial communications, please reply UNSUBSCRIBE.
You can also manage your unsubscribe here: {{unsubscribeUrl}}

{{legal}}`,
    },
  ],
};

const STEP_DAYS = [0, 7, 14];
const SPANISH_COUNTRIES = new Set(['AR','BO','CL','CO','CR','CU','DO','EC','ES','GT','HN','MX','NI','PA','PE','PR','PY','SV','UY','VE']);

function unsubscribeSecret() {
  return process.env.PROSPECT_UNSUBSCRIBE_SECRET || process.env.CRM_INBOUND_FORM_SECRET || '';
}

export function createUnsubscribeToken(email) {
  const value = String(email || '').trim().toLowerCase();
  const secret = unsubscribeSecret();
  if (!value || !secret) return '';
  const payload = Buffer.from(JSON.stringify({ email: value, exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 365 })).toString('base64url');
  const signature = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

export function verifyUnsubscribeToken(token) {
  const [payload, signature] = String(token || '').split('.');
  const secret = unsubscribeSecret();
  if (!payload || !signature || !secret) return null;
  const expected = crypto.createHmac('sha256', secret).update(payload).digest('base64url');
  const a = Buffer.from(signature), b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString());
    if (!value?.email || Number(value.exp) < Date.now() / 1000) return null;
    return value;
  } catch { return null; }
}

export function unsubscribeUrlFor(email) {
  const token = createUnsubscribeToken(email);
  return token ? `https://padbol.com/api/prospect/unsubscribe?token=${encodeURIComponent(token)}` : '';
}

export function sequenceLanguage(countryCode, preference) {
  const preferenceValue = String(preference || '').toLowerCase();
  if (['es','en'].includes(preferenceValue)) return preferenceValue;
  return SPANISH_COUNTRIES.has(String(countryCode || '').toUpperCase()) ? 'es' : 'en';
}

export function sequenceSteps(language = 'es') {
  return STEP_DAYS.map((day, index) => ({ day, ...(COPY[language] || COPY.es)[index] }));
}

function officialExperienceUrl(value) {
  try {
    const url = new URL(String(value || '').trim());
    if (url.protocol !== 'https:') return '';
    if (!['padbol.com', 'www.padbol.com'].includes(url.hostname)) return '';
    if (!url.pathname.startsWith('/experiencia-comercial')) return '';
    return url.toString();
  } catch { return ''; }
}

function greetingFor(prospect, language) {
  const name = String(prospect.contact_name || '').trim();
  if (!name) return language === 'es' ? 'Hola,' : 'Hello,';
  return language === 'es' ? `Hola, ${name}:` : `Hello ${name},`;
}

export function renderSequenceMessage(step, prospect = {}, options = {}) {
  const language = String(options.language || prospect.language || 'es').toLowerCase() === 'en' ? 'en' : 'es';
  const experienceUrl = officialExperienceUrl(options.experienceUrl ?? process.env.PADBOL_EXPERIENCE_URL);
  const unsubscribeUrl = String(options.unsubscribeUrl || unsubscribeUrlFor(prospect.email)).trim();
  const club = String(prospect.name || prospect.trade_name || prospect.legal_name || '').trim() || (language === 'es' ? 'su club' : 'your club');
  const values = {
    greeting: greetingFor(prospect, language),
    club,
    experienceUrl: experienceUrl || '{{experienceUrl}}',
    unsubscribeUrl: unsubscribeUrl || '{{unsubscribeUrl}}',
    legal: LEGAL,
  };
  const render = value => String(value || '').replace(/\{\{\s*(greeting|club|experienceUrl|unsubscribeUrl|legal)\s*\}\}/gi, (_, key) => values[key]);
  return {
    day: step.day,
    subject: render(step.subject),
    body: render(step.body),
    language,
    experienceUrl,
    missingExperienceUrl: !experienceUrl,
    missingUnsubscribeUrl: !unsubscribeUrl,
  };
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
  return ['opt_out', 'bounce', 'not_interested', 'interested', 'information_request', 'price_request', 'meeting_request', 'ambiguous'].includes(classification);
}

export function statusForClassification(classification) {
  return ({ opt_out: 'opt_out', bounce: 'bounced', not_interested: 'rejected', interested: 'interested', information_request: 'responded', price_request: 'interested', meeting_request: 'interested', ambiguous: 'paused' })[classification] || 'paused';
}
