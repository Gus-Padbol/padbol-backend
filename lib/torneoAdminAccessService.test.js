import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildTorneoPermisosPayload,
  buildTorneoPermisosResponse,
  handleGetTorneoPermisos,
  resolveTorneoAdminAccess,
  TORNEO_ADMIN_ACCESS_REASON,
} from './torneos/torneoAdminAccessService.js';

function auth(rol, sedeId = null) {
  return {
    user: { id: 'user-1' },
    role: { rol, sede_id: sedeId },
  };
}

describe('resolveTorneoAdminAccess', () => {
  it('sin auth → false', () => {
    assert.deepEqual(resolveTorneoAdminAccess(null, 1), {
      allowed: false,
      reason: TORNEO_ADMIN_ACCESS_REASON.SIN_AUTH,
    });
  });

  it('super_admin → true', () => {
    assert.deepEqual(resolveTorneoAdminAccess(auth('super_admin'), 99), {
      allowed: true,
      reason: TORNEO_ADMIN_ACCESS_REASON.SUPER_ADMIN,
    });
  });

  it('admin_club misma sede → true', () => {
    assert.deepEqual(resolveTorneoAdminAccess(auth('admin_club', 1), 1), {
      allowed: true,
      reason: TORNEO_ADMIN_ACCESS_REASON.ADMIN_CLUB_SEDE,
    });
  });

  it('admin_club otra sede → false', () => {
    assert.deepEqual(resolveTorneoAdminAccess(auth('admin_club', 1), 2), {
      allowed: false,
      reason: TORNEO_ADMIN_ACCESS_REASON.SEDE_NO_COINCIDE,
    });
  });

  it('admin_club sin sede en torneo → false', () => {
    assert.deepEqual(resolveTorneoAdminAccess(auth('admin_club', 1), null), {
      allowed: false,
      reason: TORNEO_ADMIN_ACCESS_REASON.SEDE_NO_COINCIDE,
    });
  });

  it('admin_sede → false por compatibilidad actual', () => {
    assert.deepEqual(resolveTorneoAdminAccess(auth('admin_sede', 1), 1), {
      allowed: false,
      reason: TORNEO_ADMIN_ACCESS_REASON.ADMIN_SEDE_NO_TORNEO,
    });
  });

  it('jugador → false', () => {
    assert.deepEqual(resolveTorneoAdminAccess(auth('jugador'), 1), {
      allowed: false,
      reason: TORNEO_ADMIN_ACCESS_REASON.ROL_NO_ADMIN,
    });
  });
});

describe('buildTorneoPermisosPayload', () => {
  it('expone solo booleans de permiso', () => {
    const payload = buildTorneoPermisosPayload(28, true);
    assert.deepEqual(payload, {
      ok: true,
      torneo_id: 28,
      permisos: {
        puede_administrar: true,
        puede_cargar_resultado: true,
      },
    });
    assert.equal('rol' in payload, false);
    assert.equal('email' in payload, false);
    assert.equal('reason' in payload, false);
  });
});

describe('buildTorneoPermisosResponse', () => {
  it('torneo inexistente → 404', async () => {
    const supabaseAdmin = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };

    const result = await buildTorneoPermisosResponse(
      supabaseAdmin,
      auth('super_admin'),
      999,
    );

    assert.equal(result.statusCode, 404);
    assert.equal(result.body.code, 'torneo_no_encontrado');
  });

  it('admin_club misma sede → permisos true', async () => {
    const supabaseAdmin = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: { id: 28, sede_id: 1 }, error: null });
          },
        };
      },
    };

    const result = await buildTorneoPermisosResponse(
      supabaseAdmin,
      auth('admin_club', 1),
      28,
    );

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.permisos.puede_cargar_resultado, true);
  });

  it('jugador → permisos false', async () => {
    const supabaseAdmin = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: { id: 28, sede_id: 1 }, error: null });
          },
        };
      },
    };

    const result = await buildTorneoPermisosResponse(
      supabaseAdmin,
      auth('jugador'),
      28,
    );

    assert.equal(result.statusCode, 200);
    assert.deepEqual(result.body.permisos, {
      puede_administrar: false,
      puede_cargar_resultado: false,
    });
  });
});

describe('requireTorneoAdminForSede alignment', () => {
  it('admin_club sede distinta usa reason sede_no_coincide', () => {
    const { allowed, reason } = resolveTorneoAdminAccess(auth('admin_club', 1), 2);
    assert.equal(allowed, false);
    assert.equal(reason, TORNEO_ADMIN_ACCESS_REASON.SEDE_NO_COINCIDE);
  });

  it('admin_sede queda bloqueado igual que POST manual actual', () => {
    const { allowed } = resolveTorneoAdminAccess(auth('admin_sede', 1), 1);
    assert.equal(allowed, false);
  });
});

describe('handleGetTorneoPermisos', () => {
  it('sin JWT → 401', async () => {
    const result = await handleGetTorneoPermisos(
      { params: { torneoId: '28' }, headers: {} },
      {
        supabaseAdmin: {},
        getAuthenticatedUser: async () => ({
          user: null,
          status: 401,
          error: 'Se requiere Authorization Bearer token',
        }),
      },
    );

    assert.equal(result.statusCode, 401);
    assert.match(result.body.error, /Bearer token/i);
  });

  it('JWT válido delega en buildTorneoPermisosResponse', async () => {
    const result = await handleGetTorneoPermisos(
      { params: { torneoId: '28' }, headers: { authorization: 'Bearer token' } },
      {
        supabaseAdmin: { from: () => ({}) },
        getAuthenticatedUser: async () => ({ user: { id: 'u1' }, status: null, error: null }),
        resolveAuthRoleForUser: async () => ({ rol: 'super_admin', sede_id: null }),
        buildTorneoPermisosResponse: async () => ({
          statusCode: 200,
          body: buildTorneoPermisosPayload(28, true),
        }),
      },
    );

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.permisos.puede_cargar_resultado, true);
  });
});
