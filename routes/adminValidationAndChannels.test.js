import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCrmChannelStatus, mountAdminValidationAndChannelsRoutes } from './adminValidationAndChannels.js';

test('C-01 informa configuración real sin exponer secretos', () => {
  const status = buildCrmChannelStatus({
    OUTBOUND_DELIVERY_ENABLED: 'true', WHATSAPP_CLOUD_SEND_ENABLED: 'true',
    WHATSAPP_META_GRAPH_VERSION: 'v26.0', WHATSAPP_META_APP_SECRET: 'secret',
    WHATSAPP_META_VERIFY_TOKEN: 'verify', WHATSAPP_META_ACCESS_TOKEN: 'token',
    CRM_OUTBOUND_EMAIL_ENABLED: 'false',
  });
  assert.equal(status.whatsapp.enabled, true);
  assert.equal(status.email.enabled, false);
  assert.equal(status.human_action_required, true);
  assert(!JSON.stringify(status).includes('secret'));
  assert(!JSON.stringify(status).includes('token'));
});

test('V-01 registra endpoint seguro de rechazo y exige autenticación', async () => {
  const routes = new Map();
  const app = {
    patch(path, handler) { routes.set(`PATCH ${path}`, handler); },
    get(path, handler) { routes.set(`GET ${path}`, handler); },
  };
  mountAdminValidationAndChannelsRoutes(app, {
    supabaseAdmin: {},
    getAuthenticatedUser: async () => ({ user: null, status: 401, error: 'No autorizado' }),
    fetchUserRoleRowForAuthUser: async () => null,
  });
  assert(routes.has('PATCH /api/admin/validaciones/:userId/rechazar'));
  assert(routes.has('GET /api/admin/crm/channel-status'));
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await routes.get('PATCH /api/admin/validaciones/:userId/rechazar')({ params: { userId: 'u1' }, body: { motivo: 'No corresponde' } }, response);
  assert.equal(response.statusCode, 401);
});
