import test from 'node:test';
import assert from 'node:assert/strict';
import { mapAdminRoleRow, sanitizeAdminSede } from '../routes/adminCore.js';

test('sanitizeAdminSede never exposes payment credentials', () => {
  assert.deepEqual(
    sanitizeAdminSede({
      id: 7,
      nombre: 'Club',
      mp_access_token: 'secret',
      stripe_secret_key: 'secret',
      stripe_account_id: 'acct_public_reference',
    }),
    {
      id: 7,
      nombre: 'Club',
      stripe_account_id: 'acct_public_reference',
    },
  );
});

test('mapAdminRoleRow normalizes role and resolves venue name', () => {
  assert.deepEqual(
    mapAdminRoleRow(
      { user_id: 'u1', email: ' ADMIN@EXAMPLE.COM ', nombre: 'Admin', role: 'ADMIN_CLUB', sede_id: '4' },
      new Map([[4, 'La Meca']]),
    ),
    {
      user_id: 'u1',
      email: 'admin@example.com',
      nombre: 'Admin',
      role: 'admin_club',
      rol: 'admin_club',
      alcance: 'sede',
      sede_id: 4,
      sede_nombre: 'La Meca',
      pais: null,
      provincia: null,
      ciudad: null,
    },
  );
});
