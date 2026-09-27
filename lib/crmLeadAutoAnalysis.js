const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

function extractJson(text) {
  const raw = String(text || '').trim();
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1];
  const candidate = fenced || raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  if (!candidate) throw new Error('CRM_LEAD_ANALYSIS_EMPTY');
  return JSON.parse(candidate);
}

function textBlocks(payload) {
  return Array.isArray(payload?.content)
    ? payload.content.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
    : '';
}

export function createCrmLeadAutoAnalyzer({ crmService, env = process.env, fetchImpl = fetch, logger = console } = {}) {
  if (!crmService) return null;
  const apiKey = String(env.ANTHROPIC_API_KEY || '').trim();
  if (!apiKey) return null;
  const model = String(env.CRM_LEAD_ANALYSIS_MODEL || env.ANTHROPIC_MODEL || 'claude-sonnet-4-6').trim();

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
    const response = await fetchImpl(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model,
        max_tokens: 1800,
        temperature: 0.2,
        system: 'Sos analista comercial de Padbol. Evaluá solamente los datos recibidos, sin inventar identidad, antecedentes, fondos ni verificaciones externas. Respondé exclusivamente JSON válido.',
        messages: [{ role: 'user', content: `Analizá este lead y devolvé JSON con: score entero 0-100, priority A/B/C, verdict, summary, identity, market, climate, recommendation, risks (array), nextSteps (array), sources (array vacío si no hay fuentes verificadas). Datos: ${JSON.stringify(facts)}` }],
      }),
    });
    if (!response.ok) throw new Error(`CRM_LEAD_ANALYSIS_PROVIDER_${response.status}`);
    const providerPayload = await response.json();
    const analysis = extractJson(textBlocks(providerPayload));
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

