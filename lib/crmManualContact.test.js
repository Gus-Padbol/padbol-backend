import test from 'node:test';
import assert from 'node:assert/strict';
import { createCrmAdminService, registerCrmAdminRoutes } from './crmAdmin.js';
import { createSupabaseCrmRepository } from './crmService.js';

const input = { name: 'Manual Contact', email: ' CONTACT@example.test ', phone: '+54 (911) 1234-5678' };
const operator = { email: 'operator@example.test', role: null };
function setup(rows = []) {
  const writes = [];
  const repository = {
    async findContactsByEmailOrPhone(email, phone) { return rows.filter(row => row.email_normalized === email || row.phone_normalized === phone); },
    async createManualContactRecord(payload) { writes.push(payload); return { created: true, contact: { id: 'persisted-id', ...payload } }; },
  };
  const service = createCrmAdminService({ repository, operators: new Set([operator.email]), superAdminEmails: new Set(['auditor@example.test']) });
  return { repository, writes, service };
}

test('manual contact persists only supported normalized contact fields and returns stored identity', async () => {
  const { service, writes } = setup();
  const result = await service.createManual({ ...operator, input });
  assert.equal(result.existing, false);
  assert.deepEqual(result.contact, { id: 'persisted-id', nombre: 'Manual Contact', email_normalized: 'contact@example.test', phone_normalized: '5491112345678' });
  assert.deepEqual(Object.keys(writes[0]).sort(), ['email_normalized', 'nombre', 'phone_normalized', 'review_needed']);
});

test('normal users and audit-only superadmins cannot manually register contacts', async () => {
  const { service, writes } = setup();
  for (const caller of [{ email: 'normal@example.test', role: 'jugador' }, { email: 'auditor@example.test', role: 'super_admin' }]) {
    await assert.rejects(service.createManual({ ...caller, input }), e => e.status === 403);
  }
  assert.equal(writes.length, 0);
});

test('manual validation rejects invalid contact and fields that would otherwise be silently lost', async () => {
  const { service, writes } = setup();
  for (const data of [null, { ...input, name: '' }, { ...input, name: {} }, { ...input, email: 'a@b' }, { ...input, phone: 'letters12345678' }, { ...input, phone: '123' }, { name: 'Name' }, { ...input, body: 'Not persisted' }, { ...input, origin: 'in_person' }, { ...input, sede_id: 'arbitrary' }]) {
    await assert.rejects(service.createManual({ ...operator, input: data }), e => e.status === 400);
  }
  assert.equal(writes.length, 0);
});

test('normalized duplicates return prior persisted fields without overwriting names or identity', async () => {
  const row = { id: 'prior-id', nombre: 'Existing Name', email_normalized: 'contact@example.test', phone_normalized: '5491112345678' };
  const { service, writes } = setup([row]);
  const result = await service.createManual({ ...operator, input });
  assert.equal(result.existing, true); assert.deepEqual(result.contact, row); assert.equal(writes.length, 0);
});

test('ambiguous identities and storage failures fail closed without claiming a saved contact', async () => {
  const { service, writes } = setup([{ id: 'a', email_normalized: 'contact@example.test' }, { id: 'b', phone_normalized: '5491112345678' }]);
  await assert.rejects(service.createManual({ ...operator, input }), e => e.status === 409); assert.equal(writes.length, 0);
  const failed = setup(); failed.repository.createManualContactRecord = async () => { throw Object.assign(Error('Unavailable'), { status: 503 }); };
  await assert.rejects(failed.service.createManual({ ...operator, input }), e => e.status === 503);
});

test('route rejects unauthenticated callers before persistence and returns a saved contact receipt', async () => {
  const routes = new Map(), { service, writes } = setup(); let user = null;
  const app = { get() {}, post(path, handler) { routes.set(path, handler); } };
  registerCrmAdminRoutes(app, { crmAdminService: service, authUserFromBearer: async () => user, fetchUserRoleRow: async () => ({ role: null }), logger: { error() {} } });
  const response = () => ({ code: 200, body: null, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } });
  const denied = response(); await routes.get('/api/admin/crm/manual')({ body: input }, denied);
  assert.equal(denied.code, 401); assert.equal(writes.length, 0);
  user = operator; const saved = response(); await routes.get('/api/admin/crm/manual')({ body: input }, saved);
  assert.equal(saved.code, 201); assert.equal(saved.body.contact.id, 'persisted-id');
});

test('repository handles concurrent unique contact claims by rereading, never updating existing data', async () => {
  const prior = { id: 'prior', email_normalized: 'contact@example.test', phone_normalized: '5491112345678' };
  const client = { from(table) {
    assert.equal(table, 'crm_contacts');
    return { insert() { return { select() { return { async single() { return { error: { code: '23505' } }; } }; } }; }, select() { return { eq() { return { async limit() { return { data: [prior] }; } }; } }; } };
  } };
  const result = await createSupabaseCrmRepository(client).createManualContactRecord({ email_normalized: prior.email_normalized, phone_normalized: prior.phone_normalized });
  assert.equal(result.created, false); assert.equal(result.contact.id, 'prior');
});
