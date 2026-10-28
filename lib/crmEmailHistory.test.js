import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {loadCrmEmailHistory} from './crmEmailHistory.js';
import {createSupabaseCrmRepository} from './crmService.js';
import {createCrmAdminService, registerCrmAdminRoutes} from './crmAdmin.js';
import {createCommercialTeamApi, registerCommercialTeamRoutes} from './crmCommercialTeamApi.js';
import {CRM_COMMERCIAL_OPERATORS, CRM_COMMERCIAL_FORM_ORIGINS} from './crmCommercialScope.js';

const id = '11111111-1111-4111-8111-111111111111', other = '22222222-2222-4222-8222-222222222222';
const nico = {...CRM_COMMERCIAL_OPERATORS[0], role: 'admin_nacional'};
const user = {id: nico.userId, email: nico.email};
const lead = {id, source_channel: 'email', origin: CRM_COMMERCIAL_FORM_ORIGINS[0], inbound_body: 'Mensaje original sin cambiar', qualification_data: {routing: {workflow: 'commercial_lead'}}};
function database({many = false, error = false} = {}) {
  const queries = [];
  const inbound = [{id: 'inbound', conversation_id: id, source_channel: 'email', body: 'Podemos hablar el martes.', subject: 'Re: consulta', received_at: '2026-10-28T12:00:00Z', private_provider_field: 'must-not-leak'}, {id: 'foreign', conversation_id: other, source_channel: 'email', body: 'Foreign lead'}, {id: 'wa', conversation_id: id, source_channel: 'whatsapp', body: 'Other channel'}];
  if (many) for (let n = 0; n < 200; n++) inbound.push({...inbound[0], id: 'incoming-' + n});
  const outbound = [{id: 'outbound', conversation_id: id, body: 'Primera respuesta enviada', status: 'sent', created_at: '2026-10-27T11:00:00Z', provider_message_id: 'secret-provider-id'}];
  const db = {from(table) {const q = {table, filters: [], orders: []}; queries.push(q); const b = {select(fields) {q.fields = fields; return b;}, eq(k, v) {q.filters.push([k, v]); return b;}, order(k, v) {q.orders.push([k, v]); return b;}, limit(n) {q.limit = n; return b;}, then(resolve) {return Promise.resolve({error: error ? {message: 'private database failure'} : null, data: (table === 'crm_inbound_events' ? inbound : outbound).filter(row => q.filters.every(([k, v]) => row[k] === v)).slice(0, q.limit)}).then(resolve);}}; return b;}};
  return {db, queries};
}
test('repository reads exact conversation and email channel, preserves text and limits output to safe fields', async () => {
  const f = database(), history = await createSupabaseCrmRepository(f.db).listEmailHistory(id);
  assert.deepEqual(history.messages.map(m => m.direction), ['outbound', 'inbound']);
  assert.equal(history.messages[1].body, 'Podemos hablar el martes.');
  assert.equal(history.messages[1].subject, 'Re: consulta');
  assert.equal(history.messages[0].status, 'sent');
  assert.equal(history.truncated, false);
  assert.ok(f.queries.every(q => q.limit === 201 && q.filters.some(([k, v]) => k === 'conversation_id' && v === id) && !q.fields.includes('*')));
  assert.ok(f.queries[0].filters.some(([k, v]) => k === 'source_channel' && v === 'email'));
  assert.ok(!JSON.stringify(history).includes('must-not-leak') && !JSON.stringify(history).includes('secret-provider-id') && !JSON.stringify(history).includes('Foreign lead'));
});
test('long histories are bounded and database failure is an error, not a fabricated empty conversation', async () => {
  const f = database({many: true}); const result = await loadCrmEmailHistory(f.db, id);
  assert.equal(result.truncated, true); assert.equal(result.messages.length, 201);
  await assert.rejects(loadCrmEmailHistory(database({error: true}).db, id), e => e.code === 'CRM_EMAIL_HISTORY_UNAVAILABLE' && !e.message.includes('private database'));
  await assert.rejects(loadCrmEmailHistory({from() {throw Error('private network detail');}}, id), e => e.code === 'CRM_EMAIL_HISTORY_UNAVAILABLE' && !e.message.includes('private network'));
  const bad = database(); await assert.rejects(loadCrmEmailHistory(bad.db, 'not-a-uuid'), e => e.status === 404); assert.equal(bad.queries.length, 0);
});
function generic() {
  let visible = {...lead}, historyReads = 0;
  const repository = {async getConversation(value) {return value === id ? visible : null;}, async listEmailHistory() {historyReads++; return {truncated: false, messages: [{id: 'incoming', direction: 'inbound', body: 'Respuesta original', at: '2026-10-28T12:00:00Z'}]};}};
  return {repository, service: createCrmAdminService({repository, commercialOperators: CRM_COMMERCIAL_OPERATORS}), hide() {visible = {...visible, test_hidden_at: '2026-10-28T12:00:00Z'};}, set(row) {visible = row;}, historyReads: () => historyReads};
}
test('Nico reads commercial email only; foreign identity, hidden lead, WhatsApp and institutional mail do not expose history', async () => {
  const f = generic(); const actor = {email: nico.email, userId: nico.userId, role: nico.role, id};
  assert.equal((await f.service.getEmailHistory(actor)).messages[0].body, 'Respuesta original');
  await assert.rejects(f.service.getEmailHistory({...actor, userId: other}), e => e.status === 403);
  await assert.rejects(f.service.getEmailHistory({...actor, id: other}), e => e.status === 404);
  f.hide(); await assert.rejects(f.service.getEmailHistory(actor), e => e.status === 404);
  f.set({...lead, source_channel: 'whatsapp'}); await assert.rejects(f.service.getEmailHistory(actor), e => e.status === 404);
  f.set({...lead, origin: 'institutional_email'}); await assert.rejects(f.service.getEmailHistory(actor), e => e.status === 404);
  assert.equal(f.historyReads(), 1); assert.equal(lead.inbound_body, 'Mensaje original sin cambiar');
});
test('generic history rechecks scope before returning if a conversation is hidden during its read', async () => {
  const f = generic(); f.repository.listEmailHistory = async () => {f.hide(); return {messages: [{body: 'Must not leak'}]};};
  await assert.rejects(f.service.getEmailHistory({email: nico.email, userId: nico.userId, role: nico.role, id}), e => e.status === 404);
});
test('generic HTTP history uses authenticated identity, private no-store, and supports the existing superadmin reader', async () => {
  const f = generic(); let actor = user, role = nico.role;
  const app = express(); registerCrmAdminRoutes(app, {crmAdminService: f.service, authUserFromBearer: async () => actor, fetchUserRoleRowForAuthUser: async () => ({role}), logger: {error() {}}});
  const server = app.listen(0);
  try {
    const url = `http://127.0.0.1:${server.address().port}/api/admin/crm/inbox/${id}/email-history`;
    const response = await fetch(url); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/); assert.equal((await response.json()).messages[0].body, 'Respuesta original');
    actor = {...user, id: other}; assert.equal((await fetch(url + '?userId=' + nico.userId)).status, 403);
    actor = {id: '8beebdbe-e1d7-4607-9bb0-9a7d64701408', email: 'padbolinternacional@gmail.com'}; role = 'super_admin'; assert.equal((await fetch(url)).status, 200);
  } finally {server.close();}
});
function commercial({reassignDuringRead = false} = {}) {
  const f = database(); let allowed = true, reads = 0, role = 'advisor';
  f.db.rpc = async (name, args) => {
    if (name === 'crm_commercial_team_role') return {data: role};
    assert.equal(name, 'crm_commercial_team_form_read');
    assert.equal(args.p_actor, user.id); assert.equal(args.p_superadmin, false);
    reads++;
    return {data: allowed && args.p_id === id && !(reassignDuringRead && reads > 1) ? {id, body: lead.inbound_body} : null};
  };
  const api = createCommercialTeamApi({db: f.db, sendClaimed: async () => {throw Error('must never send');}, resolveTrustedSuperadmin: async () => false});
  return {...f, api, setAllowed(value) {allowed = value;}, setRole(value) {role = value;}};
}
test('commercial HTTP authorizes the assigned case, denies another case/role/channel and ignores forged authority', async () => {
  const f = commercial(); const app = express(); registerCommercialTeamRoutes(app, {api: f.api, authUserFromBearer: async () => user, logger: {error() {}}});
  const server = app.listen(0);
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/admin/crm/commercial-cases/`;
    const response = await fetch(base + id + '/email-history?channel=form'); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control'), /no-store/); assert.equal((await response.json()).messages[1].body, 'Podemos hablar el martes.');
    const before = f.queries.length;
    assert.equal((await fetch(base + other + '/email-history?channel=form&p_superadmin=true')).status, 404);
    assert.equal((await fetch(base + id + '/email-history?channel=whatsapp')).status, 404);
    f.setRole('none'); assert.equal((await fetch(base + id + '/email-history?channel=form')).status, 403);
    assert.equal(f.queries.length, before);
  } finally {server.close();}
});
test('commercial transcript is withheld if assignment is revoked while its queries run', async () => {
  const f = commercial({reassignDuringRead: true});
  await assert.rejects(f.api.emailHistory(user, 'form', id), e => e.status === 404);
  assert.equal(f.queries.length, 2);
});
