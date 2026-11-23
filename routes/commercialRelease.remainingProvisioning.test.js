import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { mountCommercialReleaseRoutes } from './commercialRelease.js';

// HTTP/Express real sobre loopback. Supabase, Auth, email, WhatsApp y Make son
// fixtures locales en memoria. Ejecutar con entorno limpio:
// BACKEND_RUNTIME_MODE=test OUTBOUND_DELIVERY_ENABLED=false.
// Nunca se instancia un cliente Supabase real ni se envía correo/WhatsApp.
const SUPER_EMAIL = 'super@fixture.invalid';
const SUPER_USER_ID = 'fixture-super-user';
const LIC_EMAIL = 'lic@fixture.invalid';
const NACIONAL_EMAIL = 'nacional@fixture.invalid';
const CADENA_EMAIL = 'cadena@fixture.invalid';
const CLUB_EMAIL = 'club@fixture.invalid';
const GEO_EMAIL = 'geo@fixture.invalid';
const CLUB_TOKEN = 'fixture-club-invitation-token-002';
const GEO_TOKEN = 'fixture-geo-invitation-token-002';
const APPROVE_PENDING_ID = 902;

const CLUB_BODY = {
  nombre: 'Club Fixture', ciudad: 'Ciudad Fixture', pais: 'Argentina',
  email_contacto: CLUB_EMAIL, telefono: 'fixture-phone', horario_apertura: '09:00',
  horario_cierre: '22:00', precio_turno: 0, cantidad_canchas: 1,
  deportes: [{ deporte: 'padbol', cantidad: 1 }],
};
const GEO_BODY = { email_contacto: GEO_EMAIL, nombre_admin: 'Admin Geo Fixture' };
const DIRECTA_BODY = {
  nombre: 'Sede Directa Fixture', direccion: 'Calle Directa 456',
  ciudad: 'Ciudad Fixture', provincia: 'Provincia Fixture', pais: 'Argentina',
  timezone: 'America/Argentina/Buenos_Aires', latitud: -34.6, longitud: -58.4,
  horario_apertura: '09:00', horario_cierre: '22:00', precio_turno: 100,
  moneda: 'ARS', metodo_pago: 'mercadopago', telefono: 'fixture-whatsapp-sede',
  cantidad_canchas: 2, email_contacto: 'sede@fixture.invalid',
  numero_licencia: 'LIC-DIRECTA-1', licenciatario_nombre: 'Licenciatario Directa Fixture',
  licenciatario_email: LIC_EMAIL, licenciatario_telefono: 'fixture-whatsapp-lic',
  tipo_licencia: 'club_afiliado',
};
const SUPER_USER = { id: SUPER_USER_ID, email: SUPER_EMAIL };

// Guard de salida: el request HTTP propio va a 127.0.0.1; cualquier otro
// destino quedaría registrado y hace fallar la suite (outbound real prohibido).
const externalFetches = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input?.url || String(input);
  if (!/^http:\/\/127\.0\.0\.1:\d+\//.test(url)) externalFetches.push(String(url));
  return originalFetch(input, init);
};
after(() => { globalThis.fetch = originalFetch; });

const clone = (value) => structuredClone(value);

function superRoleRow() {
  return { id: 1, user_id: SUPER_USER_ID, email: SUPER_EMAIL, role: 'super_admin', alcance: 'global' };
}

function clubInvitation(overrides = {}) {
  return {
    id: 11, token: CLUB_TOKEN, email: CLUB_EMAIL, estado: 'pendiente',
    expires_at: '2099-12-31T00:00:00Z', invited_role: 'admin_club', invited_alcance: null,
    pais: 'Argentina', nombre_club: 'Club Fixture', provincia: null, ciudad: null,
    sede_id: null, ...overrides,
  };
}

function geoInvitation(overrides = {}) {
  return {
    id: 12, token: GEO_TOKEN, email: GEO_EMAIL, estado: 'pendiente',
    expires_at: '2099-12-31T00:00:00Z', invited_role: 'admin_nacional',
    invited_alcance: 'provincia', pais: 'Argentina', provincia: 'Provincia Fixture',
    ciudad: null, nombre_club: null, sede_id: null, ...overrides,
  };
}

function pendingRow(overrides = {}) {
  return {
    id: APPROVE_PENDING_ID, estado: 'pendiente', created_by: NACIONAL_EMAIL,
    organizacion_id: null, cantidad_canchas_solicitadas: 2,
    nombre: 'Sede Pendiente Fixture', direccion: 'Calle Pendiente 123',
    ciudad: 'Ciudad Fixture', provincia: 'Provincia Fixture', pais: 'Argentina',
    latitud: null, longitud: null, horario_apertura: '09:00', horario_cierre: '22:00',
    precio_base: 100, moneda: 'ARS', whatsapp: 'fixture-whatsapp-pendiente',
    email_contacto: 'pendiente@fixture.invalid', metodo_pago: 'mercadopago',
    numero_licencia: 'LIC-PENDIENTE-1', fecha_contrato: null,
    tipo_licencia: 'club_afiliado', ciudad_representa: null,
    provincia_representa: null, pais_representa: null,
    licenciatario_nombre: 'Licenciatario Pendiente Fixture',
    licenciatario_email: LIC_EMAIL, licenciatario_telefono: 'fixture-whatsapp-lic',
    licenciatario_pais: 'Argentina', ...overrides,
  };
}

function buildFixture(options = {}) {
  const tables = {
    invitaciones_admin: clone(options.invitaciones ?? []),
    sedes: [],
    canchas_por_deporte: [],
    user_roles: clone(options.userRoles ?? [superRoleRow()]),
    sedes_pendientes: clone(options.pendientes ?? []),
    organizacion_sedes: [],
    organizaciones: [{ id: 'org-fixture', estado: 'activa', limite_sedes: 10, limite_canchas_total: 100 }],
    jugadores_perfil: [],
  };
  const state = {
    tables, authUsers: 0, deliveries: 0, writes: [],
    authUser: options.authUser ?? null,
    failAuth: false, createError: null, createThrows: false, malformedCreate: false,
    newUser: false, resetError: null, malformedReset: false, resetThrows: false,
    failUpdateTable: null, lastAuthEmail: null,
  };
  let nextId = 500;
  const nextRowId = () => (nextId += 1);
  const matches = (row, filters) => filters.every(([op, key, value]) => {
    if (op === 'is') return (row[key] ?? null) === value;
    if (op === 'in') return Array.isArray(value) && value.map(String).includes(String(row[key]));
    if (op === 'neq') return String(row[key]) !== String(value);
    return String(row[key]) === String(value);
  });

  const supabase = {
    auth: {
      admin: {
        createUser: async (credentials = {}) => {
          state.authUsers += 1;
          state.lastAuthEmail = String(credentials.email || '').trim().toLowerCase();
          if (state.createThrows) throw new Error('Fixture Auth transport failed');
          if (state.malformedCreate) return { data: { user: null }, error: null };
          if (state.createError) return { data: { user: null }, error: state.createError };
          if (state.newUser) {
            return { data: { user: { id: 'fixture-auth-new-user', email: credentials.email } }, error: null };
          }
          if (state.failAuth) {
            return { data: { user: null }, error: { status: 503, message: 'Fixture Auth temporal unavailable' } };
          }
          return { data: { user: null }, error: { status: 422, code: 'user_already_exists', message: 'Fixture account exists' } };
        },
      },
      resetPasswordForEmail: async (email) => {
        state.deliveries += 1;
        state.lastAuthEmail = String(email || '').trim().toLowerCase();
        if (state.resetThrows) throw new Error('Fixture reset transport failed');
        if (state.malformedReset) return { data: null, error: null };
        return { data: {}, error: state.resetError };
      },
    },
    // Fixture-only emulation of the atomic RPC dependency. The real HTTP+PG
    // coverage of this contract lives in invitationAtomic.test.js.
    rpc(name, args) {
      // Dependency fixture only; pendingAtomic.test.js proves real SQL rollback.
      if (name === 'aprobar_sede_pendiente_atomica') {
        const pending = tables.sedes_pendientes.find(row => Number(row.id) === Number(args.p_request_id));
        if (!pending) return Promise.resolve({ data: { ok: false, reason: 'not_found' }, error: null });
        if (pending.estado !== 'pendiente') return Promise.resolve({ data: { ok: false, reason: 'not_pending' }, error: null });
        if (state.failUpdateTable === 'sedes_pendientes') return Promise.resolve({ data: null, error: { code: 'P0001', message: 'Fixture atomic commit failure' } });
        const sedeId = nextRowId();
        tables.sedes.push({ id: sedeId, ...clone(args.p_sede) });
        state.writes.push({ table: 'sedes', mode: 'insert' });
        if (pending.organizacion_id) {
          tables.organizacion_sedes.push({ organizacion_id: pending.organizacion_id, sede_id: sedeId });
          state.writes.push({ table: 'organizacion_sedes', mode: 'insert' });
        }
        const email = String(pending.licenciatario_email).trim().toLowerCase();
        if (!(pending.organizacion_id && email === String(pending.created_by || '').trim().toLowerCase())) {
          const role = tables.user_roles.find(row => String(row.email || '').trim().toLowerCase() === email);
          const assigned = { email, role: 'admin_club', alcance: 'sede', nombre: pending.licenciatario_nombre || null,
            sede_id: sedeId, pais: pending.licenciatario_pais || pending.pais, ciudad: null, provincia: null, torneos_oficiales_habilitados: false };
          if (role) Object.assign(role, assigned); else tables.user_roles.push({ id: nextRowId(), ...assigned });
          state.writes.push({ table: 'user_roles', mode: role ? 'update' : 'insert' });
        }
        pending.estado = 'aprobada';
        state.writes.push({ table: 'sedes_pendientes', mode: 'update' });
        return Promise.resolve({ data: { ok: true, sede_id: sedeId }, error: null });
      }
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
      const NEWID = nextRowId();
      const sede = { id: NEWID, ...structuredClone(args.p_sede), tipo_sede: 'reservable', email_contacto: inv.email };
      tables.sedes.push(sede);
      for (const d of args.p_deportes) {
        tables.canchas_por_deporte.push({ id: nextRowId(), sede_id: NEWID, deporte: d.deporte, cantidad: d.cantidad, activo: true });
      }
      const role = tables.user_roles.find((row) => String(row.email || '').trim().toLowerCase() === String(inv.email).trim().toLowerCase());
      let roleId;
      if (role) {
        Object.assign(role, { role: 'admin_club', alcance: 'sede', nombre: args.p_nombre_admin, pais: sede.pais,
          ciudad: null, provincia: null, sede_id: NEWID, torneos_oficiales_habilitados: false });
        roleId = role.id;
      } else {
        roleId = nextRowId();
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
      const filters = [];
      let mode = 'select';
      let values = null;
      let single = false;
      let limitN = null;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push(['eq', key, value]); return query; },
        neq(key, value) { filters.push(['neq', key, value]); return query; },
        is(key, value) { filters.push(['is', key, value]); return query; },
        in(key, value) { filters.push(['in', key, value]); return query; },
        order() { return query; },
        limit(n) { limitN = n; return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        insert(payload) {
          mode = 'insert';
          values = clone(Array.isArray(payload) ? payload : [payload]);
          return query;
        },
        upsert(payload) {
          mode = 'insert';
          values = clone(Array.isArray(payload) ? payload : [payload]);
          return query;
        },
        update(payload) { mode = 'update'; values = clone(payload); return query; },
        delete() { mode = 'delete'; return query; },
        async then(resolve, reject) {
          try {
            if (mode === 'update' && state.failUpdateTable === table) {
              return resolve({ data: null, error: { message: 'Fixture update failure', code: 'FIXTURE_UPDATE_FAILED' } });
            }
            if (mode === 'insert') {
              const rows = values.map((value) => ({ ...value, id: value.id ?? nextRowId() }));
              tables[table].push(...rows);
              state.writes.push({ table, mode });
              return resolve({ data: clone(single ? rows[0] ?? null : rows), error: null });
            }
            if (mode === 'update') {
              const rows = tables[table].filter((row) => matches(row, filters));
              rows.forEach((row) => Object.assign(row, values));
              state.writes.push({ table, mode });
              return resolve({ data: clone(single ? rows[0] ?? null : rows), error: null });
            }
            if (mode === 'delete') {
              const rows = tables[table].filter((row) => matches(row, filters));
              tables[table] = tables[table].filter((row) => !matches(row, filters));
              state.writes.push({ table, mode });
              return resolve({ data: clone(rows), error: null });
            }
            let rows = tables[table].filter((row) => matches(row, filters));
            if (limitN != null) rows = rows.slice(0, limitN);
            return resolve({ data: clone(single ? rows[0] ?? null : rows), error: null });
          } catch (error) { return reject(error); }
        },
      };
      return query;
    },
  };
  return { state, supabase };
}

async function start(t, options = {}) {
  const { state, supabase } = buildFixture(options);
  const app = express();
  app.use(express.json());
  mountCommercialReleaseRoutes(app, {
    supabaseAdmin: supabase,
    runtime: { outboundDeliveryEnabled: options.outboundEnabled === true },
    authUserFromBearer: async () => state.authUser,
    assertSuperAdminReq: async () => { throw Object.assign(new Error('FIXTURE_FORBIDDEN'), { status: 403 }); },
    adminListScopeFromRequest: async () => null,
    sedesPermitidasPorScope: async () => ({ sedes: [] }),
  });
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, path, body) => {
    const init = { method, headers: {} };
    if (body !== undefined) {
      init.headers['content-type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
    const result = await fetch(base + path, init);
    return { status: result.status, body: await result.json() };
  };
  return {
    state,
    tables: state.tables,
    call,
    club: (body = CLUB_BODY) => call('POST', `/api/invitacion/${CLUB_TOKEN}/completar`, body),
    geo: (body = GEO_BODY) => call('POST', `/api/invitacion/${GEO_TOKEN}/completar`, body),
    directa: (body = DIRECTA_BODY) => call('POST', '/api/admin/sedes-directa', body),
    aprobar: (id = APPROVE_PENDING_ID) => call('POST', `/api/admin/sedes-pendientes/${id}/aprobar`, undefined),
  };
}

function assertNoFailureLeak(body) {
  const blob = JSON.stringify(body);
  for (const forbidden of ['tempPassword', 'temp_password', 'password', 'invite_url',
    'Fixture Auth', 'Fixture reset', 'Fixture update', 'access_token', 'refresh_token']) {
    assert.equal(blob.includes(forbidden), false, `respuesta de fallo filtra ${forbidden}: ${blob}`);
  }
}

function assertNoCredentialFields(body) {
  const blob = JSON.stringify(body);
  for (const forbidden of ['tempPassword', 'temp_password', 'access_token', 'refresh_token', 'invite_url']) {
    assert.equal(blob.includes(forbidden), false, `respuesta exitosa expone ${forbidden}`);
  }
}

function authFailureModes() {
  return [
    { name: 'auth_503', apply: (state) => { state.failAuth = true; } },
    { name: '422_no_documentado', apply: (state) => { state.createError = { status: 422, code: 'weak_password', message: 'Fixture password policy' }; } },
    { name: 'otro_error_500', apply: (state) => { state.createError = { status: 500, message: 'Fixture Auth internal failure' }; } },
    { name: 'createUser_malformado', apply: (state) => { state.malformedCreate = true; } },
    { name: 'reset_error', outbound: true, apply: (state) => { state.newUser = true; state.resetError = { status: 429, code: 'over_email_send_rate_limit', message: 'Fixture rate limit' }; } },
    { name: 'reset_malformado', outbound: true, apply: (state) => { state.newUser = true; state.malformedReset = true; } },
    { name: 'transporte_auth_throw', apply: (state) => { state.createThrows = true; } },
  ];
}

// ---------------------------------------------------------------------------
// Reproducciones negativas (fallaban en baseline 422: 201/200 con writes).
// ---------------------------------------------------------------------------

test('repro/geo: Auth fallido devuelve 503 retry estable, invitación pendiente y cero writes', async t => {
  const { state, geo } = await start(t, { invitaciones: [geoInvitation()] });
  const rolesBefore = clone(state.tables.user_roles);
  state.failAuth = true;
  const result = await geo();
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(result.body.code, 'SEDE_ACCESS_PROVISION_UNAVAILABLE');
  assert.equal(result.body.retry, true);
  assertNoFailureLeak(result.body);
  assert.equal(state.authUsers, 1);
  assert.deepEqual(state.writes, []);
  assert.equal(state.tables.invitaciones_admin[0].estado, 'pendiente');
  assert.equal(state.tables.sedes.length, 0);
  assert.deepEqual(state.tables.user_roles, rolesBefore);
});

test('repro/directa: Auth fallido devuelve 503 retry estable con cero sedes, vínculos y roles', async t => {
  const { state, directa } = await start(t, { authUser: SUPER_USER });
  const rolesBefore = clone(state.tables.user_roles);
  state.failAuth = true;
  const result = await directa({ ...DIRECTA_BODY, organizacion_id: 'org-fixture' });
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(result.body.code, 'SEDE_ACCESS_PROVISION_UNAVAILABLE');
  assert.equal(result.body.retry, true);
  assertNoFailureLeak(result.body);
  assert.equal(state.authUsers, 1);
  assert.deepEqual(state.writes, []);
  assert.equal(state.tables.sedes.length, 0);
  assert.equal(state.tables.organizacion_sedes.length, 0);
  assert.deepEqual(state.tables.user_roles, rolesBefore);
});

test('repro/aprobar: Auth fallido devuelve 503 retry estable y deja la solicitud pendiente intacta', async t => {
  const { state, aprobar } = await start(t, { authUser: SUPER_USER, pendientes: [pendingRow()] });
  const rolesBefore = clone(state.tables.user_roles);
  const pendingBefore = clone(state.tables.sedes_pendientes);
  state.failAuth = true;
  const result = await aprobar();
  assert.equal(result.status, 503, JSON.stringify(result.body));
  assert.equal(result.body.code, 'SEDE_ACCESS_PROVISION_UNAVAILABLE');
  assert.equal(result.body.retry, true);
  assertNoFailureLeak(result.body);
  assert.equal(state.authUsers, 1);
  assert.deepEqual(state.writes, []);
  assert.equal(state.tables.sedes.length, 0);
  assert.equal(state.tables.organizacion_sedes.length, 0);
  assert.deepEqual(state.tables.user_roles, rolesBefore);
  assert.deepEqual(state.tables.sedes_pendientes, pendingBefore);
});

// ---------------------------------------------------------------------------
// Matriz de fallos Auth (503, 422 no documentado, otro, malformado, reset).
// ---------------------------------------------------------------------------

test('matriz/geo: toda falla Auth/reset => 503 estable, cero writes, estado previo intacto', async t => {
  for (const mode of authFailureModes()) {
    const { state, geo } = await start(t, {
      invitaciones: [geoInvitation()], outboundEnabled: mode.outbound === true,
    });
    const rolesBefore = clone(state.tables.user_roles);
    const invitationsBefore = clone(state.tables.invitaciones_admin);
    mode.apply(state);
    const result = await geo();
    assert.equal(result.status, 503, `${mode.name}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, 'SEDE_ACCESS_PROVISION_UNAVAILABLE', mode.name);
    assert.equal(result.body.retry, true, mode.name);
    assertNoFailureLeak(result.body);
    assert.deepEqual(state.writes, [], mode.name);
    assert.deepEqual(state.tables.invitaciones_admin, invitationsBefore, mode.name);
    assert.deepEqual(state.tables.user_roles, rolesBefore, mode.name);
    assert.equal(state.tables.sedes.length, 0, mode.name);
    assert.equal(state.authUsers, 1, mode.name);
  }
});

test('matriz/directa: toda falla Auth/reset => 503 estable con cero escrituras persistidas', async t => {
  for (const mode of authFailureModes()) {
    const { state, directa } = await start(t, {
      authUser: SUPER_USER, outboundEnabled: mode.outbound === true,
    });
    const rolesBefore = clone(state.tables.user_roles);
    mode.apply(state);
    const result = await directa({ ...DIRECTA_BODY, organizacion_id: 'org-fixture' });
    assert.equal(result.status, 503, `${mode.name}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, 'SEDE_ACCESS_PROVISION_UNAVAILABLE', mode.name);
    assert.equal(result.body.retry, true, mode.name);
    assertNoFailureLeak(result.body);
    assert.deepEqual(state.writes, [], mode.name);
    assert.equal(state.tables.sedes.length, 0, mode.name);
    assert.equal(state.tables.organizacion_sedes.length, 0, mode.name);
    assert.deepEqual(state.tables.user_roles, rolesBefore, mode.name);
    assert.equal(state.authUsers, 1, mode.name);
  }
});

test('matriz/aprobar: toda falla Auth/reset => 503 estable con solicitud pendiente y cero writes', async t => {
  for (const mode of authFailureModes()) {
    const { state, aprobar } = await start(t, {
      authUser: SUPER_USER, pendientes: [pendingRow()], outboundEnabled: mode.outbound === true,
    });
    const rolesBefore = clone(state.tables.user_roles);
    const pendingBefore = clone(state.tables.sedes_pendientes);
    mode.apply(state);
    const result = await aprobar();
    assert.equal(result.status, 503, `${mode.name}: ${JSON.stringify(result.body)}`);
    assert.equal(result.body.code, 'SEDE_ACCESS_PROVISION_UNAVAILABLE', mode.name);
    assert.equal(result.body.retry, true, mode.name);
    assertNoFailureLeak(result.body);
    assert.deepEqual(state.writes, [], mode.name);
    assert.equal(state.tables.sedes.length, 0, mode.name);
    assert.equal(state.tables.organizacion_sedes.length, 0, mode.name);
    assert.deepEqual(state.tables.user_roles, rolesBefore, mode.name);
    assert.deepEqual(state.tables.sedes_pendientes, pendingBefore, mode.name);
    assert.equal(state.authUsers, 1, mode.name);
  }
});

// ---------------------------------------------------------------------------
// Permisos y validaciones deterministas antes de Auth.
// ---------------------------------------------------------------------------

test('matriz/directa: 401 sin sesión y 403 sin superadmin verificado, sin Auth ni writes', async t => {
  const anonymous = await start(t);
  const unauthorized = await anonymous.directa();
  assert.equal(unauthorized.status, 401);
  assert.equal(anonymous.state.authUsers, 0);
  assert.deepEqual(anonymous.state.writes, []);

  const notSuper = await start(t, {
    authUser: { id: 'fixture-not-super', email: 'not-super@fixture.invalid' },
    userRoles: [{ id: 2, user_id: 'fixture-not-super', email: 'not-super@fixture.invalid', role: 'admin_club' }],
  });
  const forbidden = await notSuper.directa();
  assert.equal(forbidden.status, 403);
  assert.equal(notSuper.state.authUsers, 0);
  assert.deepEqual(notSuper.state.writes, []);
  assert.equal(notSuper.state.tables.sedes.length, 0);
});

test('matriz/directa: payload/email/territorio inválidos se rechazan antes de Auth y de writes', async t => {
  const cases = [
    ['sin nombre', { ...DIRECTA_BODY, nombre: ' ' }, 400],
    ['email sin arroba', { ...DIRECTA_BODY, licenciatario_email: 'licenciatario-sin-arroba' }, 400],
    ['sin horario', { ...DIRECTA_BODY, horario_apertura: '' }, 400],
    ['canchas negativas', { ...DIRECTA_BODY, cantidad_canchas: -1 }, 400],
    ['territorio ciudad sin provincia', { ...DIRECTA_BODY, tipo_licencia: 'master_ciudad', provincia: '' }, 400],
  ];
  for (const [label, body, status] of cases) {
    const { state, directa } = await start(t, { authUser: SUPER_USER });
    const result = await directa(body);
    assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`);
    assert.equal(state.authUsers, 0, label);
    assert.deepEqual(state.writes, [], label);
    assert.equal(state.tables.sedes.length, 0, label);
    assert.equal(state.tables.organizacion_sedes.length, 0, label);
    assert.equal(state.tables.user_roles.length, 1, label);
  }
});

test('matriz/aprobar: 401 sin sesión y 403 sin superadmin verificado, sin Auth ni writes', async t => {
  const anonymous = await start(t, { pendientes: [pendingRow()] });
  const unauthorized = await anonymous.aprobar();
  assert.equal(unauthorized.status, 401);
  assert.equal(anonymous.state.authUsers, 0);
  assert.deepEqual(anonymous.state.writes, []);

  const notSuper = await start(t, {
    pendientes: [pendingRow()],
    authUser: { id: 'fixture-not-super', email: 'not-super@fixture.invalid' },
    userRoles: [{ id: 2, user_id: 'fixture-not-super', email: 'not-super@fixture.invalid', role: 'admin_cadena', organizacion_id: 'org-fixture' }],
  });
  const forbidden = await notSuper.aprobar();
  assert.equal(forbidden.status, 403);
  assert.equal(notSuper.state.authUsers, 0);
  assert.deepEqual(notSuper.state.writes, []);
  assert.equal(notSuper.state.tables.sedes.length, 0);
});

test('matriz/aprobar: solicitud/email/payload/territorio inválidos se rechazan antes de Auth', async t => {
  const cases = [
    ['id inválido', null, 400, { pendientes: [pendingRow()] }],
    ['no encontrada', 9999, 404, { pendientes: [pendingRow()] }],
    ['ya no pendiente', APPROVE_PENDING_ID, 400, { pendientes: [pendingRow({ estado: 'aprobada' })] }],
    ['sin email licenciatario', APPROVE_PENDING_ID, 400, { pendientes: [pendingRow({ licenciatario_email: null })] }],
    ['email malformado', APPROVE_PENDING_ID, 400, { pendientes: [pendingRow({ licenciatario_email: 'sin-arroba' })] }],
    ['payload incompleto', APPROVE_PENDING_ID, 400, { pendientes: [pendingRow({ horario_apertura: '' })] }],
    ['sin nombre de sede', APPROVE_PENDING_ID, 400, { pendientes: [pendingRow({ nombre: '' })] }],
    ['territorio ciudad sin provincia', APPROVE_PENDING_ID, 400, { pendientes: [pendingRow({ tipo_licencia: 'master_ciudad', provincia: null, provincia_representa: null, ciudad_representa: null })] }],
  ];
  for (const [label, id, status, options] of cases) {
    const { state, call, aprobar } = await start(t, { authUser: SUPER_USER, ...options });
    const result = id === null
      ? await call('POST', '/api/admin/sedes-pendientes/abc/aprobar', undefined)
      : await aprobar(id);
    assert.equal(result.status, status, `${label}: ${JSON.stringify(result.body)}`);
    assert.equal(state.authUsers, 0, label);
    assert.deepEqual(state.writes, [], label);
    assert.equal(state.tables.sedes.length, 0, label);
    assert.equal(state.tables.organizacion_sedes.length, 0, label);
    assert.equal(state.tables.user_roles.length, 1, label);
  }
});

test('matriz/geo: territorio/email inválidos y expiración se rechazan antes de Auth', async t => {
  const incomplete = await start(t, {
    invitaciones: [geoInvitation({ invited_alcance: 'ciudad', ciudad: null })],
  });
  const geoBody = { email_contacto: GEO_EMAIL, nombre_admin: 'Admin Geo' };
  assert.equal((await incomplete.geo(geoBody)).status, 400);
  assert.equal(incomplete.state.authUsers, 0);
  assert.deepEqual(incomplete.state.writes, []);

  const malformed = await start(t, {
    invitaciones: [geoInvitation({ email: 'invitacion-sin-arroba' })],
  });
  assert.equal((await malformed.geo({ email_contacto: 'invitacion-sin-arroba', nombre_admin: 'Admin Geo' })).status, 400);
  assert.equal(malformed.state.authUsers, 0);
  assert.deepEqual(malformed.state.writes, []);

  const expired = await start(t, {
    invitaciones: [geoInvitation({ expires_at: '2000-01-01T00:00:00Z' })],
  });
  assert.equal((await expired.geo()).status, 410);
  assert.equal(expired.state.authUsers, 0);
  assert.equal(expired.state.tables.user_roles.length, 1);
  assert.equal(expired.state.tables.sedes.length, 0);
});

// ---------------------------------------------------------------------------
// Éxito: estados coherentes para cuenta existente y cuenta nueva.
// ---------------------------------------------------------------------------

test('matriz/geo: cuenta existente completa una vez con estados y sin reset automático', async t => {
  const { state, geo } = await start(t, { invitaciones: [geoInvitation()] });
  const result = await geo();
  assert.equal(result.status, 201, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(result.body.flow, 'geo');
  assert.equal(result.body.access_state, 'sign_in_or_recovery');
  assert.equal(result.body.welcome_delivery, 'not_requested_existing_account');
  assertNoCredentialFields(result.body);
  assert.equal(state.deliveries, 0);
  assert.equal(state.tables.sedes.length, 0);
  assert.equal(state.tables.invitaciones_admin[0].estado, 'completada');
  const role = state.tables.user_roles.find((row) => row.email === GEO_EMAIL);
  assert.ok(role);
  assert.equal(role.role, 'admin_nacional');
  assert.equal(role.alcance, 'provincia');
  assert.equal(role.provincia, 'Provincia Fixture');
  assert.equal(role.pais, 'Argentina');
});

test('matriz/geo: cuenta nueva informa recuperación solicitada o entrega deshabilitada', async t => {
  const enabled = await start(t, { invitaciones: [geoInvitation()], outboundEnabled: true });
  enabled.state.newUser = true;
  const requested = await enabled.geo();
  assert.equal(requested.status, 201, JSON.stringify(requested.body));
  assert.equal(requested.body.access_state, 'recovery_email_requested');
  assert.equal(requested.body.welcome_delivery, 'requested_not_verified');
  assert.equal(enabled.state.deliveries, 1);

  const disabled = await start(t, { invitaciones: [geoInvitation()] });
  disabled.state.newUser = true;
  const skipped = await disabled.geo();
  assert.equal(skipped.status, 201, JSON.stringify(skipped.body));
  assert.equal(skipped.body.access_state, 'new_account_delivery_disabled');
  assert.equal(skipped.body.welcome_delivery, 'disabled');
  assert.equal(disabled.state.deliveries, 0);
});

test('matriz/directa: éxito con organizacion_id crea sede/vínculo/rol y estados explícitos', async t => {
  const { state, directa } = await start(t, { authUser: SUPER_USER });
  const result = await directa({ ...DIRECTA_BODY, organizacion_id: 'org-fixture' });
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(typeof result.body.sede_id, 'number');
  assert.equal(result.body.access_state, 'sign_in_or_recovery');
  assert.equal(result.body.welcome_delivery, 'not_requested_existing_account');
  assertNoCredentialFields(result.body);
  assert.equal(state.authUsers, 1);
  assert.equal(state.lastAuthEmail, LIC_EMAIL);
  assert.equal(state.deliveries, 0);
  assert.equal(state.tables.sedes.length, 1);
  assert.equal(state.tables.organizacion_sedes.length, 1);
  assert.equal(state.tables.organizacion_sedes[0].organizacion_id, 'org-fixture');
  assert.equal(state.tables.organizacion_sedes[0].sede_id, result.body.sede_id);
  const role = state.tables.user_roles.find((row) => row.email === LIC_EMAIL);
  assert.ok(role);
  assert.equal(role.role, 'admin_club');
  assert.equal(role.alcance, 'sede');
  assert.equal(role.sede_id, result.body.sede_id);
});

test('matriz/directa: cuenta nueva con outbound on/off reporta estados sin prometer entrega', async t => {
  const enabled = await start(t, { authUser: SUPER_USER, outboundEnabled: true });
  enabled.state.newUser = true;
  const requested = await enabled.directa();
  assert.equal(requested.status, 200, JSON.stringify(requested.body));
  assert.equal(requested.body.access_state, 'recovery_email_requested');
  assert.equal(requested.body.welcome_delivery, 'requested_not_verified');
  assertNoCredentialFields(requested.body);
  assert.equal(enabled.state.deliveries, 1);
  assert.equal(enabled.state.tables.sedes.length, 1);

  const disabled = await start(t, { authUser: SUPER_USER });
  disabled.state.newUser = true;
  const skipped = await disabled.directa();
  assert.equal(skipped.status, 200, JSON.stringify(skipped.body));
  assert.equal(skipped.body.access_state, 'new_account_delivery_disabled');
  assert.equal(skipped.body.welcome_delivery, 'disabled');
  assert.equal(disabled.state.deliveries, 0);
});

test('matriz/aprobar: éxito crea sede/vínculo/rol, marca aprobada y expone estados', async t => {
  const { state, aprobar } = await start(t, {
    authUser: SUPER_USER,
    pendientes: [pendingRow({ organizacion_id: 'org-fixture' })],
  });
  const result = await aprobar();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(result.body.access_state, 'sign_in_or_recovery');
  assert.equal(result.body.welcome_delivery, 'not_requested_existing_account');
  assertNoCredentialFields(result.body);
  assert.equal(state.authUsers, 1);
  assert.equal(state.deliveries, 0);
  assert.equal(state.tables.sedes.length, 1);
  assert.equal(state.tables.organizacion_sedes.length, 1);
  assert.equal(state.tables.sedes_pendientes[0].estado, 'aprobada');
  const role = state.tables.user_roles.find((row) => row.email === LIC_EMAIL);
  assert.equal(role.role, 'admin_club');
  assert.equal(role.sede_id, result.body.sede_id);
});

test('matriz/aprobar: preservaAdminCadena conserva el rol de cadena y sólo crea sede/vínculo', async t => {
  const cadenaRole = {
    id: 2, user_id: 'fixture-cadena-user', email: CADENA_EMAIL, role: 'admin_cadena',
    alcance: 'organizacion', organizacion_id: 'org-fixture', sede_id: null,
  };
  const { state, aprobar } = await start(t, {
    authUser: SUPER_USER,
    userRoles: [superRoleRow(), clone(cadenaRole)],
    pendientes: [pendingRow({ created_by: CADENA_EMAIL, licenciatario_email: CADENA_EMAIL, organizacion_id: 'org-fixture' })],
  });
  const roleBefore = clone(state.tables.user_roles);
  const result = await aprobar();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.ok, true);
  assert.equal(state.lastAuthEmail, CADENA_EMAIL);
  assert.deepEqual(state.tables.user_roles, roleBefore);
  assert.equal(state.writes.some((write) => write.table === 'user_roles'), false);
  assert.equal(state.tables.sedes.length, 1);
  assert.equal(state.tables.organizacion_sedes.length, 1);
  assert.equal(state.tables.sedes_pendientes[0].estado, 'aprobada');
});

test('matriz/aprobar: cuenta nueva con outbound off no dispara email y reporta entrega deshabilitada', async t => {
  const { state, aprobar } = await start(t, { authUser: SUPER_USER, pendientes: [pendingRow()] });
  state.newUser = true;
  const result = await aprobar();
  assert.equal(result.status, 200, JSON.stringify(result.body));
  assert.equal(result.body.access_state, 'new_account_delivery_disabled');
  assert.equal(result.body.welcome_delivery, 'disabled');
  assert.equal(state.deliveries, 0);
  assert.equal(state.tables.sedes.length, 1);
});

// ---------------------------------------------------------------------------
// Reintento secuencial fallo Auth -> éxito (sin garantía concurrente).
// ---------------------------------------------------------------------------

test('retry/geo: fallo Auth y reintento completan una sola vez; replay 410 sin writes', async t => {
  const { state, geo } = await start(t, { invitaciones: [geoInvitation()] });
  state.failAuth = true;
  assert.equal((await geo()).status, 503);
  assert.equal(state.tables.invitaciones_admin[0].estado, 'pendiente');
  assert.deepEqual(state.writes, []);
  state.failAuth = false;
  const recovered = await geo();
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  assert.equal(state.tables.invitaciones_admin[0].estado, 'completada');
  assert.equal(state.tables.sedes.length, 0);
  assert.equal(state.tables.user_roles.filter((row) => row.email === GEO_EMAIL).length, 1);
  assert.equal(state.authUsers, 2);
  const writes = state.writes.length;
  const replay = await geo();
  assert.equal(replay.status, 410);
  assert.equal(state.writes.length, writes);
  assert.equal(state.authUsers, 2);
});

test('retry/directa: fallo Auth y reintento crean una única sede/vínculo/asignación', async t => {
  const { state, directa } = await start(t, { authUser: SUPER_USER });
  state.failAuth = true;
  assert.equal((await directa({ ...DIRECTA_BODY, organizacion_id: 'org-fixture' })).status, 503);
  assert.equal(state.tables.sedes.length, 0);
  assert.deepEqual(state.writes, []);
  state.failAuth = false;
  const recovered = await directa({ ...DIRECTA_BODY, organizacion_id: 'org-fixture' });
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(state.authUsers, 2);
  assert.equal(state.tables.sedes.length, 1);
  assert.equal(state.tables.organizacion_sedes.length, 1);
  assert.equal(state.tables.user_roles.filter((row) => row.email === LIC_EMAIL).length, 1);
});

test('retry/aprobar: fallo Auth y reintento aprueban una sola vez; replay no duplica', async t => {
  const { state, aprobar } = await start(t, {
    authUser: SUPER_USER,
    pendientes: [pendingRow({ organizacion_id: 'org-fixture' })],
  });
  state.failAuth = true;
  assert.equal((await aprobar()).status, 503);
  assert.equal(state.tables.sedes_pendientes[0].estado, 'pendiente');
  assert.deepEqual(state.writes, []);
  state.failAuth = false;
  const recovered = await aprobar();
  assert.equal(recovered.status, 200, JSON.stringify(recovered.body));
  assert.equal(state.authUsers, 2);
  assert.equal(state.tables.sedes.length, 1);
  assert.equal(state.tables.organizacion_sedes.length, 1);
  assert.equal(state.tables.user_roles.filter((row) => row.email === LIC_EMAIL).length, 1);
  assert.equal(state.tables.sedes_pendientes[0].estado, 'aprobada');
  const writes = state.writes.length;
  assert.equal((await aprobar()).status, 400);
  assert.equal(state.writes.length, writes);
  assert.equal(state.tables.sedes.length, 1);
  assert.equal(state.authUsers, 2);
});

// ---------------------------------------------------------------------------
// Error real del update final: nunca 2xx, sin rollback fingido.
// ---------------------------------------------------------------------------

test('repro/geo: error al completar la invitación no devuelve 2xx ni oculta el rol ya asignado', async t => {
  const { state, geo } = await start(t, { invitaciones: [geoInvitation()] });
  state.failUpdateTable = 'invitaciones_admin';
  const result = await geo();
  assert.notEqual(result.status, 201);
  assert.equal(result.status, 500, JSON.stringify(result.body));
  assert.equal(result.body.code, 'INVITACION_UPDATE_FAILED');
  assert.equal(result.body.role_assigned, true);
  assertNoFailureLeak(result.body);
  assert.equal(state.tables.invitaciones_admin[0].estado, 'pendiente');
  assert.ok(state.tables.user_roles.some((row) => row.email === GEO_EMAIL));
});

test('repro/aprobar: error al marcar aprobada no devuelve 2xx y revierte sede/vínculo', async t => {
  const { state, aprobar } = await start(t, {
    authUser: SUPER_USER,
    pendientes: [pendingRow({ organizacion_id: 'org-fixture' })],
  });
  state.failUpdateTable = 'sedes_pendientes';
  const result = await aprobar();
  assert.notEqual(result.status, 200);
  assert.equal(result.status, 500, JSON.stringify(result.body));
  assert.equal(result.body.code, 'SEDE_APPROVAL_ATOMIC_FAILED');
  assert.equal(result.body.sede_created, undefined);
  assertNoFailureLeak(result.body);
  assert.equal(state.tables.sedes_pendientes[0].estado, 'pendiente');
  assert.equal(state.tables.sedes.length, 0);
  assert.equal(state.tables.organizacion_sedes.length, 0);
});

// ---------------------------------------------------------------------------
// Regresión club (contrato aceptado) + guard de outbound.
// ---------------------------------------------------------------------------

test('regresión club: Auth 503 no consume invitación; reintento existente 201; replay 410', async t => {
  const { state, club } = await start(t, {
    invitaciones: [clubInvitation()],
    userRoles: [superRoleRow(), { id: 3, email: CLUB_EMAIL, role: 'admin_club', sede_id: 99 }],
  });
  const rolesBefore = clone(state.tables.user_roles);
  state.failAuth = true;
  const failed = await club();
  assert.equal(failed.status, 503, JSON.stringify(failed.body));
  assert.equal(failed.body.code, 'SEDE_ACCESS_PROVISION_UNAVAILABLE');
  assert.equal(failed.body.retry, true);
  assert.deepEqual(state.writes, []);
  assert.equal(state.tables.invitaciones_admin[0].estado, 'pendiente');
  assert.equal(state.tables.sedes.length, 0);
  assert.deepEqual(state.tables.user_roles, rolesBefore);
  state.failAuth = false;
  const recovered = await club();
  assert.equal(recovered.status, 201, JSON.stringify(recovered.body));
  assert.equal(recovered.body.access_state, 'sign_in_or_recovery');
  assert.equal(recovered.body.welcome_delivery, 'not_requested_existing_account');
  assert.equal(state.tables.sedes.length, 1);
  assert.equal(state.tables.invitaciones_admin[0].estado, 'completada');
  const writes = state.writes.length;
  const replay = await club();
  assert.equal(replay.status, 410);
  assert.equal(state.writes.length, writes);
  assert.equal(state.tables.sedes.length, 1);
});

test('outbound: la suite no realizó ninguna llamada externa real', () => {
  assert.deepEqual(externalFetches, []);
});
