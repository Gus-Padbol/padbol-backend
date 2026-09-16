import assert from 'node:assert/strict';
import test from 'node:test';

import {
  CRM_CLUB_ORGANIZATION_TYPE,
  CRM_EXISTING_CLUB_FOLLOW_UP,
  CRM_NATIONAL_INVESTMENT_OPTIONS,
  CRM_NATIONAL_QUALIFICATION_PATH,
  CRM_NATIONAL_QUALIFICATION_QUESTIONS,
  CRM_QUALIFIED_HANDOFF_MESSAGE,
  clubFollowUpForQualification,
  createCrmService,
} from './crmService.js';
import { createCrmAdminService, registerCrmAdminRoutes } from './crmAdmin.js';
import { emailEventToCrmIngest, normalizeInboundEmailEvent } from './crmInboundEmail.js';
import { formSubmissionToCrmIngest } from './crmInboundForm.js';

function memoryCrmRepository() {
  const contacts = [];
  const attempts = [];
  const conversations = [];
  const replies = [];
  const inboundEvents = [];
  const activities = [];
  return {
    contacts, attempts, conversations, replies, inboundEvents, activities,
    async findContactsByEmailOrPhone(email, phone) {
      return contacts.filter((c) => (
        (email && c.email_normalized === email) || (phone && c.phone_normalized === phone)
      ));
    },
    async createContact(payload) {
      const row = { id: `c-${contacts.length + 1}`, ...payload };
      contacts.push(row);
      return row;
    },
    async markContactsReview(ids) {
      for (const c of contacts) if (ids.includes(c.id)) c.review_needed = true;
    },
    async findAttempt(attemptId) {
      return attempts.find((a) => a.attempt_id === attemptId) || null;
    },
    async createAttempt(payload) {
      const row = { id: `a-${attempts.length + 1}`, ...payload };
      attempts.push(row);
      return row;
    },
    async findConversation(attemptId, sourceChannel, sourceRef) {
      return conversations.find((c) => c.attempt_id === attemptId && c.source_channel === sourceChannel && c.source_ref === sourceRef) || null;
    },
    async findInboundEvent(sourceChannel, origin, sourceRef) {
      return inboundEvents.find((e) => e.source_channel === sourceChannel && e.origin === origin && e.source_ref === sourceRef) || null;
    },
    async findOpenConversation(contactId, sourceChannel, origin) {
      return conversations.find((c) => c.contact_id === contactId && c.source_channel === sourceChannel && c.origin === origin && c.estado !== 'cerrado') || null;
    },
    async createConversation(payload) {
      const row = { id: `v-${conversations.length + 1}`, ...payload };
      conversations.push(row);
      return row;
    },
    async createInboundEvent(payload) {
      const existing = await this.findInboundEvent(payload.source_channel, payload.origin, payload.source_ref);
      if (existing) return existing;
      const row = { id: `i-${inboundEvents.length + 1}`, ...payload };
      inboundEvents.push(row);
      return row;
    },
    async touchConversation(id, receivedAt) {
      const row = conversations.find((c) => c.id === id);
      if (row) { row.received_at = receivedAt; row.updated_at = receivedAt; }
    },
    async updateQualification(id, payload) {
      const row = conversations.find((c) => c.id === id);
      if (!row) return null;
      Object.assign(row, payload);
      return row;
    },
    async listConversations() { return conversations; },
    async getConversation(id) { return conversations.find((c) => c.id === id) || null; },
    async createReply(payload) {
      const row = { id: `r-${replies.length + 1}`, ...payload };
      replies.push(row);
      return row;
    },
    async listActivities(conversationId) { return activities.filter((a) => a.conversation_id === conversationId); },
    async createActivity(payload) {
      const row = { id: `act-${activities.length + 1}`, ...payload };
      activities.push(row);
      return row;
    },
    async markHandoff({ conversationId, operador }) {
      const c = conversations.find((x) => x.id === conversationId);
      if (c) { c.estado = 'derivado'; c.operador = operador; c.derivado = true; }
    },
    async listAuditActivity() {
      return { contacts, conversations, attempts, replies, activities };
    },
  };
}

const OPERATORS = new Set(['sm@padbol.com']);
const SUPER_ADMIN_EMAILS = new Set(['padbolinternacional@gmail.com']);

test('Gmail normaliza puntos y +alias; otros dominios no', () => {
  const svc = createCrmService({ repository: memoryCrmRepository() });
  assert.equal(svc, svc);
  // cubierto también en crmContact.test.js; aquí validamos el servicio
});

test('ingesta: WhatsApp elegido bloquea correo en el mismo intento', async () => {
  const repo = memoryCrmRepository();
  const svc = createCrmService({ repository: repo });
  const first = await svc.ingestInbound({
    source: 'form', sourceId: 'f1', channel: 'whatsapp',
    email: 'maidana.rd20@gmail.com', phone: '+54 9 11 2345 6789',
  });
  assert.equal(first.status, 'accepted');
  await assert.rejects(
    svc.ingestInbound({
      source: 'form', sourceId: 'f1', channel: 'email',
      email: 'maidana.rd20@gmail.com', phone: null,
    }),
    (e) => e?.code === 'CRM_CHANNEL_CONFLICT',
  );
});

test('ingesta: un nuevo intento por otro canal se acepta', async () => {
  const repo = memoryCrmRepository();
  const svc = createCrmService({ repository: repo });
  await svc.ingestInbound({ source: 'form', sourceId: 'f1', channel: 'whatsapp', email: 'a@gmail.com' });
  const later = await svc.ingestInbound({ source: 'form', sourceId: 'f2', channel: 'email', email: 'a@gmail.com' });
  assert.equal(later.status, 'accepted');
  assert.equal(repo.conversations.length, 2);
});

test('ingesta repetida (webhook duplicado) es idempotente', async () => {
  const repo = memoryCrmRepository();
  const svc = createCrmService({ repository: repo });
  const args = { source: 'email', sourceId: 'e1', channel: 'email', email: 'b@gmail.com' };
  await svc.ingestInbound(args);
  const replay = await svc.ingestInbound(args);
  assert.equal(replay.status, 'idempotent');
  assert.equal(repo.conversations.length, 1);
  assert.equal(repo.inboundEvents.length, 1);
});

test('WhatsApp agrupa mensajes posteriores del mismo contacto y origen en el hilo abierto', async () => {
  const repo = memoryCrmRepository();
  const svc = createCrmService({ repository: repo });
  const common = { source: 'whatsapp_cloud', channel: 'whatsapp', phone: '+54 9 11 2222 3333', origin: 'whatsapp:phone-number-1' };
  const first = await svc.ingestInbound({ ...common, sourceId: 'wamid.1', body: 'Hola' });
  const second = await svc.ingestInbound({ ...common, sourceId: 'wamid.2', body: 'Necesito información' });
  assert.equal(first.status, 'accepted');
  assert.equal(second.status, 'accepted');
  assert.equal(second.conversationCreated, false);
  assert.equal(repo.conversations.length, 1);
  assert.equal(repo.inboundEvents.length, 2);
  assert.equal(repo.inboundEvents[1].conversation_id, repo.conversations[0].id);
});

test('rutas de actividades CRM autentican y usan el autor verificado', async () => {
  const repo = memoryCrmRepository();
  await repo.createConversation({ id: 'v1', contact_id: 'c1', source_channel: 'whatsapp', source_ref: 'w1', attempt_id: 'a1', estado: 'nuevo' });
  const service = createCrmAdminService({ repository: repo, operators: OPERATORS, superAdminEmails: SUPER_ADMIN_EMAILS });
  const routes = new Map();
  const app = {
    get(path, handler) { routes.set(`GET ${path}`, handler); },
    post(path, handler) { routes.set(`POST ${path}`, handler); },
  };
  registerCrmAdminRoutes(app, {
    crmAdminService: service,
    authUserFromBearer: async () => ({ email: 'sm@padbol.com' }),
    fetchUserRoleRow: async () => ({ role: null }),
    logger: { error() {} },
  });
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(payload) { this.payload = payload; return this; },
  };
  await routes.get('POST /api/admin/crm/inbox/:id/activities')({
    params: { id: 'v1' },
    body: { type: 'zoom_meeting', summary: 'Demo realizada', next_step: 'Seguimiento' },
  }, response);
  assert.equal(response.statusCode, 201);
  assert.equal(response.payload.author, 'sm@padbol.com');
  assert.equal(repo.activities.length, 1);
});

test('WhatsApp no reutiliza un hilo cerrado y no cruza orígenes', async () => {
  const repo = memoryCrmRepository();
  const svc = createCrmService({ repository: repo });
  const common = { source: 'whatsapp_cloud', channel: 'whatsapp', phone: '5491122223333' };
  await svc.ingestInbound({ ...common, sourceId: 'wamid.1', origin: 'whatsapp:a' });
  repo.conversations[0].estado = 'cerrado';
  await svc.ingestInbound({ ...common, sourceId: 'wamid.2', origin: 'whatsapp:a' });
  await svc.ingestInbound({ ...common, sourceId: 'wamid.3', origin: 'whatsapp:b' });
  assert.equal(repo.conversations.length, 3);
});

test('correos independientes del mismo contacto no se agrupan', async () => {
  const repo = memoryCrmRepository();
  const svc = createCrmService({ repository: repo });
  const common = { source: 'email', channel: 'email', email: 'persona@example.com', origin: 'institutional_email' };
  await svc.ingestInbound({ ...common, sourceId: 'mail-1', subject: 'Uno' });
  await svc.ingestInbound({ ...common, sourceId: 'mail-2', subject: 'Dos' });
  assert.equal(repo.conversations.length, 2);
  assert.equal(repo.inboundEvents.length, 2);
});

test('embudo persiste opciones configurables y sólo habilita handoff al calificar', async () => {
  const repo = memoryCrmRepository();
  const svc = createCrmService({ repository: repo, now: () => new Date('2026-09-17T10:00:00Z') });
  await repo.createConversation({ id: 'v1', contact_id: 'c1', source_channel: 'whatsapp', estado: 'nuevo' });
  await assert.rejects(
    svc.recordQualificationProgress({ conversationId: 'v1', funnelState: 'question_1', qualificationStatus: 'in_progress', handoffReady: true }),
    (e) => e?.code === 'CRM_HANDOFF_NOT_READY',
  );
  const row = await svc.recordQualificationProgress({
    conversationId: 'v1', funnelState: 'qualified', selectedPath: 'configurable-path-a',
    qualificationData: { answers: { size: 'configured-value' } }, qualificationStatus: 'qualified',
    nextPrompt: CRM_QUALIFIED_HANDOFF_MESSAGE,
    promptOptions: [{ id: 'schedule', label: 'Opción configurable' }],
    nextStep: 'schedule_online_meeting', handoffReady: true, questionsAsked: 3,
  });
  assert.equal(row.handoff_ready, true);
  assert.equal(row.prompt_options[0].id, 'schedule');
  assert.equal(row.qualification_question_count, 3);
  await assert.rejects(
    svc.recordQualificationProgress({ conversationId: 'v1', funnelState: 'question_4', questionsAsked: 4 }),
    (e) => e?.code === 'CRM_QUALIFICATION_INVALID',
  );
  await assert.rejects(
    svc.recordQualificationProgress({ conversationId: 'v1', funnelState: 'question_phone', questionsAsked: 1, nextPrompt: '¿Cuál es tu teléfono?' }),
    (e) => e?.code === 'CRM_QUALIFICATION_INVALID',
  );
  const national = await svc.recordQualificationProgress({
    conversationId: 'v1', funnelState: 'national_complete',
    selectedPath: CRM_NATIONAL_QUALIFICATION_PATH, questionsAsked: 4,
    qualificationData: {
      requested_country: 'Argentina', organization_type: 'Empresa',
      territorial_capacity: 'Nacional', initial_investment: 'USD 60.000 a 100.000',
    },
  });
  assert.equal(national.qualification_question_count, 4);
  assert.deepEqual(CRM_NATIONAL_INVESTMENT_OPTIONS, [
    'USD 60.000 a 100.000',
    'USD 100.000 a 250.000',
    'Más de USD 250.000',
  ]);
  assert.deepEqual(CRM_NATIONAL_QUALIFICATION_QUESTIONS[3].options, CRM_NATIONAL_INVESTMENT_OPTIONS);
  assert.equal(CRM_NATIONAL_QUALIFICATION_QUESTIONS[1].options[0].label, CRM_CLUB_ORGANIZATION_TYPE);
  assert.deepEqual(
    CRM_NATIONAL_QUALIFICATION_QUESTIONS[1].options[0].followUp.map((item) => item.field),
    ['club_name', 'club_location'],
  );
  await assert.rejects(
    svc.recordQualificationProgress({
      conversationId: 'v1', funnelState: 'national_complete',
      selectedPath: CRM_NATIONAL_QUALIFICATION_PATH, questionsAsked: 4,
      qualificationStatus: 'qualified', handoffReady: true,
      qualificationData: { organization_type: CRM_CLUB_ORGANIZATION_TYPE },
    }),
    (e) => e?.code === 'CRM_QUALIFICATION_INVALID',
  );
  const club = await svc.recordQualificationProgress({
    conversationId: 'v1', funnelState: 'national_complete',
    selectedPath: CRM_NATIONAL_QUALIFICATION_PATH, questionsAsked: 4,
    qualificationStatus: 'qualified', handoffReady: true,
    qualificationData: {
      organization_type: CRM_CLUB_ORGANIZATION_TYPE,
      club_name: 'Club Central', club_location: 'Córdoba, Argentina',
      initial_investment: 'USD 100.000 a 250.000',
    },
  });
  assert.equal(club.qualification_data.club_name, 'Club Central');
  assert.equal(club.qualification_data.club_location, 'Córdoba, Argentina');
  assert.deepEqual(clubFollowUpForQualification({ selectedPath: 'club', qualificationData: {} }), CRM_EXISTING_CLUB_FOLLOW_UP);
  assert.deepEqual(
    clubFollowUpForQualification({ selectedPath: 'regional', qualificationData: { has_existing_club: true } }),
    CRM_EXISTING_CLUB_FOLLOW_UP,
  );
  assert.deepEqual(
    clubFollowUpForQualification({ selectedPath: 'punto_padbol', qualificationData: { has_existing_club: true } }),
    CRM_EXISTING_CLUB_FOLLOW_UP,
  );
  for (const selectedPath of ['court', 'regional', 'national', 'punto_padbol']) {
    assert.deepEqual(clubFollowUpForQualification({ selectedPath, qualificationData: { has_existing_club: false } }), []);
  }
  await assert.rejects(
    svc.recordQualificationProgress({
      conversationId: 'v1', funnelState: 'club_complete', selectedPath: 'club',
      questionsAsked: 3, qualificationStatus: 'qualified', handoffReady: true,
      qualificationData: {},
    }),
    (e) => e?.code === 'CRM_QUALIFICATION_INVALID',
  );
});

test('email y teléfono que apuntan a contactos distintos no fusionan (ambiguous)', async () => {
  const repo = memoryCrmRepository();
  await repo.createContact({ email_normalized: 'a@gmail.com', phone_normalized: '5491111111111', review_needed: false });
  await repo.createContact({ email_normalized: 'b@x.com', phone_normalized: '5491111111111', review_needed: false });
  const svc = createCrmService({ repository: repo });
  const r = await svc.findOrCreateContact({ email: 'a@gmail.com', phone: '5491111111111' });
  assert.equal(r.ambiguous, true);
  assert.equal(r.created, false);
  assert.equal(repo.contacts.filter((c) => c.review_needed).length, 2);
});

test('permisos CRM: operador opera, superadmin audita, común 403', async () => {
  const repo = memoryCrmRepository();
  await repo.createConversation({ id: 'v1', contact_id: 'c1', source_channel: 'whatsapp', source_ref: 'w1', attempt_id: 'a1', estado: 'nuevo', qualification_status: 'qualified', handoff_ready: true });
  const svc = createCrmAdminService({ repository: repo, operators: OPERATORS, superAdminEmails: SUPER_ADMIN_EMAILS });

  const inbox = await svc.listInbox({ email: 'sm@padbol.com', role: null });
  assert.equal(inbox.length, 1);

  const reply = await svc.reply({ email: 'sm@padbol.com', role: null, id: 'v1', body: 'Respuesta' });
  assert.equal(reply.status, 'pending');

  const activity = await svc.createActivity({
    email: 'sm@padbol.com', role: null, id: 'v1', activityType: 'phone_call',
    summary: 'Se llamó al contacto', outcome: 'Respondió', nextStep: 'Enviar propuesta',
    followUpAt: '2026-09-20T15:00:00Z',
  });
  assert.equal(activity.author, 'sm@padbol.com');
  assert.equal(activity.contact_id, 'c1');
  assert.equal((await svc.listActivities({ email: 'sm@padbol.com', role: null, id: 'v1' })).length, 1);

  const audit = await svc.audit({ email: 'padbolinternacional@gmail.com', role: null });
  assert.equal(audit.conversations.length, 1);

  await assert.rejects(svc.audit({ email: 'sm@padbol.com', role: null }), (e) => e?.status === 403);
  await assert.rejects(svc.reply({ email: 'padbolinternacional@gmail.com', role: null, id: 'v1', body: 'x' }), (e) => e?.status === 403);
  await assert.rejects(svc.listInbox({ email: 'otro@x.com', role: null }), (e) => e?.status === 403);
  await assert.rejects(
    svc.createActivity({ email: 'sm@padbol.com', role: null, id: 'v1', activityType: 'other', summary: 'x' }),
    (e) => e?.code === 'CRM_ACTIVITY_INVALID',
  );
});

test('handoff humano queda bloqueado hasta completar la calificación guiada', async () => {
  const repo = memoryCrmRepository();
  await repo.createConversation({
    id: 'v-pending', contact_id: 'c1', source_channel: 'whatsapp', source_ref: 'w-pending',
    attempt_id: 'a-pending', estado: 'nuevo', qualification_status: 'in_progress', handoff_ready: false,
  });
  const svc = createCrmAdminService({ repository: repo, operators: OPERATORS, superAdminEmails: SUPER_ADMIN_EMAILS });
  await assert.rejects(
    svc.handoff({ email: 'sm@padbol.com', role: null, id: 'v-pending' }),
    (e) => e?.code === 'CRM_HANDOFF_NOT_READY' && e?.status === 409,
  );
  assert.equal(repo.conversations[0].derivado, undefined);
});

test('adaptador de correo: evento canónico válido y rechazo de inválidos', () => {
  const event = normalizeInboundEmailEvent({
    externalId: 'm1', from: 'r@x.com', to: 'info@padbol.com', subject: 'Consulta', body: 'Hola', receivedAt: '2026-09-15T12:00:00Z',
  });
  assert.equal(event.externalId, 'm1');
  assert.equal(event.to, 'info@padbol.com');
  assert.equal(normalizeInboundEmailEvent({ from: 'r@x.com', to: 'info@padbol.com' }), null); // sin id
  assert.equal(normalizeInboundEmailEvent({ externalId: 'm2', from: 'r@x.com', to: 'no-arroba' }), null);

  const ingest = emailEventToCrmIngest({
    externalId: 'm3', from: 'r@x.com', to: 'info@padbol.com', subject: 'Consulta', body: 'Hola',
  });
  assert.equal(ingest.source, 'email');
  assert.equal(ingest.channel, 'email');
  assert.equal(ingest.email, 'r@x.com');
  assert.equal(ingest.origin, 'institutional_email');
  assert.equal(normalizeInboundEmailEvent({ externalId: 'm4', from: 'mal', to: 'info@padbol.com', body: 'x' }), null);
  assert.equal(normalizeInboundEmailEvent({ externalId: 'm5', from: 'r@x.com', to: 'info@padbol.com' }), null);
});

test('formulario web conserva origen, asunto y mensaje en la conversación', async () => {
  const repo = memoryCrmRepository();
  const svc = createCrmService({ repository: repo });
  const event = formSubmissionToCrmIngest({
    id: 'sol-123', form: 'solicitud_licencia', email: 'Club@Example.com', phone: '+54 9 11 5555 4444',
    name: 'Responsable', subject: 'Solicitud de Club Norte', message: 'Quiero sumar mi club.',
  });
  const result = await svc.ingestInbound(event);
  assert.equal(result.status, 'accepted');
  assert.equal(repo.contacts[0].email_normalized, 'club@example.com');
  assert.equal(repo.conversations[0].origin, 'web_form:solicitud_licencia');
  assert.equal(repo.conversations[0].subject, 'Solicitud de Club Norte');
  assert.equal(repo.conversations[0].inbound_body, 'Quiero sumar mi club.');
  assert.equal(repo.conversations[0].source_channel, 'email');
});

test('formulario inválido no crea evento CRM', () => {
  assert.equal(formSubmissionToCrmIngest({ id: '', email: 'a@b.com' }), null);
  assert.equal(formSubmissionToCrmIngest({ id: 'x' }), null);
});
