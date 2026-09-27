import assert from 'node:assert/strict';
import test from 'node:test';

import { createCrmLeadAutoAnalyzer } from './crmLeadAutoAnalysis.js';

test('analiza un formulario y adjunta el resultado a la misma ficha', async () => {
  let attached = null;
  const analyzer = createCrmLeadAutoAnalyzer({
    env: { ANTHROPIC_API_KEY: 'test-key', ANTHROPIC_MODEL: 'test-model' },
    logger: { info() {} },
    crmService: { async attachLeadAnalysis(payload) { attached = payload; return { conversation: { id: 'v-1' } }; } },
    fetchImpl: async (_url, options) => {
      const request = JSON.parse(options.body);
      assert.equal(request.model, 'test-model');
      return {
        ok: true,
        async json() {
          return { content: [{ type: 'text', text: JSON.stringify({
            score: 72, priority: 'B', verdict: 'Lead para calificar.', summary: 'Club interesado.',
            identity: 'No verificada.', market: 'Mercado por validar.', climate: 'Evaluar indoor.',
            recommendation: 'Contactar y validar predio.', risks: ['Fondos no verificados'],
            nextSteps: ['Llamar'], sources: [],
          }) }] };
        },
      };
    },
  });
  await analyzer({ ingest: {
    sourceId: 'form-123', nombre: 'Club Norte', email: 'club@example.com', subject: 'Quiero una cancha',
    qualificationData: { form_submission: { form: 'contacto', fields: { País: 'Argentina' } } },
  } });
  assert.equal(attached.sourceId, 'form-123');
  assert.equal(attached.analysisId, 'crm-auto-form-123-v1');
  assert.equal(attached.score, 72);
  assert.equal(attached.priority, 'B');
});

test('no se habilita sin credencial del proveedor', () => {
  assert.equal(createCrmLeadAutoAnalyzer({ crmService: {}, env: {} }), null);
});

