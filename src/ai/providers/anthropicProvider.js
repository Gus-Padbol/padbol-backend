const ANTHROPIC_MODEL = 'claude-sonnet-4-20250514';
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export const anthropicProvider = {
  name: 'anthropic',

  async completeChat({ system, userMessage, maxTokens = 512 }) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      const err = new Error('ANTHROPIC_API_KEY no configurada');
      err.status = 503;
      err.code = 'AI_PROVIDER_UNAVAILABLE';
      throw err;
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
        max_tokens: maxTokens,
        system,
        messages: [{ role: 'user', content: userMessage }],
      }),
    });

    if (!response.ok) {
      const err = new Error(`AI provider error (${response.status})`);
      err.status = 502;
      err.code = 'AI_PROVIDER_ERROR';
      throw err;
    }

    const data = await response.json();
    const reply = data?.content?.find((block) => block.type === 'text')?.text?.trim();
    if (!reply) {
      const err = new Error('Respuesta vacía del provider');
      err.status = 502;
      err.code = 'AI_PROVIDER_EMPTY';
      throw err;
    }

    return { reply, provider: 'anthropic', model: ANTHROPIC_MODEL };
  },
};
