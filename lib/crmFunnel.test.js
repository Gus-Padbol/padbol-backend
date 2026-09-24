import assert from 'node:assert/strict';
import test from 'node:test';

import { CRM_QUALIFIED_HANDOFF_MESSAGE } from './crmService.js';
import { createCrmFunnel, parseCrmFunnelPaths } from './crmFunnel.js';

function harness(paths) {
  const conversation = { id: 'conversation-1', funnel_state: 'awaiting_path', selected_path: null,
    qualification_data: {}, qualification_question_count: 0, next_step: null };
  const replies = [];
  const inboundIds = new Set();
  const crmService = {
    async ingestInbound(input) {
      if (inboundIds.has(input.sourceId)) return { status: 'idempotent', conversation };
      inboundIds.add(input.sourceId);
      return { status: 'accepted', conversation };
    },
    async recordQualificationProgress({ conversationId, ...state }) {
      assert.equal(conversationId, conversation.id);
      Object.assign(conversation, { funnel_state: state.funnelState, selected_path: state.selectedPath ?? null,
        qualification_data: state.qualificationData, qualification_question_count: state.questionsAsked,
        qualification_status: state.qualificationStatus, next_prompt: state.nextPrompt,
        prompt_options: state.promptOptions, next_step: state.nextStep, handoff_ready: state.handoffReady ?? false });
      return { ...conversation };
    },
    async createPendingReply(reply) { replies.push({ ...reply, status: 'pending' }); return replies.at(-1); },
  };
  return { funnel: createCrmFunnel({ crmService, paths }), conversation, replies };
}

const configuredPaths = [{ id: 'club', label: 'Club o complejo deportivo', questions: [
  { id: 'city', field: 'city', prompt: '¿En qué ciudad?', options: [] },
  { id: 'courts', field: 'courts', prompt: '¿Cuántas canchas?', options: ['1', '2 o más'] },
] }, { id: 'regional', label: 'Desarrollo regional', questions: [
  { id: 'has_club', field: 'has_existing_club', prompt: '¿Partís de un club existente?', options: [
    { id: 'yes', label: 'Sí', value: true }, { id: 'no', label: 'No', value: false },
  ] },
] }];

let sequence = 0;
function inbound(body) {
  sequence += 1;
  return { providerMessageId: `wamid.${sequence}`, phoneNumberId: '123456789',
    fromWaId: '5492215550101', body, receivedAt: '2026-09-17T12:00:00Z' };
}

test('embudo WhatsApp persiste camino, respuestas y club; cada salida queda pending', async () => {
  const h = harness(configuredPaths);
  await h.funnel.ingestWhatsapp(inbound('Hola'));
  assert.equal(h.conversation.funnel_state, 'awaiting_path');
  assert.equal(h.conversation.prompt_options.length, 2);
  await h.funnel.ingestWhatsapp(inbound('1'));
  assert.equal(h.conversation.next_step, 'city');
  await h.funnel.ingestWhatsapp(inbound('Córdoba'));
  await h.funnel.ingestWhatsapp(inbound('2'));
  assert.equal(h.conversation.qualification_question_count, 2);
  assert.equal(h.conversation.next_step, 'club_name');
  await h.funnel.ingestWhatsapp(inbound('Club Central'));
  await h.funnel.ingestWhatsapp(inbound('Córdoba, Argentina'));
  assert.equal(h.conversation.qualification_status, 'qualified');
  assert.equal(h.conversation.handoff_ready, true);
  assert.equal(h.conversation.qualification_data.club_name, 'Club Central');
  assert.equal(h.conversation.qualification_data.club_location, 'Córdoba, Argentina');
  assert.equal(h.replies.at(-1).body, CRM_QUALIFIED_HANDOFF_MESSAGE);
  assert.ok(h.replies.every((reply) => reply.status === 'pending'));
});

test('seguimiento de club sólo aparece cuando el camino lo declara', async () => {
  const withoutClub = harness(configuredPaths);
  await withoutClub.funnel.ingestWhatsapp(inbound('hola'));
  await withoutClub.funnel.ingestWhatsapp(inbound('regional'));
  await withoutClub.funnel.ingestWhatsapp(inbound('no'));
  assert.equal(withoutClub.conversation.handoff_ready, true);
  assert.equal(withoutClub.conversation.next_step, 'advisor_handoff');
  const withClub = harness(configuredPaths);
  await withClub.funnel.ingestWhatsapp(inbound('hola'));
  await withClub.funnel.ingestWhatsapp(inbound('regional'));
  await withClub.funnel.ingestWhatsapp(inbound('yes'));
  assert.equal(withClub.conversation.next_step, 'club_name');
  assert.equal(withClub.conversation.qualification_question_count, 1);
});

test('configuración inválida falla cerrada sin inventar caminos', () => {
  assert.deepEqual(parseCrmFunnelPaths('{bad json'), []);
  assert.deepEqual(parseCrmFunnelPaths([{ id: 'x', label: 'X', questions: new Array(4).fill({
    id: 'q', field: 'f', prompt: 'P',
  }) }]), []);
});

test('sin embudo configurado igualmente registra el mensaje en la bandeja CRM', async () => {
  const h = harness([]);
  const result = await h.funnel.ingestWhatsapp(inbound('Prueba'));
  assert.equal(result.conversation.id, h.conversation.id);
  assert.equal(result.response, null);
  assert.equal(h.replies.length, 0);
});
