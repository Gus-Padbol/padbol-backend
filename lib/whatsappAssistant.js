import { createHash } from 'node:crypto';

// Deterministic, safe WhatsApp assistant (no LLM, no invented data).
// Clasifica el mensaje entrante, resuelve una respuesta aprobada o deriva a una
// persona, y nunca informa precios, descuentos, cuotas ni condiciones comerciales.

export const WHATSAPP_ASSISTANT_DEFAULT_HANDOFF =
  'Un asesor de Padbol Match te va a ayudar. Escribinos por https://padbolmatch.com/contacto';

export const WHATSAPP_ASSISTANT_TOPICS = Object.freeze({
  courses_academy: {
    title: { es: 'Cursos y Padbol Academy', en: 'Courses and Padbol Academy' },
    keywords: [
      'curso', 'cursos', 'academy', 'academia', 'inscrip', 'clase', 'clases',
      'aprender', 'entrenamiento', 'formacion', 'coach', 'entrenador', 'cursar',
      'precio', 'precios', 'costo', 'costos', 'cuota', 'cuotas', 'arancel',
      'matricula', 'descuento', 'promocion', 'promoción',
    ],
  },
  access_account: {
    title: { es: 'Acceso y cuenta', en: 'Access and account' },
    keywords: [
      'cuenta', 'login', 'loguear', 'iniciar sesion', 'contraseña', 'password',
      'registro', 'registrar', 'acceso', 'email', 'correo', 'verificacion',
      'recuperar', 'cerrar sesion', 'no puedo entrar', 'no entra',
    ],
  },
  venues_courts_bookings: {
    title: { es: 'Sedes, canchas y reservas', en: 'Venues, courts and bookings' },
    keywords: [
      'sede', 'sedes', 'cancha', 'canchas', 'reservar', 'reserva', 'reservas',
      'turno', 'turnos', 'alquilar', 'horario', 'horarios', 'disponibilidad',
      'court', 'book', 'reservacion', 'reservación',
    ],
  },
  tournaments_competition_ranking: {
    title: { es: 'Torneos, competiciones y ranking', en: 'Tournaments, competition and ranking' },
    keywords: [
      'torneo', 'torneos', 'competicion', 'competencias', 'ranking', 'rankings',
      'fixture', 'inscribir', 'inscripcion', 'copa', 'campeonato', 'competir',
      'resultado', 'resultados', 'tabla', 'podio', 'posiciones',
    ],
  },
  padbol_match: {
    title: { es: 'Padbol Match', en: 'Padbol Match' },
    keywords: [
      'padbol match', 'que es padbol', 'qué es padbol', 'aplicacion', 'plataforma',
      'multideporte', 'padcoins', 'que es la app', 'qué es la app', 'para que sirve',
      'para qué sirve', 'que ofrece', 'qué ofrece',
    ],
  },
  fipa_rules: {
    title: { es: 'FIPA y reglamento', en: 'FIPA and rules' },
    keywords: [
      'fipa', 'reglamento', 'reglas', 'arbitro', 'arbitraje', 'federacion',
      'falta', 'cristal', 'servicio', 'toques', 'zona de ataque', 'juez', 'punto',
    ],
  },
  support_human: {
    title: { es: 'Soporte y solicitud de una persona', en: 'Support and human handoff' },
    keywords: [
      'soporte', 'ayuda', 'persona', 'humano', 'asesor', 'hablar con', 'atencion',
      'representante', 'agente', 'contacto', 'reclamo', 'queja', 'problema',
    ],
  },
});

export const WHATSAPP_ASSISTANT_TOPIC_ORDER = Object.freeze([
  'courses_academy',
  'access_account',
  'venues_courts_bookings',
  'tournaments_competition_ranking',
  'fipa_rules',
  'support_human',
  'padbol_match',
]);

const MAX_TEXT_LENGTH = 4096;

export function normalizeInboundText(value, maxLength = MAX_TEXT_LENGTH) {
  const text = String(value ?? '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, maxLength) : '';
}

export function classifyWhatsappMessage(text) {
  const normalized = normalizeInboundText(text);
  if (!normalized) return { topic: null, reason: 'empty' };

  for (const topic of WHATSAPP_ASSISTANT_TOPIC_ORDER) {
    const keywords = WHATSAPP_ASSISTANT_TOPICS[topic].keywords;
    const matched = keywords.find((keyword) => normalized.includes(keyword));
    if (matched) {
      return { topic, reason: 'matched', matched };
    }
  }
  return { topic: null, reason: 'unknown' };
}

export function sanitizeForLog(value, maxLength = 200) {
  const text = String(value ?? '').slice(0, maxLength);
  return text
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]')
    .replace(/\+\d[\d\s().-]{5,}\d/g, '[tel]')
    .replace(/\b\d{7,9}\b/g, '[id]');
}

export function isSpamLike(normalizedText) {
  if (!normalizedText) return true;
  if (normalizedText.length < 2 || normalizedText.length > 1600) return true;
  if (/(.)\1{7,}/.test(normalizedText)) return true;
  const urlCount = (normalizedText.match(/https?:\/\/|www\./g) || []).length;
  if (urlCount > 2) return true;
  return false;
}

function safeResponseFor(topic, { academyUrl } = {}) {
  const academy = academyUrl && String(academyUrl).trim()
    ? String(academyUrl).trim()
    : 'https://padbol.com';

  const responses = {
    courses_academy:
      `Para cursos e inscripción a Padbol Academy ingresá a ${academy}. ` +
      'No informamos precios, cuotas ni condiciones por este canal.',
    access_account:
      'Para ayuda con tu cuenta, abrí Padbol Match y usá la opción de recuperar contraseña. ' +
      'No modificamos cuentas ni contraseñas por este canal.',
    venues_courts_bookings:
      'En Padbol Match podés ver sedes, canchas y horarios disponibles y reservar desde la app. ' +
      'No confirmamos disponibilidad por este canal.',
    tournaments_competition_ranking:
      'Los torneos, fechas, inscripciones y rankings se publican dentro de Padbol Match. ' +
      'No informamos fechas, cupos ni resultados por este canal.',
    padbol_match:
      'Padbol Match es la plataforma oficial de Padbol para jugar, reservar, competir y seguir tu progreso. ' +
      'Descargala y explorá las sedes habilitadas.',
    fipa_rules:
      'El reglamento oficial lo publica FIPA en www.padbol.com. ' +
      'No reemplazamos al árbitro ni al reglamento oficial en competencia.',
    support_human: WHATSAPP_ASSISTANT_DEFAULT_HANDOFF,
  };
  return responses[topic] || WHATSAPP_ASSISTANT_DEFAULT_HANDOFF;
}

export function assistantConfigFromEnv(env = process.env) {
  const dispatchAllowed = String(env.WHATSAPP_ASSISTANT_DISPATCH_ALLOWED ?? 'false').trim() === 'true';
  const academyUrl = String(env.WHATSAPP_ACADEMY_URL ?? '').trim();
  const humanHandoffChannel = String(env.WHATSAPP_HUMAN_HANDOFF_CHANNEL ?? '').trim();
  const authorizedOperators = String(env.WHATSAPP_ASSISTANT_OPERATORS ?? '')
    .split(',')
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  return {
    dispatchAllowed,
    academyUrl,
    humanHandoffChannel,
    authorizedOperators: new Set(authorizedOperators),
  };
}

export function isAuthorizedOperator(operatorId, config) {
  const id = String(operatorId ?? '').trim().toLowerCase();
  if (!id) return false;
  return Boolean(config?.authorizedOperators?.has?.(id));
}

/**
 * Permisos WhatsApp por persona:
 * - superadmin (role === 'super_admin' o email legacy de superadmin): audita todo,
 *   pero NO atiende ni deriva.
 * - operator (email en `operators`): atiende y deriva únicamente; no audita todo.
 * - none: sin acceso.
 * El email legacy de superadmin que también sea operador se trata como operador,
 * para respetar "el superadmin no debe quedar como operador" y viceversa.
 * No modifica los permisos globales del superadmin; es una capa propia de WhatsApp.
 */
export function resolveWhatsappPermissions({
  email,
  role,
  operators = new Set(),
  superAdminEmails = new Set(),
} = {}) {
  const normalized = String(email ?? '').trim().toLowerCase();
  const has = (set, value) => (
    set instanceof Set ? set.has(value) : Array.isArray(set) && set.includes(value)
  );
  const isOperator = has(operators, normalized);
  const isLegacySuperAdmin = has(superAdminEmails, normalized);
  const isSuperAdmin = role === 'super_admin' || (isLegacySuperAdmin && !isOperator);
  return {
    role: isSuperAdmin ? 'superadmin' : (isOperator ? 'operator' : 'none'),
    canOperate: isOperator && !isSuperAdmin,
    canAudit: isSuperAdmin,
  };
}

function handoffBody(humanHandoffChannel) {
  if (humanHandoffChannel && String(humanHandoffChannel).trim()) {
    return `Un asesor de Padbol Match te va a ayudar. Escribinos por ${String(humanHandoffChannel).trim()}.`;
  }
  return WHATSAPP_ASSISTANT_DEFAULT_HANDOFF;
}

/**
 * Resolves the assistant reply for an inbound message.
 * Returns `{ kind, dispatch, topic, body }`. `dispatch=false` means no automated
 * response should be queued (held, spam, invalid, or no safe answer).
 */
export function resolveAssistantReply({ text, config } = {}) {
  const normalized = normalizeInboundText(text);
  const cfg = config ?? assistantConfigFromEnv();

  if (!normalized) return { kind: 'invalid', dispatch: false };
  if (!cfg.dispatchAllowed) return { kind: 'held', dispatch: false };
  if (isSpamLike(normalized)) return { kind: 'spam', dispatch: false };

  const { topic, reason } = classifyWhatsappMessage(normalized);
  if (!topic || topic === 'support_human') {
    return {
      kind: 'handoff',
      dispatch: true,
      topic: 'support_human',
      body: handoffBody(cfg.humanHandoffChannel),
    };
  }

  return {
    kind: 'reply',
    dispatch: true,
    topic,
    body: safeResponseFor(topic, { academyUrl: cfg.academyUrl }),
  };
}

export function assistantIdempotencySuffix() {
  return 'assistant-reply-v1';
}

export function assistantIdempotencyKey({ tenantId, channelId, providerMessageId }) {
  return createHash('sha256')
    .update(`${tenantId}:${channelId}:${providerMessageId}:${assistantIdempotencySuffix()}`)
    .digest('hex');
}
