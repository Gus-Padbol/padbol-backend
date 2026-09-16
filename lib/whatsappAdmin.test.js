import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createWhatsappAdminService,
  operatorReplyIdempotencyKey,
} from './whatsappAdmin.js';
import { resolveWhatsappPermissions } from './whatsappAssistant.js';

const OPERATORS = new Set(['sm@padbol.com']);
const SUPER_ADMIN_EMAILS = new Set([
  'padbolinternacional@gmail.com',
  'admin@padbol.com',
  'sm@padbol.com',
  'juanpablo@padbol.com',
]);

const INBOUND = {
  id: 'in-1',
  tenant_id: 't-1',
  channel_id: 'ch-1',
  provider_message_id: 'wamid.inbound-1',
  from_wa_id: '15551234567',
  text_body: 'Quiero reservar una cancha',
  received_at: '2026-09-14T12:00:00.000Z',
};

function memoryRepository() {
  const outbox = [];
  const classifications = [];
  return {
    outbox,
    classifications,
    async listInbound() {
      return [INBOUND];
    },
    async getInbound(id) {
      return id === INBOUND.id ? INBOUND : null;
    },
    async createOperatorReply({ inbound, body, idempotencyKey }) {
      const row = { id: `out-${outbox.length + 1}`, status: 'pending', inbound, body, idempotencyKey };
      outbox.push(row);
      return row;
    },
    async recordHandoff({ inbound, operatorEmail }) {
      const row = { id: `cl-${classifications.length + 1}`, disposition: 'handoff', inbound, operatorEmail };
      classifications.push(row);
      return row;
    },
    async listAuditActivity() {
      return { inbound: [INBOUND], outbox, classifications, operators: [], config: [] };
    },
  };
}

function service(repo = memoryRepository()) {
  return createWhatsappAdminService({
    repository: repo,
    operators: OPERATORS,
    superAdminEmails: SUPER_ADMIN_EMAILS,
  });
}

async function rejectsForbidden(promise) {
  await assert.rejects(promise, (e) => e?.status === 403 && e?.code === 'WHATSAPP_ADMIN_FORBIDDEN');
}

test('operador (Nicolás) accede a la bandeja y puede atender y derivar', async () => {
  const repo = memoryRepository();
  const svc = service(repo);
  const inbox = await svc.listOperatorInbox({ email: 'sm@padbol.com', role: null });
  assert.equal(inbox.items.length, 1);

  const reply = await svc.operatorReply({
    email: 'sm@padbol.com',
    role: null,
    inboundId: 'in-1',
    body: 'Te ayudamos con la reserva.',
  });
  assert.equal(reply.status, 'pending');
  assert.equal(repo.outbox.length, 1);

  const handoff = await svc.operatorHandoff({ email: 'sm@padbol.com', role: null, inboundId: 'in-1' });
  assert.equal(handoff.disposition, 'handoff');
  assert.equal(repo.classifications.length, 1);
});

test('operador (Nicolás) no accede a la auditoría global', async () => {
  const svc = service();
  await rejectsForbidden(svc.listAudit({ email: 'sm@padbol.com', role: null }));
});

test('superadmin (Gustavo, rol super_admin) accede a la auditoría global', async () => {
  const svc = service();
  const audit = await svc.listAudit({ email: 'padbolinternacional@gmail.com', role: 'super_admin' });
  assert.equal(audit.inbound.length, 1);
});

test('superadmin (Gustavo, email legacy sin fila de rol) accede a la auditoría', async () => {
  const svc = service();
  const audit = await svc.listAudit({ email: 'padbolinternacional@gmail.com', role: null });
  assert.equal(audit.inbound.length, 1);
});

test('superadmin (Gustavo) no puede atender ni derivar como operador', async () => {
  const svc = service();
  await rejectsForbidden(svc.listOperatorInbox({ email: 'padbolinternacional@gmail.com', role: 'super_admin' }));
  await rejectsForbidden(svc.operatorReply({
    email: 'padbolinternacional@gmail.com',
    role: 'super_admin',
    inboundId: 'in-1',
    body: 'No debe salir',
  }));
  await rejectsForbidden(svc.operatorHandoff({
    email: 'padbolinternacional@gmail.com',
    role: 'super_admin',
    inboundId: 'in-1',
  }));
});

test('usuario común no accede a bandeja, acciones ni auditoría', async () => {
  const svc = service();
  await rejectsForbidden(svc.listOperatorInbox({ email: 'otro@x.com', role: null }));
  await rejectsForbidden(svc.operatorReply({ email: 'otro@x.com', role: null, inboundId: 'in-1', body: 'x' }));
  await rejectsForbidden(svc.operatorHandoff({ email: 'otro@x.com', role: null, inboundId: 'in-1' }));
  await rejectsForbidden(svc.listAudit({ email: 'otro@x.com', role: null }));
});

test('legacy superadmin que también es operador queda como operador, no superadmin', () => {
  const perms = resolveWhatsappPermissions({
    email: 'sm@padbol.com',
    role: null,
    operators: OPERATORS,
    superAdminEmails: SUPER_ADMIN_EMAILS,
  });
  assert.equal(perms.role, 'operator');
  assert.equal(perms.canOperate, true);
  assert.equal(perms.canAudit, false);
});

test('email legacy de superadmin sin rol queda como superadmin (compatibilidad)', () => {
  const perms = resolveWhatsappPermissions({
    email: 'padbolinternacional@gmail.com',
    role: null,
    operators: OPERATORS,
    superAdminEmails: SUPER_ADMIN_EMAILS,
  });
  assert.equal(perms.role, 'superadmin');
  assert.equal(perms.canOperate, false);
  assert.equal(perms.canAudit, true);
});

test('endpoint de permisos devuelve el rol efectivo por persona', () => {
  const svc = service();
  assert.deepEqual(
    svc.getPermissions({ email: 'sm@padbol.com', role: null }),
    { role: 'operator', canOperate: true, canAudit: false },
  );
  assert.deepEqual(
    svc.getPermissions({ email: 'padbolinternacional@gmail.com', role: null }),
    { role: 'superadmin', canOperate: false, canAudit: true },
  );
  assert.deepEqual(
    svc.getPermissions({ email: 'otro@x.com', role: null }),
    { role: 'none', canOperate: false, canAudit: false },
  );
});

test('la respuesta del operador es idempotente por contenido', () => {
  const a = operatorReplyIdempotencyKey('t-1', 'in-1', 'Hola');
  const b = operatorReplyIdempotencyKey('t-1', 'in-1', 'Hola');
  const c = operatorReplyIdempotencyKey('t-1', 'in-1', 'Otro');
  assert.equal(a, b);
  assert.notEqual(a, c);
});
