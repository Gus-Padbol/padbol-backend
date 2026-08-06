import test from 'node:test';
import assert from 'node:assert/strict';
import { mountAdminProfesoresRoutes } from './adminProfesores.js';

test('admin instructor routes are registered in the production backend', () => {
  const registered = [];
  const app = {
    get(path) { registered.push(`GET ${path}`); },
    patch(path) { registered.push(`PATCH ${path}`); },
  };
  mountAdminProfesoresRoutes(app, {
    supabaseAdmin: {},
    getAuthenticatedUser: async () => ({}),
    fetchUserRoleRowForAuthUser: async () => ({}),
  });
  assert.deepEqual(registered, [
    'GET /api/admin/profesores-todos',
    'PATCH /api/admin/profesores/:profesorId/aprobar',
    'PATCH /api/admin/profesores/:profesorId/rechazar',
    'PATCH /api/admin/profesores/:profesorId',
  ]);
});
