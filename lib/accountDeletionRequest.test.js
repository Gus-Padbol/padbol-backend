import assert from 'node:assert/strict';

import test from 'node:test';

import {
  ACCOUNT_DELETION_CONFIRMATION,
  ACTIVE_ACCOUNT_DELETION_STATUSES,
  buildAccountDeletionAcceptedResponse,
  parseAccountDeletionRequestBody,
} from './accountDeletionRequest.js';

test('requires an explicit destructive confirmation', () => {
  assert.equal(ACCOUNT_DELETION_CONFIRMATION, 'ELIMINAR');
  assert.deepEqual(ACTIVE_ACCOUNT_DELETION_STATUSES, ['solicitada', 'en_proceso', 'retenida']);
  assert.deepEqual(parseAccountDeletionRequestBody({ confirmation: 'eliminar' }), {
    ok: false,
    status: 400,
    code: 'explicit_confirmation_required',
    error: 'Escribí ELIMINAR para confirmar la solicitud.',
  });
});

test('accepts only known sources and trims the app version', () => {
  assert.deepEqual(
    parseAccountDeletionRequestBody({
      confirmation: 'ELIMINAR',
      source: 'NATIVE',
      app_version: `  ${'1'.repeat(50)}  `,
    }),
    {
      ok: true,
      source: 'native',
      evidence: {
        requested_via: 'authenticated_native',
        source: 'native',
        app_version: '1'.repeat(40),
      },
    },
  );

  assert.deepEqual(
    parseAccountDeletionRequestBody({ confirmation: 'ELIMINAR', source: 'admin-panel' }),
    {
      ok: true,
      source: 'unknown',
      evidence: {
        requested_via: 'authenticated_backend',
        source: 'unknown',
      },
    },
  );
});

test('returns a truthful pending response for new and repeated requests', () => {
  const request = { id: 42, solicitado_at: '2026-09-07T12:00:00.000Z' };
  assert.deepEqual(buildAccountDeletionAcceptedResponse(request), {
    ok: true,
    status: 'pending',
    requested_at: request.solicitado_at,
    request_id: 42,
    next_step: 'pending_retention_review',
    idempotent: false,
    message: 'Registramos tu solicitud. La cuenta y los datos se revisarán según los plazos y retenciones legales aplicables.',
  });
  assert.match(buildAccountDeletionAcceptedResponse(request, { idempotent: true }).message, /no generamos un pedido duplicado/i);
});
