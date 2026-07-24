import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ACCOUNT_DELETION_CONFIRMATION,
  isAccountDeletionConfirmationValid,
  mountAccountDeletionRoutes,
} from '../routes/accountDeletion.js';

function createResponse() {
  return {
    statusCode: 200,
    payload: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
}

function mountHandler(deps) {
  let handler = null;
  mountAccountDeletionRoutes(
    {
      post(path, candidate) {
        assert.equal(path, '/eliminacion-cuenta');
        handler = candidate;
      },
    },
    deps,
  );
  return handler;
}

test('validates the explicit destructive confirmation', () => {
  assert.equal(isAccountDeletionConfirmationValid(ACCOUNT_DELETION_CONFIRMATION), true);
  assert.equal(isAccountDeletionConfirmationValid(' eliminar '), true);
  assert.equal(isAccountDeletionConfirmationValid('confirmar'), false);
});

test('requires an authenticated user', async () => {
  const handler = mountHandler({
    getAuthenticatedUser: async () => ({ user: null, status: 401, error: 'No autorizado' }),
  });
  const res = createResponse();

  await handler({ body: {} }, res);

  assert.equal(res.statusCode, 401);
  assert.equal(res.payload.error, 'No autorizado');
});

test('rejects requests without the explicit confirmation', async () => {
  const handler = mountHandler({
    getAuthenticatedUser: async () => ({
      user: { id: 'user-1', email: 'player@example.com' },
      status: 200,
    }),
  });
  const res = createResponse();

  await handler({ body: { confirmation: 'sí' } }, res);

  assert.equal(res.statusCode, 400);
  assert.equal(res.payload.code, 'ACCOUNT_DELETION_CONFIRMATION_REQUIRED');
});

test('creates an authenticated deletion request without exposing identity', async () => {
  let upsertPayload = null;
  const query = {
    upsert(payload) {
      upsertPayload = payload;
      return this;
    },
    select() {
      return this;
    },
    async single() {
      return {
        data: { status: 'pending', requested_at: '2026-07-24T00:00:00.000Z' },
        error: null,
      };
    },
  };
  const handler = mountHandler({
    getAuthenticatedUser: async () => ({
      user: { id: 'user-1', email: 'Player@Example.com' },
      status: 200,
    }),
    supabaseAdmin: {
      from(table) {
        assert.equal(table, 'account_deletion_requests');
        return query;
      },
    },
  });
  const res = createResponse();

  await handler({
    body: { confirmation: 'ELIMINAR', source: 'web' },
  }, res);

  assert.equal(res.statusCode, 202);
  assert.equal(res.payload.ok, true);
  assert.equal(res.payload.email, undefined);
  assert.equal(upsertPayload.user_id, 'user-1');
  assert.equal(upsertPayload.email, 'player@example.com');
  assert.equal(upsertPayload.source, 'web');
});

test('returns a controlled setup error before the migration is installed', async () => {
  const handler = mountHandler({
    getAuthenticatedUser: async () => ({
      user: { id: 'user-1', email: 'player@example.com' },
      status: 200,
    }),
    supabaseAdmin: {
      from() {
        return {
          upsert() {
            return this;
          },
          select() {
            return this;
          },
          async single() {
            return {
              data: null,
              error: { code: '42P01', message: 'account_deletion_requests does not exist' },
            };
          },
        };
      },
    },
  });
  const res = createResponse();

  await handler({ body: { confirmation: 'ELIMINAR' } }, res);

  assert.equal(res.statusCode, 503);
  assert.equal(res.payload.code, 'ACCOUNT_DELETION_NOT_CONFIGURED');
});
