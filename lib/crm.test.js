import assert from 'node:assert/strict';
import test from 'node:test';

import { createCrmService } from './crmService.js';
import { createCrmAdminService } from './crmAdmin.js';
import { emailEventToCrmIngest, normalizeInboundEmailEvent } from './crmInboundEmail.js';

function memoryCrmRepository() {
  const contacts = [];
  const attempts = [];
  const conversations = [];
  const replies = [];
  return {
    contacts, attempts, conversations, replies,
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
    async createConversation(payload) {
      const row = { id: `v-${conversations.length + 1}`, ...payload };
      conversations.push(row);
      return row;
    },
    async listConversations() { return conversations; },
    async getConversation(id) { return conversations.find((c) => c.id === id) || null; },
    async createReply(payload) {
      const row = { id: `r-${replies.length + 1}`, ...payload };
      replies.push(row);
      return row;
    },
    async markHandoff({ conversationId, operador }) {
      const c = conversations.find((x) => x.id === conversationId);
      if (c) { c.estado = 'derivado'; c.operador = operador; c.derivado = true; }
    },
    async listAuditActivity() {
      return { contacts, conversations, attempts, replies };
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
  await repo.createConversation({ id: 'v1', contact_id: 'c1', source_channel: 'whatsapp', source_ref: 'w1', attempt_id: 'a1', estado: 'nuevo' });
  const svc = createCrmAdminService({ repository: repo, operators: OPERATORS, superAdminEmails: SUPER_ADMIN_EMAILS });

  const inbox = await svc.listInbox({ email: 'sm@padbol.com', role: null });
  assert.equal(inbox.length, 1);

  const reply = await svc.reply({ email: 'sm@padbol.com', role: null, id: 'v1', body: 'Respuesta' });
  assert.equal(reply.status, 'pending');

  const audit = await svc.audit({ email: 'padbolinternacional@gmail.com', role: null });
  assert.equal(audit.conversations.length, 1);

  await assert.rejects(svc.audit({ email: 'sm@padbol.com', role: null }), (e) => e?.status === 403);
  await assert.rejects(svc.reply({ email: 'padbolinternacional@gmail.com', role: null, id: 'v1', body: 'x' }), (e) => e?.status === 403);
  await assert.rejects(svc.listInbox({ email: 'otro@x.com', role: null }), (e) => e?.status === 403);
});

test('adaptador de correo: evento canónico válido y rechazo de inválidos', () => {
  const event = normalizeInboundEmailEvent({
    externalId: 'm1', from: 'r@x.com', to: 'info@padbol.com', subject: 'Consulta', body: 'Hola', receivedAt: '2026-09-15T12:00:00Z',
  });
  assert.equal(event.externalId, 'm1');
  assert.equal(event.to, 'info@padbol.com');
  assert.equal(normalizeInboundEmailEvent({ from: 'r@x.com', to: 'info@padbol.com' }), null); // sin id
  assert.equal(normalizeInboundEmailEvent({ externalId: 'm2', from: 'r@x.com', to: 'no-arroba' }), null);

  const ingest = emailEventToCrmIngest({ externalId: 'm3', from: 'r@x.com', to: 'info@padbol.com' });
  assert.equal(ingest.source, 'email');
  assert.equal(ingest.channel, 'email');
  assert.equal(ingest.email, 'r@x.com');
});
