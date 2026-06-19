import test from 'node:test';
import assert from 'node:assert/strict';
import { AI_MESSAGE_MAX_LENGTH, AI_PUBLIC_ERROR } from '../src/ai/constants.js';
import { sanitizeAllowedParams, validateAiChatRequest } from '../src/ai/context/allowlist.js';
import { buildServerSideAiContext } from '../src/ai/context/buildServerContext.js';
import { buildAiChatErrorResponse, processAiChatRequest } from '../src/ai/gateway/chatGateway.js';
import { createAiRouter } from '../src/routes/ai.js';

function mockProvider(reply = 'Hola, soy Chivi.') {
  return {
    name: 'mock',
    async completeChat() {
      return { reply, provider: 'mock', model: 'mock-model' };
    },
  };
}

function createMockRes() {
  const res = {
    statusCode: 200,
    body: null,
    headersSent: false,
  };
  res.status = (code) => {
    res.statusCode = code;
    return res;
  };
  res.json = (body) => {
    res.body = body;
    return res;
  };
  return res;
}

test('validateAiChatRequest rejects client context with 400', () => {
  assert.throws(
    () => validateAiChatRequest({
      skill: 'chivi-general',
      message: 'hola',
      context: { email: 'test@example.com' },
    }),
    (err) => err.status === 400 && err.code === 'AI_CONTEXT_NOT_ALLOWED',
  );
});

test('validateAiChatRequest rejects empty message', () => {
  assert.throws(
    () => validateAiChatRequest({ skill: 'chivi-general', message: '   ' }),
    (err) => err.status === 400,
  );
});

test('validateAiChatRequest rejects message over 800 chars', () => {
  assert.throws(
    () => validateAiChatRequest({
      skill: 'chivi-general',
      message: 'x'.repeat(AI_MESSAGE_MAX_LENGTH + 1),
    }),
    (err) => err.status === 400 && /800/.test(err.message),
  );
});

test('validateAiChatRequest rejects unsupported skill', () => {
  assert.throws(
    () => validateAiChatRequest({ skill: 'club-manager', message: 'hola' }),
    (err) => err.status === 400 && err.code === 'AI_SKILL_NOT_ALLOWED',
  );
});

test('sanitizeAllowedParams rejects unknown keys', () => {
  assert.throws(
    () => sanitizeAllowedParams({ sede_id: 1, email: 'a@b.com' }),
    (err) => err.status === 400 && /email/.test(err.message),
  );
});

test('processAiChatRequest returns 200 payload with mock provider', async () => {
  const result = await processAiChatRequest({
    user: { id: '11111111-2222-3333-4444-555555555555' },
    body: {
      skill: 'chivi-general',
      message: '¿Qué es Padbol?',
      params: { sede_id: 1, screen: 'home', deporte: 'padbol' },
    },
    pgPool: null,
    provider: mockProvider('Padbol es un deporte argentino.'),
  });

  assert.equal(result.skill, 'chivi-general');
  assert.match(result.prompt_version, /^chivi-general@/);
  assert.equal(result.provider, 'mock');
  assert.match(result.reply, /Padbol/i);
});

test('buildServerSideAiContext excludes email and uses user_ref', async () => {
  const ctx = await buildServerSideAiContext({
    userId: '11111111-2222-3333-4444-555555555555',
    params: { screen: 'reservas', deporte: 'padbol' },
    pgPool: null,
  });

  assert.equal(ctx.user_ref, '11111111');
  assert.equal(ctx.screen, 'reservas');
  assert.equal(ctx.deporte, 'padbol');
  assert.equal(ctx.email, undefined);
});

test('buildAiChatErrorResponse hides provider failures', () => {
  const err = new Error('AI provider error (502)');
  err.status = 502;
  err.code = 'AI_PROVIDER_ERROR';

  const { status, body } = buildAiChatErrorResponse(err);

  assert.equal(status, 500);
  assert.equal(body.error, AI_PUBLIC_ERROR);
  assert.doesNotMatch(body.error, /502|provider/i);
});

test('POST /api/ai/chat without JWT returns 401', async () => {
  const router = createAiRouter({
    getAuthenticatedUser: async () => ({
      user: null,
      status: 401,
      error: 'Se requiere Authorization Bearer token',
    }),
    pgPool: null,
    provider: mockProvider(),
  });

  const handler = router.stack.find((layer) => layer.route?.path === '/chat')?.route.stack[0].handle;
  assert.ok(handler, 'chat handler registered');

  const req = { body: { skill: 'chivi-general', message: 'hola' }, headers: {} };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 401);
  assert.match(res.body.error, /Bearer/i);
});

test('POST /api/ai/chat with JWT and mock provider returns 200', async () => {
  const router = createAiRouter({
    getAuthenticatedUser: async () => ({
      user: { id: 'user-123' },
      status: null,
      error: null,
    }),
    pgPool: null,
    provider: mockProvider('Respuesta Chivi'),
  });

  const handler = router.stack.find((layer) => layer.route?.path === '/chat')?.route.stack[0].handle;
  const req = {
    body: { skill: 'chivi-general', message: 'hola' },
    headers: { authorization: 'Bearer test-token' },
  };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.reply, 'Respuesta Chivi');
  assert.equal(res.body.skill, 'chivi-general');
});

test('POST /api/ai/chat provider error returns generic 500', async () => {
  const router = createAiRouter({
    getAuthenticatedUser: async () => ({ user: { id: 'user-123' }, status: null, error: null }),
    pgPool: null,
    provider: {
      name: 'mock-fail',
      async completeChat() {
        const err = new Error('upstream fail');
        err.status = 502;
        throw err;
      },
    },
  });

  const handler = router.stack.find((layer) => layer.route?.path === '/chat')?.route.stack[0].handle;
  const req = { body: { skill: 'chivi-general', message: 'hola' }, headers: {} };
  const res = createMockRes();

  await handler(req, res);

  assert.equal(res.statusCode, 500);
  assert.equal(res.body.ok, false);
  assert.equal(res.body.error, AI_PUBLIC_ERROR);
});
