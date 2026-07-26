import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isContentEditorOrSuper,
  requireContentEditorUser,
} from './authAccess.js';

test('content access accepts editor_contenido and super_admin only', () => {
  assert.equal(isContentEditorOrSuper({ rol: 'editor_contenido' }), true);
  assert.equal(isContentEditorOrSuper({ rol: 'super_admin' }), true);
  assert.equal(isContentEditorOrSuper({ rol: 'admin_club' }), false);
  assert.equal(isContentEditorOrSuper({ rol: 'jugador' }), false);
});

test('requireContentEditorUser resolves the database role', async () => {
  const res = {
    status() {
      assert.fail('An authorized content editor must not receive an error');
    },
  };
  const result = await requireContentEditorUser({}, res, {
    getAuthenticatedUser: async () => ({
      user: { id: 'editor-id', email: 'editor@example.com' },
      status: 200,
    }),
    fetchUserRoleRowForAuthUser: async () => ({
      role: 'editor_contenido',
      sede_id: null,
    }),
  });

  assert.equal(result.user.id, 'editor-id');
  assert.equal(result.role.rol, 'editor_contenido');
});

test('requireContentEditorUser rejects an operations administrator', async () => {
  let responseStatus = null;
  let responseBody = null;
  const res = {
    status(status) {
      responseStatus = status;
      return this;
    },
    json(body) {
      responseBody = body;
      return this;
    },
  };

  const result = await requireContentEditorUser({}, res, {
    getAuthenticatedUser: async () => ({
      user: { id: 'club-admin-id', email: 'club@example.com' },
      status: 200,
    }),
    fetchUserRoleRowForAuthUser: async () => ({
      role: 'admin_club',
      sede_id: 1,
    }),
  });

  assert.equal(result, null);
  assert.equal(responseStatus, 403);
  assert.match(responseBody.error, /permiso/i);
});
