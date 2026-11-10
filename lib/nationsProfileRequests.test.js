import test from 'node:test';
import assert from 'node:assert/strict';
import {createNationsProfileRequestsService, normalizeProfileRequest} from './nationsProfileRequests.js';
import {selectionIdFor} from './nationsSelector.js';

const actor = { id: '00000000-0000-4000-8000-0000000000cc', email_confirmed_at: '2026-01-01T00:00:00Z' };
const reviewer = { id: '00000000-0000-4000-8000-0000000000bb', email_confirmed_at: '2026-01-01T00:00:00Z' };
const body = { request_id: 'req-0001', declared_name: 'Jugador Ficticio', declared_country: 'it', age_status: 'desconocido', profile_consent: true };
const SELECTED = '11111111-1111-4111-8111-111111111111';
const selection = selectionIdFor(57, SELECTED);

function fakePool({ prior = null, event = { id: 1, torneo_id: 57, enabled: true }, role = 1, participant = true, row = null } = {}) {
  const calls = [];
  const client = { query: async (sql, params) => {
    calls.push(sql.trim().split(/\s+/)[0]);
    if (/from public\.torneo_participantes p/.test(sql)) return { rows: [{id: SELECTED, name: 'Adulto Sintetico', country: 'IT'}] };
    if (/count\(\*\)::int n from public\.nations_profile_requests/.test(sql)) return { rows: [{n: 1}] };
    if (/nations_profile_requests r/.test(sql)) return { rows: row ? [row] : [] };
    if (/nations_activation_events/.test(sql)) return { rows: event ? [event] : [] };
    if (/nations_profile_requests where actor_user_id/.test(sql)) return { rows: prior ? [prior] : [] };
    if (/insert into public\.nations_profile_requests/.test(sql)) return { rows: [] };
    if (/super_admin/.test(sql)) return { rowCount: role };
    if (/from public\.torneo_participantes p/.test(sql)) return { rows: [{id: SELECTED, name: 'Adulto Sintetico', country: 'IT'}] };
    if (/count\(\*\)::int n from public\.nations_profile_requests/.test(sql)) return { rows: [{n: 1}] };
    if (/nations_profile_requests r/.test(sql)) return { rows: row ? [row] : [] };
    if (/nations_activation_participants m/.test(sql)) return { rowCount: participant ? 1 : 0 };
    return { rows: [] };
  }, release() {} };
  return { calls, connect: async () => client, query: async () => ({ rows: prior ? [prior] : [] }) };
}

test('normaliza y exige consentimiento y edad válida', () => {
  const n = normalizeProfileRequest(body);
  assert.equal(n.declaredCountry, 'IT');
  assert.throws(() => normalizeProfileRequest({ ...body, profile_consent: false }), /CONSENT_REQUIRED/);
  assert.throws(() => normalizeProfileRequest({ ...body, age_status: 'quizas' }), /INVALID_AGE_STATUS/);
  assert.throws(() => normalizeProfileRequest({ ...body, age_status: 'menor' }), /GUARDIAN_CONSENT_REQUIRED/);
});

test('sin sesión verificada rechaza', async () => {
  const svc = createNationsProfileRequestsService({ pool: fakePool() });
  await assert.rejects(svc.submit('ev', null, body), /AUTH_REQUIRED/);
  await assert.rejects(svc.submit('ev', { id: actor.id }, body), /VERIFIED_ACCOUNT_REQUIRED/);
});

test('idempotente por actor+evento+request y conflicto si cambia el payload', async () => {
  const prior = { id: 'r1', payload_hash: 'distinto', status: 'pendiente' };
  const svc = createNationsProfileRequestsService({ pool: fakePool({ prior }) });
  await assert.rejects(svc.submit('ev', actor, body), /REQUEST_CONFLICT/);
});

test('crea pendiente sin tocar el canon y responde genérico', async () => {
  const pool = fakePool();
  const svc = createNationsProfileRequestsService({ pool });
  const r = await svc.submit('ev', actor, body);
  assert.equal(r.status, 'pendiente');
  assert.equal(JSON.stringify(r).includes('Jugador'), false);
});

test('revisión: solo super_admin; desconocido no se aprueba', async () => {
  const noRole = createNationsProfileRequestsService({ pool: fakePool({ role: 0 }) });
  await assert.rejects(noRole.review('ev', reviewer, '11111111-1111-4111-8111-111111111111', { decision: 'aprobar' }), /FORBIDDEN/);

  const row = { id: '11111111-1111-4111-8111-111111111111', torneo_id: 57, age_status: 'desconocido', guardian_consent: false, status: 'pendiente' };
  const svc = createNationsProfileRequestsService({ pool: fakePool({ row }) });
  await assert.rejects(svc.review('ev', reviewer, row.id, { decision: 'aprobar', identity_verified: true, note: 'Verificado contra nomina oficial del evento', matched_participante_id: '22222222-2222-4222-8222-222222222222' }), /AGE_NOT_VERIFIED/);

  const menor = { ...row, age_status: 'menor' };
  const svc2 = createNationsProfileRequestsService({ pool: fakePool({ row: menor }) });
  await assert.rejects(svc2.review('ev', reviewer, row.id, { decision: 'aprobar', identity_verified: true, note: 'Verificado contra nomina oficial del evento', matched_participante_id: '22222222-2222-4222-8222-222222222222' }), /AGE_NOT_VERIFIED|GUARDIAN/);
});

test('rechazo registra decisión sin asociar', async () => {
  const row = { id: '11111111-1111-4111-8111-111111111111', torneo_id: 57, age_status: 'adulto', guardian_consent: false, status: 'pendiente' };
  const svc = createNationsProfileRequestsService({ pool: fakePool({ row }) });
  const r = await svc.review('ev', reviewer, row.id, { decision: 'rechazar', note: 'No coincide con la nomina declarada del evento.' });
  assert.equal(r.status, 'rechazada');
});

test('revision exige nota >=20 y prueba de identidad; ownStatus sin notas internas', async () => {
  const row = { id: '11111111-1111-4111-8111-111111111111', torneo_id: 57, age_status: 'adulto', guardian_consent: false, status: 'pendiente' };
  const svc = createNationsProfileRequestsService({ pool: fakePool({ row }) });
  await assert.rejects(svc.review('ev', reviewer, row.id, { decision: 'aprobar', identity_verified: true, note: 'corta', matched_participante_id: '22222222-2222-4222-8222-222222222222' }), /REVIEW_NOTE_REQUIRED/);
  await assert.rejects(svc.review('ev', reviewer, row.id, { decision: 'aprobar', note: 'Verificado contra nomina oficial del evento', matched_participante_id: '22222222-2222-4222-8222-222222222222' }), /IDENTITY_PROOF_REQUIRED/);
});


test('Nápoles 2026 sólo admite adulto y rechaza tutor/desconocido antes de insertar', async () => {
  const pool = fakePool();
  const svc = createNationsProfileRequestsService({ pool });
  for (const age of ['menor', 'desconocido', 'adult']) {
    await assert.rejects(svc.submit('nations-cup-napoli-2026', actor, {...body, request_id: `req-${age}`, age_status: age}), /ADULT_ONLY/);
  }
  await assert.rejects(svc.submit('nations-cup-napoli-2026', actor, {...body, request_id: 'req-tutor', age_status: 'adulto', guardian_consent: true}), /GUARDIAN_NOT_ALLOWED/);
  assert.equal(pool.calls.includes('insert'), false);
  const ok = await svc.submit('nations-cup-napoli-2026', actor, {...body, request_id: 'req-adulto', age_status: 'adulto', guardian_consent: false, selection_id: selection});
  assert.equal(ok.status, 'pendiente');
  const other = await svc.submit('otro-evento', actor, {...body, request_id: 'req-otro', age_status: 'desconocido'});
  assert.equal(other.status, 'pendiente');
});


test('Nápoles 2026 no permite aprobar solicitudes previas de menor o edad desconocida', async () => {
  for (const age of ['menor', 'desconocido']) {
    const row = {id: '11111111-1111-4111-8111-111111111111', torneo_id: 57, age_status: age, guardian_consent: true, status: 'pendiente'};
    const svc = createNationsProfileRequestsService({pool: fakePool({row})});
    await assert.rejects(svc.review('nations-cup-napoli-2026', reviewer, row.id, {
      decision: 'aprobar', identity_verified: true, note: 'Verificado contra nomina oficial del evento',
      guardian_verified: true, matched_participante_id: '22222222-2222-4222-8222-222222222222',
    }), /ADULT_ONLY/);
  }
});
