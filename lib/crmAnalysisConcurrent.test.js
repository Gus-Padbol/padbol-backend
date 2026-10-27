import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmService } from './crmService.js';

test('análisis conserva contexto WhatsApp escrito durante la operación', async () => {
  let row = { id: 'test', source_channel: 'whatsapp', qualification_data: {} };
  let attempts = 0;
  const repo = {
    async findConversationBySourceRef() { return structuredClone(row); },
    async getConversation() { return structuredClone(row); },
    async updateLeadAnalysis(_id, next, previous) {
      if (++attempts === 1) row.qualification_data = { whatsapp_menu: { initialMessage: 'consulta original' } };
      if (JSON.stringify(previous) !== JSON.stringify(row.qualification_data)) return null;
      row.qualification_data = next;
      return structuredClone(row);
    },
  };
  const result = await createCrmService({ repository: repo }).attachLeadAnalysis({
    sourceId: 'test', analysisId: 'a1', score: 50, priority: 'B',
  });
  assert.equal(attempts, 2);
  assert.equal(result.conversation.qualification_data.whatsapp_menu.initialMessage, 'consulta original');
  assert.equal(result.conversation.qualification_data.lead_analysis.analysis_id, 'a1');
});

test('contención persistente falla sin reemplazar datos', async () => {
  let attempts = 0;
  const row = { id: 'test', qualification_data: { whatsapp_menu: { initialMessage: 'original' } } };
  const repo = {
    async findConversationBySourceRef() { return structuredClone(row); },
    async getConversation() { return structuredClone(row); },
    async updateLeadAnalysis() { attempts += 1; return null; },
  };
  await assert.rejects(() => createCrmService({ repository: repo }).attachLeadAnalysis({
    sourceId: 'test', analysisId: 'a1', score: 50, priority: 'B',
  }), { code: 'CRM_ANALYSIS_CONCURRENT_UPDATE' });
  assert.equal(attempts, 5);
  assert.equal(row.qualification_data.whatsapp_menu.initialMessage, 'original');
});
