const CHIVI_SYSTEM_PROMPT =
  'Eres Chivi, el asistente virtual de Padbol Match. Responde ÚNICAMENTE basándote en el contexto oficial que se te proporciona a continuación. Si no sabes algo con certeza, di que no tienes esa información y sugiere consultar padbol.com. NUNCA inventes datos. Responde en español latinoamericano neutro, sin emojis, de forma concisa.';

const PADBOL_OFFICIAL_CONTEXT = `CONTEXTO OFICIAL DE PADBOL:
- Inventor: Gustavo Miguens, en La Plata, Argentina, en 2008
- Deporte de fusión: combina tenis, pádel y fútbol
- Se juega 2 contra 2 (4 jugadores en total, 2 por lado)
- Cancha: 10x6 metros con paredes y red
- Federación internacional: FIPA (Federación Internacional de Padbol), presidente: Gustavo Miguens
- Presente en más de 30 países
- Categorías masculinas: Principiante, 5ta, 4ta, 3ra, 2da, 1ra, Elite
- Padbol Match es la plataforma oficial de gestión de reservas, torneos y rankings de PADBOL
- Sede principal de pruebas: La Meca Padbol Club, La Plata, Argentina
- Para reservas, torneos y rankings usar siempre las secciones de la app`;

const CHIVI_CONTEXT_ACK =
  'Entendido. Responderé únicamente con base en el contexto oficial de Padbol proporcionado.';

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
          content: PADBOL_OFFICIAL_CONTEXT,
        },
        {
          role: 'assistant',
          content: CHIVI_CONTEXT_ACK,
        },
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
