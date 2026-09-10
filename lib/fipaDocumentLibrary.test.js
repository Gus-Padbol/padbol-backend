import assert from 'node:assert/strict';

import fs from 'node:fs';

import path from 'node:path';

import test from 'node:test';

import { fileURLToPath } from 'node:url';

import {
  FIPA_DOCUMENT_BUCKET,
  FIPA_DOWNLOAD_LIMIT,
  FIPA_LIBRARY_PURPOSES,
  FIPA_SIGNED_URL_TTL_SECONDS,
  canDownloadFipaDocument,
  isActiveFipaGrant,
  isOfficialFipaVenue,
  isValidFipaResourceId,
  isVerifiedFipaMembershipOrigin,
  parseFipaAccessRequestBody,
  parseFipaLibraryProfileBody,
  publicFipaDocument,
  registerFipaDocumentLibraryRoutes,
  strictSuperAdminRole,
  requestReasonForVenue,
} from './fipaDocumentLibrary.js';

test('la autorización institucional consulta el usuario y falla cerrada ante errores', async () => {
  assert.equal(await strictSuperAdminRole({}, null), false);
  const filters = [];
  let result = { data: [], error: null };
  const query = {
    select() { return this; },
    eq(key, value) { filters.push([key, value]); return this; },
    async limit() { return result; },
  };
  const db = { from(table) { assert.equal(table, 'user_roles'); return query; } };
  assert.equal(await strictSuperAdminRole(db, 'verified-user'), false);
  assert.deepEqual(filters, [['user_id', 'verified-user'], ['role', 'super_admin']]);
  result = { data: [{ role: 'super_admin' }], error: null };
  assert.equal(await strictSuperAdminRole(db, 'verified-user'), true);
  result = { data: [{ role: 'super_admin' }], error: { message: 'offline' } };
  await assert.rejects(strictSuperAdminRole(db, 'verified-user'));
});

function fakeApp() {
  const routes = new Map();
  for (const method of ['get', 'post', 'put', 'patch']) {
    routes[method] = new Map();
  }
  return {
    routes,
    get(route, handler) { routes.get.set(route, handler); },
    post(route, handler) { routes.post.set(route, handler); },
    put(route, handler) { routes.put.set(route, handler); },
    patch(route, handler) { routes.patch.set(route, handler); },
  };
}

function fakeResponse() {
  return {
    statusCode: 200,
    headers: {},
    body: null,
    set(name, value) { this.headers[name] = value; return this; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}

test('descarga autenticada emite enlace sólo después de auditar y no lo expone si falla la auditoría', async () => {
  for (const failure of [null, 'download_authorized', 'download_link_issued']) {
    const events = [];
    let signCalls = 0;
    const documentId = '7f34e2cc-6204-4a82-b572-1310475a7f95';
    const db = {
      from(table) {
        return {
          select() { return this; },
          eq() { return this; },
          async gte() { return { count: 0, error: null }; },
          async maybeSingle() {
            if (table === 'fipa_library_documents') return { data: {
              id: documentId, access_level: 'authenticated', version: '2026',
              storage_path: 'private/rules.pdf', original_filename: 'reglamento.pdf',
            }, error: null };
            assert.equal(table, 'fipa_library_profiles');
            return { data: { purpose: 'aprender_jugar' }, error: null };
          },
          async insert(event) {
            events.push(event.event_type);
            return { error: event.event_type === failure ? { message: 'audit unavailable' } : null };
          },
        };
      },
      storage: { from(bucket) {
        assert.equal(bucket, FIPA_DOCUMENT_BUCKET);
        return { async createSignedUrl(storagePath, ttl) {
          assert.ok(events.includes('download_authorized'));
          assert.equal(storagePath, 'private/rules.pdf');
          assert.equal(ttl, 60);
          signCalls += 1;
          return { data: { signedUrl: 'https://example.test/signed-document' }, error: null };
        } };
      } },
    };
    const app = fakeApp();
    registerFipaDocumentLibraryRoutes(app, {
      supabaseAdmin: db, serviceRoleConfigured: true,
      authUserFromBearer: async () => ({ id: 'account-user' }),
    });
    const response = fakeResponse();
    await app.routes.post.get('/api/fipa/biblioteca/documentos/:documentId/descarga')(
      { params: { documentId } }, response,
    );
    assert.equal(response.headers['Cache-Control'], 'no-store, private');
    assert.equal(response.statusCode, failure ? 503 : 200);
    assert.equal(Boolean(response.body.download_url), !failure);
    assert.equal(signCalls, failure === 'download_authorized' ? 0 : 1);
  }
});

test('una sede oficial requiere estado activo y número de licencia real', () => {
  assert.equal(isOfficialFipaVenue({ licencia_activa: true, numero_licencia: 'PAD-001' }), true);
  assert.equal(isOfficialFipaVenue({ licencia_activa: true, numero_licencia: '  ' }), false);
  assert.equal(isOfficialFipaVenue({ licencia_activa: false, numero_licencia: 'PAD-001' }), false);
});

test('membresía y grants usan señales verificables, vigentes y revocables', () => {
  assert.equal(isVerifiedFipaMembershipOrigin('membresia'), true);
  assert.equal(isVerifiedFipaMembershipOrigin('manual'), true);
  assert.equal(isVerifiedFipaMembershipOrigin('reserva'), false);
  const now = new Date('2026-09-08T12:00:00Z');
  assert.equal(isActiveFipaGrant({ status: 'active', revoked_at: null, expires_at: '2026-09-09T00:00:00Z' }, now), true);
  assert.equal(isActiveFipaGrant({ status: 'active', revoked_at: null, expires_at: '2026-09-08T11:59:59Z' }, now), false);
  assert.equal(isActiveFipaGrant({ status: 'revoked', revoked_at: '2026-09-08T10:00:00Z' }, now), false);
});

test('la ficha habilita documentos de cuenta pero no reemplaza la membresía', () => {
  assert.equal(canDownloadFipaDocument({ profileComplete: false, accessLevel: 'authenticated', memberAllowed: false }), false);
  assert.equal(canDownloadFipaDocument({ profileComplete: true, accessLevel: 'authenticated', memberAllowed: false }), true);
  assert.equal(canDownloadFipaDocument({ profileComplete: true, accessLevel: 'member', memberAllowed: false }), false);
  assert.equal(canDownloadFipaDocument({ profileComplete: true, accessLevel: 'member', memberAllowed: true }), true);
});

test('los endpoints sólo aceptan identificadores UUID, nunca paths del cliente', () => {
  assert.equal(isValidFipaResourceId('7f34e2cc-6204-4a82-b572-1310475a7f95'), true);
  assert.equal(isValidFipaResourceId('../../reglamento.pdf'), false);
  assert.equal(isValidFipaResourceId('reglamento-oficial'), false);
});

test('la solicitud acepta sede elegida o exige datos completos para cancha no listada', () => {
  assert.deepEqual(parseFipaAccessRequestBody({ sede_id: 15 }), {
    ok: true,
    declaredVenueId: 15,
    venueNotListed: false,
    declared: { club_name: null, country: null, city: null, address: null },
  });
  const free = parseFipaAccessRequestBody({
    cancha_no_encontrada: true,
    nombre_cancha: 'Club del Barrio',
    pais: 'Argentina',
    ciudad: 'La Plata',
    direccion_ubicacion: 'Calle 1 y 50',
  });
  assert.equal(free.ok, true);
  assert.equal(free.declared.club_name, 'Club del Barrio');
  assert.equal(parseFipaAccessRequestBody({ cancha_no_encontrada: true }).code, 'venue_details_required');
  assert.equal(parseFipaAccessRequestBody({}).code, 'venue_selection_required');
});

test('la ficha exige propósito y respuestas, y WhatsApp sólo entra con consentimiento', () => {
  assert.equal(FIPA_LIBRARY_PURPOSES.size, 8);
  const valid = parseFipaLibraryProfileBody({
    purpose: 'aprender_jugar',
    plays_padbol: 'no',
    linked_to_club: 'prefer_not',
  });
  assert.equal(valid.ok, true);
  assert.equal(valid.whatsapp, null);
  assert.equal(parseFipaLibraryProfileBody({
    purpose: 'otro',
    plays_padbol: 'yes',
    linked_to_club: 'no',
  }).code, 'profile_other_purpose_required');
  assert.equal(parseFipaLibraryProfileBody({
    purpose: 'jugador',
    plays_padbol: 'yes',
    linked_to_club: 'no',
    whatsapp: '+54 9 11 5555 5555',
  }).code, 'whatsapp_consent_required');
  assert.equal(parseFipaLibraryProfileBody({
    purpose: 'jugador',
    plays_padbol: 'yes',
    linked_to_club: 'yes',
  }).code, 'profile_venue_required');
});

test('el DTO público nunca expone la ruta del bucket', () => {
  const dto = publicFipaDocument({
    id: 'doc-1',
    slug: 'manual-organizador',
    title: 'Manual',
    category: 'organizacion',
    locale: 'es-en',
    version: '2026',
    original_filename: 'manual.pdf',
    byte_size: 10,
    sha256: 'a'.repeat(64),
    access_level: 'member',
    published_at: '2026-09-08T00:00:00Z',
    storage_path: 'privado/manual.pdf',
  }, false);
  assert.equal(dto.can_download, false);
  assert.equal('storage_path' in dto, false);
});

test('el módulo falla cerrado cuando no hay service role', async () => {
  const app = fakeApp();
  registerFipaDocumentLibraryRoutes(app, {
    supabaseAdmin: {},
    serviceRoleConfigured: false,
    authUserFromBearer: async () => ({ id: 'user-1', email: 'user@example.com' }),
  });
  const response = fakeResponse();
  await app.routes.get.get('/api/fipa/biblioteca/documentos')({ headers: {} }, response);
  assert.equal(response.statusCode, 503);
  assert.equal(response.body.code, 'fipa_library_unavailable');
  assert.equal(response.headers['Cache-Control'], 'no-store, private');
});

test('sin sesión la biblioteca responde 401 antes de consultar datos', async () => {
  const app = fakeApp();
  registerFipaDocumentLibraryRoutes(app, {
    supabaseAdmin: {},
    serviceRoleConfigured: true,
    authUserFromBearer: async () => null,
  });
  const response = fakeResponse();
  await app.routes.get.get('/api/fipa/biblioteca/documentos')({ headers: {} }, response);
  assert.equal(response.statusCode, 401);
  assert.equal(response.body.code, 'authentication_required');
});
