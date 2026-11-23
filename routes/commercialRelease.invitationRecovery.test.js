import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mountCommercialReleaseRoutes } from './commercialRelease.js';

// HTTP/Express real; all data, auth provisioning and delivery are local fixtures.
// Run with a clean environment. Never instantiate a Supabase client or send email.
const TOKEN = 'fixture-invitation-token-001';
const EMAIL = 'club@fixture.invalid';
const BODY = { nombre: 'Club Fixture', ciudad: 'Ciudad Fixture', pais: 'Argentina',
  email_contacto: EMAIL, telefono: 'fixture-phone', horario_apertura: '09:00',
  horario_cierre: '22:00', precio_turno: 0, cantidad_canchas: 1,
  deportes: [{ deporte: 'padbol', cantidad: 1 }] };
function fixture({ expired = false } = {}) {
  const tables = {
    invitaciones_admin: [{ id: 1, token: TOKEN, email: EMAIL, estado: 'pendiente',
      expires_at: expired ? '2000-01-01T00:00:00Z' : '2099-12-31T00:00:00Z', invited_role: 'admin_club' }],
    sedes: [], canchas_por_deporte: [],
    user_roles: [{ email: EMAIL, role: 'admin_club', sede_id: 99, nombre: 'Asignación previa' }],
  };
  const state = { failAuth: true, authCalls: 0, deliveries: 0, writes: [], tables, createError: null, newUser: false, resetError: null, resetThrows: false, malformedCreate: false, malformedReset: false };
  const supabase = {
    auth: { admin: { createUser: async () => {
      state.authCalls++;
      if (state.malformedCreate) return { data: { user: null }, error: null };
      if (state.createError) return { data: { user: null }, error: state.createError };
      if (state.newUser) return { data: { user: { id: '00000000-0000-4000-8000-000000000001', email: EMAIL } }, error: null };
      return state.failAuth
        ? { error: { status: 503, message: 'Fixture Auth temporal unavailable' } }
        : { data: { user: null }, error: { code: 'user_already_exists', status: 422, message: 'User already exists' } };
    } }, resetPasswordForEmail: async () => { state.deliveries++; if (state.resetThrows) throw new Error('Fixture reset transport failed'); return state.malformedReset ? { data: null, error: null } : { data: {}, error: state.resetError }; } },
    // Fixture-only emulation of the atomic RPC dependency. The real HTTP+PG
    // coverage of this contract lives in invitationAtomic.test.js.
    rpc(name, args) {
      assert.equal(name, 'completar_invitacion_club_atomica');
      const inv = tables.invitaciones_admin.find((row) => row.token === args.p_token);
      if (!inv) return Promise.resolve({ data: { ok: false, reason: 'not_found' }, error: null });
      if (inv.estado !== 'pendiente') {
        return Promise.resolve({ data: { ok: false, reason: 'consumed', estado: inv.estado }, error: null });
      }
      const expMs = inv.expires_at ? new Date(inv.expires_at).getTime() : 0;
      if (Number.isFinite(expMs) && expMs <= Date.now()) {
        inv.estado = 'expirada';
        return Promise.resolve({ data: { ok: false, reason: 'expired' }, error: null });
      }
      if (String(inv.email).trim().toLowerCase() !== String(args.p_email).trim().toLowerCase()) {
        return Promise.resolve({ data: { ok: false, reason: 'email_mismatch' }, error: null });
      }
      if (String(inv.invited_role || 'admin_club').trim().toLowerCase() !== 'admin_club'
        || !['', 'sede'].includes(String(inv.invited_alcance || '').trim().toLowerCase())) {
        return Promise.resolve({ data: { ok: false, reason: 'role_not_allowed' }, error: null });
      }
      const NEWID = tables.sedes.length + 201;
      const sede = { id: NEWID, ...structuredClone(args.p_sede), tipo_sede: 'reservable', email_contacto: inv.email };
      tables.sedes.push(sede);
      for (const d of args.p_deportes) {
        tables.canchas_por_deporte.push({ id: NEWID, sede_id: NEWID, deporte: d.deporte, cantidad: d.cantidad, activo: true });
      }
      const role = tables.user_roles.find((row) => String(row.email || '').trim().toLowerCase() === String(inv.email).trim().toLowerCase());
      let roleId;
      if (role) {
        Object.assign(role, { role: 'admin_club', alcance: 'sede', nombre: args.p_nombre_admin, pais: sede.pais,
          ciudad: null, provincia: null, sede_id: NEWID, torneos_oficiales_habilitados: false });
        roleId = role.id;
      } else {
        roleId = NEWID;
        tables.user_roles.push({ id: roleId, email: inv.email, role: 'admin_club', alcance: 'sede',
          nombre: args.p_nombre_admin, pais: sede.pais, ciudad: null, provincia: null, sede_id: NEWID,
          torneos_oficiales_habilitados: false });
      }
      inv.estado = 'completada';
      inv.sede_id = NEWID;
      return Promise.resolve({ data: { ok: true, invitation_id: inv.id, sede_id: NEWID, sede,
        role_id: roleId, canchas: args.p_deportes.length, estado: 'completada' }, error: null });
    },
    from(table) {
      assert.ok(Object.hasOwn(tables, table), `Unexpected table ${table}`);
      const filters = []; let mode = 'select', values, single = false;
      const matches = row => filters.every(([key, value]) => String(row[key]) === String(value));
      const query = {
        select() { return query; }, eq(key, value) { filters.push([key, value]); return query; },
        maybeSingle() { single = true; return query; }, single() { single = true; return query; },
        insert(payload) { mode = 'insert'; values = structuredClone(Array.isArray(payload) ? payload : [payload]); return query; },
        update(payload) { mode = 'update'; values = structuredClone(payload); return query; },
        delete() { mode = 'delete'; return query; },
        async then(resolve, reject) {
          try {
            let rows;
            if (mode === 'insert') {
              rows = values.map((value, index) => ({ id: tables[table].length + index + 101, ...value }));
              tables[table].push(...rows);
            } else {
              rows = tables[table].filter(matches);
              if (mode === 'update') rows.forEach(row => Object.assign(row, values));
              if (mode === 'delete') tables[table] = tables[table].filter(row => !matches(row));
            }
            if (mode !== 'select') state.writes.push({ table, mode });
            return resolve({ data: structuredClone(single ? rows[0] ?? null : rows), error: null });
          } catch (error) { return reject(error); }
        },
      };
      return query;
    },
  };
  return { state, supabase };
}
async function start(t, options) {
  const { state, supabase } = fixture(options);
  const app = express(); app.use(express.json());
  mountCommercialReleaseRoutes(app, { supabaseAdmin: supabase,
    runtime: { outboundDeliveryEnabled: options?.outboundEnabled === true }, authUserFromBearer: async () => null,
    assertSuperAdminReq: async () => { throw new Error('NOT_USED'); },
    adminListScopeFromRequest: async () => null, sedesPermitidasPorScope: async () => ({ sedes: [] }) });
  const server = app.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections?.(); }));
  const request = async (body = BODY) => {
    const result = await fetch(`http://127.0.0.1:${server.address().port}/api/invitacion/${TOKEN}/completar`,
      { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: result.status, body: await result.json() };
  };
  return { state, request };
}

test('auth unavailable leaves invitation retryable, no seat or role change; retry completes once', async t => {
  const { state, request } = await start(t);
  const beforeRole = structuredClone(state.tables.user_roles);
  const failed = await request();
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.code, 'SEDE_ACCESS_PROVISION_UNAVAILABLE');
  assert.equal(failed.body.retry, true);
  assert.equal(state.tables.invitaciones_admin[0].estado, 'pendiente');
  assert.equal(state.tables.sedes.length, 0);
  assert.equal(state.tables.canchas_por_deporte.length, 0);
  assert.deepEqual(state.tables.user_roles, beforeRole);
  assert.equal(state.writes.length, 0);
  state.failAuth = false;
  const recovered = await request();
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  assert.equal(recovered.body.ok, true);
  assert.equal(recovered.body.access_state, 'sign_in_or_recovery');
  assert.equal(recovered.body.welcome_delivery, 'not_requested_existing_account');
  assert.equal(state.tables.sedes.length, 1);
  assert.equal(state.tables.invitaciones_admin[0].estado, 'completada');
  assert.equal(state.tables.invitaciones_admin[0].sede_id, recovered.body.sede_id);
  assert.equal(state.tables.user_roles[0].sede_id, recovered.body.sede_id);
  const writes = state.writes.length, authCalls = state.authCalls;
  const repeated = await request();
  assert.equal(repeated.status, 410);
  assert.equal(state.tables.sedes.length, 1);
  assert.equal(state.writes.length, writes);
  assert.equal(state.authCalls, authCalls);
  assert.equal(state.deliveries, 0);
});

test('invalid required seat configuration is rejected before auth or data writes', async t => {
  const { state, request } = await start(t);
  const result = await request({ ...BODY, horario_apertura: '' });
  assert.equal(result.status, 400);
  assert.equal(state.authCalls, 0);
  assert.equal(state.writes.length, 0);
  assert.equal((await request({ ...BODY, deportes: [] })).status, 400);
  assert.equal((await request({ ...BODY, deportes: [{ deporte: 'inventado', cantidad: 1 }] })).status, 400);
  assert.equal(state.authCalls, 0);
  assert.equal(state.writes.length, 0);
});

test('expired or wrong-email invitation never provisions account or creates seat', async t => {
  const wrong = await start(t);
  assert.equal((await wrong.request({ ...BODY, email_contacto: 'other@fixture.invalid' })).status, 400);
  assert.equal(wrong.state.authCalls, 0);
  assert.equal(wrong.state.writes.length, 0);
  const expired = await start(t, { expired: true });
  assert.equal((await expired.request()).status, 410);
  assert.equal(expired.state.authCalls, 0);
  assert.equal(expired.state.tables.sedes.length, 0);
});


test('422 validation and policy failures are not existing accounts', async t => {
  for (const error of [
    { status: 422, code: 'weak_password', message: 'Password policy not satisfied' },
    { status: 422, code: 'validation_failed', message: 'Provider already rejected this input' },
    { status: 422, code: 'email_address_invalid', message: 'Invalid address' },
    { status: 422, message: 'User already exists' },
  ]) {
    const { state, request } = await start(t);
    state.createError = error;
    const result = await request();
    assert.equal(result.status, 503, JSON.stringify({ code: error.code, body: result.body }));
    assert.equal(result.body.retry, true);
    assert.equal(state.tables.invitaciones_admin[0].estado, 'pendiente');
    assert.equal(state.tables.sedes.length, 0);
    assert.equal(state.writes.length, 0);
  }
});

test('returned reset error for a new account leaves invitation pending and no seat', async t => {
  const { state, request } = await start(t, { outboundEnabled: true });
  state.newUser = true;
  state.resetError = { status: 429, code: 'over_email_send_rate_limit', message: 'Fixture email rate limit' };
  const result = await request();
  assert.equal(result.status, 503);
  assert.equal(result.body.retry, true);
  assert.equal(state.tables.invitaciones_admin[0].estado, 'pendiente');
  assert.equal(state.tables.sedes.length, 0);
  assert.equal(state.writes.length, 0);
  assert.equal(state.deliveries, 1, 'one fixture reset call; no real delivery');
  state.newUser = false; state.failAuth = false;
  const retry = await request();
  assert.equal(retry.status, 201);
  assert.equal(retry.body.access_state, 'sign_in_or_recovery');
  assert.equal(retry.body.welcome_delivery, 'not_requested_existing_account');
  assert.equal(state.deliveries, 1, 'retry does not reset an existing account');
  assert.equal(state.tables.sedes.length, 1);
  const authCalls = state.authCalls;
  assert.equal((await request()).status, 410);
  assert.equal(state.tables.sedes.length, 1);
  assert.equal(state.authCalls, authCalls);
});


test('both documented existing-account codes preserve access without automatic reset', async t => {
  for (const code of ['email_exists', 'user_already_exists']) {
    const { state, request } = await start(t, { outboundEnabled: true });
    state.createError = { status: 422, code, message: 'Fixture account exists' };
    state.resetError = { status: 500, code: 'unexpected_failure' };
    const result = await request();
    assert.equal(result.status, 201);
    assert.equal(result.body.access_state, 'sign_in_or_recovery');
    assert.equal(result.body.welcome_delivery, 'not_requested_existing_account');
    assert.equal(state.deliveries, 0);
    assert.equal(state.tables.sedes.length, 1);
    assert.equal((await request()).status, 410);
    assert.equal(state.tables.sedes.length, 1);
  }
});

test('new account reports requested-not-delivered or delivery-disabled truthfully', async t => {
  const enabled = await start(t, { outboundEnabled: true });
  enabled.state.newUser = true;
  const requested = await enabled.request();
  assert.equal(requested.status, 201);
  assert.equal(requested.body.access_state, 'recovery_email_requested');
  assert.equal(requested.body.welcome_delivery, 'requested_not_verified');
  assert.equal(enabled.state.deliveries, 1);
  const disabled = await start(t);
  disabled.state.newUser = true;
  const skipped = await disabled.request();
  assert.equal(skipped.status, 201);
  assert.equal(skipped.body.access_state, 'new_account_delivery_disabled');
  assert.equal(skipped.body.welcome_delivery, 'disabled');
  assert.equal(disabled.state.deliveries, 0);
});

test('malformed auth receipts or reset transport errors cannot consume invitation', async t => {
  for (const failure of ['malformedCreate', 'malformedReset', 'resetThrows']) {
    const { state, request } = await start(t, { outboundEnabled: true });
    state.newUser = true; state[failure] = true;
    const result = await request();
    assert.equal(result.status, 503, failure);
    assert.equal(state.tables.invitaciones_admin[0].estado, 'pendiente');
    assert.equal(state.tables.sedes.length, 0);
    assert.equal(state.writes.length, 0);
  }
});
