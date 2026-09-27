const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (!candidate) throw new Error('CRM_LEAD_ANALYSIS_EMPTY');
  return JSON.parse(candidate);
}

function responseText(payload) {
  if (typeof payload?.output_text === 'string') return payload.output_text;
  return Array.isArray(payload?.output)
    ? payload.output.flatMap((item) => Array.isArray(item?.content) ? item.content : [])
      .filter((part) => part?.type === 'output_text').map((part) => part.text).join('\n')
    : '';
}

export function createCrmLeadAutoAnalyzer({ crmService, env = process.env, fetchImpl = fetch, logger = console } = {}) {
  if (!crmService) return null;
  const apiKey = String(env.OPENAI_API_KEY || '').trim();
  if (!apiKey) return null;
  const model = String(env.CRM_LEAD_ANALYSIS_MODEL || env.OPENAI_MODEL || 'gpt-4o-mini').trim();

  return async function analyzeLead({ ingest } = {}) {
    if (!ingest?.sourceId) return null;
    const facts = {
      name: ingest.nombre,
      email: ingest.email,
      phone: ingest.phone,
      subject: ingest.subject,
      message: ingest.body,
      form: ingest.qualificationData?.form_submission?.form,
      fields: ingest.qualificationData?.form_submission?.fields || {},
    };
    const response = await fetchImpl(OPENAI_RESPONSES_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model,
        store: false,
        max_output_tokens: 1800,
        instructions: 'Sos analista comercial de Padbol. Evaluá solamente los datos recibidos, sin inventar identidad, antecedentes, fondos ni verificaciones externas. Si falta información, indicalo con claridad.',
        input: `Analizá este lead para orientar al asesor comercial. Datos: ${JSON.stringify(facts)}`,
        text: {
          format: {
            type: 'json_schema',
            name: 'padbol_lead_analysis',
            strict: true,
            schema: {
              type: 'object',
              additionalProperties: false,
              properties: {
                score: { type: 'integer', minimum: 0, maximum: 100 },
                priority: { type: 'string', enum: ['A', 'B', 'C'] },
                verdict: { type: 'string' },
                summary: { type: 'string' },
                identity: { type: 'string' },
                market: { type: 'string' },
                climate: { type: 'string' },
                recommendation: { type: 'string' },
                risks: { type: 'array', items: { type: 'string' } },
                nextSteps: { type: 'array', items: { type: 'string' } },
                sources: {
                  type: 'array',
                  items: {
                    type: 'object',
                    additionalProperties: false,
                    properties: { label: { type: 'string' }, url: { type: ['string', 'null'] } },
                    required: ['label', 'url'],
                  },
                },
              },
              required: ['score', 'priority', 'verdict', 'summary', 'identity', 'market', 'climate', 'recommendation', 'risks', 'nextSteps', 'sources'],
            },
          },
        },
      }),
    });
    if (!response.ok) throw new Error(`CRM_LEAD_ANALYSIS_PROVIDER_${response.status}`);
    const providerPayload = await response.json();
    const analysis = extractJson(responseText(providerPayload));
    const result = await crmService.attachLeadAnalysis({
      analysisId: `crm-auto-${ingest.sourceId}-v1`,
      sourceId: ingest.sourceId,
      score: analysis.score,
      priority: analysis.priority,
      verdict: analysis.verdict,
      summary: analysis.summary,
      identity: analysis.identity,
      market: analysis.market,
      climate: analysis.climate,
      recommendation: analysis.recommendation,
      risks: analysis.risks,
      nextSteps: analysis.nextSteps,
      sources: analysis.sources,
    });
    logger?.info?.('[crm-lead-analysis] completed', { conversationId: result?.conversation?.id || null });
    return result;
  };
}
