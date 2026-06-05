const CHIVI_SYSTEM_PROMPT =
  'Eres Chivi, el asistente virtual de Padbol Match. Ayudas a jugadores a reservar canchas, buscar partidos, consultar torneos y rankings. Conoces el deporte Padbol (fusión de tenis, pádel y fútbol, 2v2). Responde siempre en español latinoamericano neutro, de forma concisa y útil. No inventes datos específicos de reservas o torneos — para eso indica al usuario que use las secciones de la app.';

const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

function buildUserPrompt(message, context = {}) {
  const contextEntries = Object.entries(context ?? {}).filter(([, value]) => value != null && value !== '');
  if (contextEntries.length === 0) return message;

  const contextText = contextEntries
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');

  return `Contexto del usuario:\n${contextText}\n\nConsulta:\n${message}`;
}

export async function sendChiviChatMessage({ message, userId, context = {} }) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    throw new Error('ANTHROPIC_API_KEY no configurada');
  }

  const trimmedMessage = String(message ?? '').trim();
  if (!trimmedMessage) {
    throw new Error('message es requerido');
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 512,
      system: CHIVI_SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: buildUserPrompt(trimmedMessage, { ...context, userId }),
        },
      ],
    }),
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${errorBody}`);
  }

  const data = await response.json();
  const reply = data?.content?.find((block) => block.type === 'text')?.text?.trim();
  if (!reply) {
    throw new Error('Respuesta vacía de Anthropic');
  }

  return reply;
}
