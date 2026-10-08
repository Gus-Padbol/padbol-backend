import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { registerWhatsappAdminRoutes } from './whatsappAdmin.js';
import { registerCrmAdminRoutes } from './crmAdmin.js';

test('legacy WhatsApp mounted first does not shadow unified CRM inbox or permissions', async () => {
  const app = express();
  const auth = {
    authUserFromBearer: async () => ({ id: 'fixture-user', email: 'auditor@example.invalid' }),
    fetchUserRoleRow: async () => ({ role: 'super_admin' }),
  };
  const conversations = [{ id: 'stored-crm-contact', source_channel: 'email', inbound_body: 'Historical inquiry' }];
  registerWhatsappAdminRoutes(app, {
    ...auth,
    whatsappAdminService: {
      getPermissions: () => ({ legacy: true }),
      listCrmInbox: async () => ({ items: [] }),
    },
  });
  registerCrmAdminRoutes(app, {
    ...auth,
    crmAdminService: {
      getPermissions: () => ({ canAudit: true, canOperate: false, whatsappSendEnabled: false }),
      listInbox: async () => conversations,
    },
  });
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  try {
    const inbox = await fetch(`${origin}/api/admin/crm/inbox`);
    assert.equal(inbox.status, 200);
    assert.deepEqual(await inbox.json(), conversations);
    const permissions = await fetch(`${origin}/api/admin/crm/permissions`);
    assert.deepEqual(await permissions.json(), { canAudit: true, canOperate: false, whatsappSendEnabled: false });
    const legacy = await fetch(`${origin}/api/admin/whatsapp/crm-events`);
    assert.deepEqual(await legacy.json(), { items: [] });
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
