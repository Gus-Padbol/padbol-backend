import assert from 'node:assert/strict';

import test from 'node:test';

import {
  EXPO_PUSH_SEND_URL,
  buildPushDataForInboxNotification,
  createMobilePushService,
  isExpoPushToken,
  registerMobilePushRoutes,
  sanitizePushData,
  sendExpoPushNotifications,
} from './mobilePushNotifications.js';

const VALID_TOKEN = 'ExponentPushToken[AbCdEf1234567890]';

test('reconoce sólo tokens Expo y no acepta valores arbitrarios', () => {
  assert.equal(isExpoPushToken(VALID_TOKEN), true);
  assert.equal(isExpoPushToken('token-apns-crudo'), false);
  assert.equal(isExpoPushToken(''), false);
});

test('el payload sólo conserva rutas y parámetros permitidos', () => {
  assert.deepEqual(
    sanitizePushData({
      type: 'partido_solicitud',
      route: 'PartidoDetalle',
      params: { partidoId: 42, arbitraryScreen: 'AdminDashboard' },
      eventId: 'event-42',
      secret: 'no debe viajar',
    }),
    {
      type: 'partido_solicitud',
      route: 'PartidoDetalle',
      params: { partidoId: 42 },
      eventId: 'event-42',
    },
  );
  assert.throws(
    () => sanitizePushData({ type: 'partido_solicitud', route: 'AdminDashboard' }),
    (error) => error.code === 'PUSH_ROUTE_INVALID',
  );
  assert.throws(
    () => sanitizePushData({ type: 'partido_solicitud', route: 'PartidoDetalle', params: {} }),
    (error) => error.code === 'PUSH_ROUTE_PARAMS_INVALID',
  );
});

test('convierte links internos conocidos en destinos semánticos', () => {
  assert.deepEqual(
    buildPushDataForInboxNotification({
      tipo: 'resultado_partido',
      link: '/torneo/88/equipos',
      notificationId: 901,
    }),
    {
      type: 'resultado_partido',
      route: 'TorneoDetalle',
      params: { torneoId: 88 },
      notificationId: 901,
    },
  );
});

test('envío Expo reintenta 429 y conserva el payload seguro', async () => {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (calls.length === 1) {
      return { ok: false, status: 429, json: async () => ({ message: 'rate limited' }) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: [{ status: 'ok', id: 'ticket-1' }] }),
    };
  };
  const result = await sendExpoPushNotifications({
    title: 'Reserva confirmada',
    body: 'Tu turno está confirmado.',
    tokens: [{ id: 7, userId: 'user-1', token: VALID_TOKEN }],
    data: { type: 'reserva_confirmada', route: 'Reservas', params: {} },
    fetchImpl,
    sleepImpl: async () => {},
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].url, EXPO_PUSH_SEND_URL);
  assert.deepEqual(JSON.parse(calls[1].options.body)[0].data, {
    type: 'reserva_confirmada',
    route: 'Reservas',
    params: {},
  });
  assert.equal(result.accepted, 1);
});

test('envío Expo no reintenta respuestas 4xx no transitorias', async () => {
  let calls = 0;
  await assert.rejects(
    sendExpoPushNotifications({
      title: 'Título',
      body: 'Mensaje',
      tokens: [VALID_TOKEN],
      data: { type: 'general', route: 'Notificaciones', params: {} },
      fetchImpl: async () => {
        calls += 1;
        return { ok: false, status: 400, json: async () => ({ message: 'bad request' }) };
      },
      sleepImpl: async () => {},
    }),
    (error) => error.code === 'EXPO_HTTP_ERROR',
  );
  assert.equal(calls, 1);
});

test('el servicio falla cerrado si falta service role', async () => {
  const service = createMobilePushService({
    supabaseAdmin: {},
    serviceRoleConfigured: false,
    fetchImpl: async () => {
      throw new Error('no debe llamar red');
    },
  });
  await assert.rejects(
    service.registerToken({
      userId: 'd119a3f1-75af-4ee6-8668-a39706857b79',
      token: VALID_TOKEN,
      platform: 'ios',
      deviceId: 'ee5ecbcb-06c3-4238-bf0b-5792ddf3fb10',
    }),
    (error) => error.status === 503 && error.code === 'PUSH_SERVICE_ROLE_REQUIRED',
  );
});

test('POST de registro toma el usuario del Bearer y no del body', async () => {
  const handlers = new Map();
  const app = {
    post(path, handler) { handlers.set(`POST ${path}`, handler); },
    delete(path, handler) { handlers.set(`DELETE ${path}`, handler); },
    get(path, handler) { handlers.set(`GET ${path}`, handler); },
    patch(path, handler) { handlers.set(`PATCH ${path}`, handler); },
  };
  let received = null;
  registerMobilePushRoutes(app, {
    authUserFromBearer: async () => ({ id: 'authenticated-user' }),
    pushService: {
      registerToken: async (payload) => {
        received = payload;
        return { ok: true, deviceId: payload.deviceId };
      },
    },
    logger: { error() {} },
  });
  const response = {
    statusCode: 200,
    status(code) { this.statusCode = code; return this; },
    json(value) { this.body = value; return this; },
  };
  await handlers.get('POST /api/push-tokens')({
    body: {
      userId: 'attacker-controlled-user',
      token: VALID_TOKEN,
      platform: 'android',
      deviceId: 'ee5ecbcb-06c3-4238-bf0b-5792ddf3fb10',
    },
  }, response);
  assert.equal(response.statusCode, 201);
  assert.equal(received.userId, 'authenticated-user');
  assert.equal(Object.hasOwn(response.body, 'token'), false);
});

test('tener token o permiso del sistema no habilita marketing sin opt-in explícito', async () => {
  const tokenRows = [
    { id: 1, user_id: 'user-default', expo_push_token: VALID_TOKEN, enabled: true },
    { id: 2, user_id: 'user-opt-in', expo_push_token: 'ExpoPushToken[OptIn1234567890]', enabled: true },
    { id: 3, user_id: 'user-opt-out', expo_push_token: 'ExpoPushToken[OptOut1234567890]', enabled: true },
  ];
  const preferenceRows = [
    { user_id: 'user-opt-in', transactional_enabled: false, marketing_enabled: true },
    { user_id: 'user-opt-out', transactional_enabled: true, marketing_enabled: false },
  ];
  const queryFor = (rows) => {
    const filters = [];
    const query = {
      select() { return query; },
      in(column, values) { filters.push((row) => values.includes(row[column])); return query; },
      eq(column, value) { filters.push((row) => row[column] === value); return query; },
      is(column, value) { filters.push((row) => row[column] === value || row[column] == null); return query; },
      range(from, to) { return Promise.resolve({ data: rows.filter((row) => filters.every((fn) => fn(row))).slice(from, to + 1), error: null }); },
      then(resolve, reject) {
        return Promise.resolve({ data: rows.filter((row) => filters.every((fn) => fn(row))), error: null })
          .then(resolve, reject);
      },
    };
    return query;
  };
  const service = createMobilePushService({
    serviceRoleConfigured: true,
    supabaseAdmin: {
      from(table) {
        if (table === 'push_tokens') return queryFor(tokenRows);
        if (table === 'push_notification_preferences') return queryFor(preferenceRows);
        throw new Error(`tabla inesperada: ${table}`);
      },
    },
  });

  const users = ['user-default', 'user-opt-in', 'user-opt-out'];
  assert.deepEqual(
    (await service.fetchEligibleTokens(users, 'marketing')).map((row) => row.userId),
    ['user-opt-in'],
  );
  assert.deepEqual(
    (await service.fetchEligibleTokens(users, 'transactional')).map((row) => row.userId),
    ['user-default', 'user-opt-out'],
  );
});

test('un event idempotente ya reclamado no vuelve a contactar Expo', async () => {
  let networkCalls = 0;
  const existingJob = {
    id: 'job-existing',
    status: 'sent',
    recipient_count: 1,
    token_count: 1,
    accepted_count: 1,
    failed_count: 0,
  };
  const supabaseAdmin = {
    from(table) {
      assert.equal(table, 'push_delivery_jobs');
      return {
        insert() {
          return {
            select() {
              return {
                single: async () => ({ data: null, error: { code: '23505', message: 'duplicate' } }),
              };
            },
          };
        },
        select() {
          return {
            eq() {
              return { maybeSingle: async () => ({ data: existingJob, error: null }) };
            },
          };
        },
      };
    },
  };
  const service = createMobilePushService({
    serviceRoleConfigured: true,
    supabaseAdmin,
    fetchImpl: async () => {
      networkCalls += 1;
      throw new Error('no debe contactar Expo');
    },
  });
  const result = await service.dispatch({
    idempotencyKey: 'reserva_confirmada:reservation-42',
    userIds: ['user-1'],
    title: 'Reserva confirmada',
    body: 'Tu reserva fue confirmada.',
    data: { type: 'reserva_confirmada', route: 'Reservas', params: {}, eventId: 'reservation-42' },
  });
  assert.equal(result.duplicate, true);
  assert.equal(result.jobId, existingJob.id);
  assert.equal(networkCalls, 0);
});
