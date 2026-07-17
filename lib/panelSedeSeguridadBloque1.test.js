/**
 * BLOQUE 1 DE SEGURIDAD — Panel Administrador de Sede.
 *
 * Cubre: autenticación JWT, autorización por rol, scope por sede resuelto
 * desde el recurso persistido (nunca desde el body) y redacción de secretos
 * en las respuestas de sede.
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  authorizeReservaWrite,
  buildAdminReservaPutUpdates,
  buildNormalUserReservaPutUpdates,
  resolveReservaAccessContext,
} from './reservaAccess.js';
import {
  requireAuthenticatedUser,
  requireAdminUser,
  requireSedeAdminForId,
  filterSedePatchForRole,
} from './authAccess.js';
import {
  resolveTorneoAdminAccess,
  resolveTorneoRowScope,
  TORNEO_ADMIN_ACCESS_REASON,
} from './torneos/torneoAdminAccessService.js';
import {
  SEDE_PUBLIC_COLUMNS,
  SEDE_SECRET_FIELD_PATTERN,
  buildSedePagosIndicadores,
  pickPublicSedeRow,
} from '../utils/sedePublicSelect.js';

function createMockRes() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

const noAuth = async () => ({ user: null, status: 401, error: 'Se requiere Authorization Bearer token' });
const invalidJwt = async () => ({ user: null, status: 401, error: 'Token inválido o expirado' });

function makeRoleDeps(roleRow) {
  return {
    getAuthenticatedUser: async () => ({ user: { id: 'u-1', email: 'a@b.com' } }),
    fetchUserRoleRowForAuthUser: async () => roleRow,
    legacySuperAdminEmails: [],
  };
}

function reservaDeps(roleRow) {
  return {
    fetchUserRoleRowForAuthUser: async () => roleRow,
    legacySuperAdminEmails: [],
    supabaseAdmin: null,
    pgPool: null,
  };
}

const USER = { id: 'user-uuid-1', email: 'admin@club.com' };
const RESERVA_SEDE_1 = { id: 10, sede_id: 1, sede: 'Club Uno', user_id: 'otro-user', email: 'jugador@x.com', estado: 'confirmada' };
const RESERVA_SEDE_2 = { id: 11, sede_id: 2, sede: 'Club Dos', user_id: 'otro-user', email: 'jugador@x.com', estado: 'confirmada' };

// ===== RESERVAS — autenticación =====

test('reservas: sin JWT devuelve 401 (gate de PUT y DELETE)', async () => {
  const res = createMockRes();
  const user = await requireAuthenticatedUser({}, res, noAuth);
  assert.equal(user, null);
  assert.equal(res.statusCode, 401);
  assert.ok(res.body.error);
});

test('reservas: JWT inválido devuelve 401', async () => {
  const res = createMockRes();
  const user = await requireAuthenticatedUser({}, res, invalidJwt);
  assert.equal(user, null);
  assert.equal(res.statusCode, 401);
});

// ===== RESERVAS — scope por sede persistida =====

test('reservas: admin_club de la misma sede puede editar (access admin)', async () => {
  const authz = await authorizeReservaWrite(USER, RESERVA_SEDE_1, reservaDeps({ rol: 'admin_club', sede_id: 1 }));
  assert.equal(authz.ok, true);
  assert.equal(authz.access, 'admin');
  assert.equal(authz.rol, 'admin_club');
});

test('reservas: admin_club de otra sede recibe 403 al editar', async () => {
  const authz = await authorizeReservaWrite(USER, RESERVA_SEDE_2, reservaDeps({ rol: 'admin_club', sede_id: 1 }));
  assert.equal(authz.ok, false);
  assert.equal(authz.status, 403);
});

test('reservas: admin_club de la misma sede puede cancelar/eliminar', async () => {
  const authz = await authorizeReservaWrite(USER, RESERVA_SEDE_1, reservaDeps({ rol: 'admin_club', sede_id: 1 }));
  assert.equal(authz.ok, true);
  assert.equal(authz.access, 'admin');
});

test('reservas: admin_club de otra sede recibe 403 al eliminar', async () => {
  const authz = await authorizeReservaWrite(USER, RESERVA_SEDE_2, reservaDeps({ rol: 'admin_club', sede_id: 1 }));
  assert.equal(authz.ok, false);
  assert.equal(authz.status, 403);
});

test('reservas: super_admin puede editar', async () => {
  const authz = await authorizeReservaWrite(USER, RESERVA_SEDE_2, reservaDeps({ rol: 'super_admin', sede_id: null }));
  assert.equal(authz.ok, true);
  assert.equal(authz.access, 'admin');
  assert.equal(authz.rol, 'super_admin');
});

test('reservas: super_admin puede eliminar', async () => {
  const authz = await authorizeReservaWrite(USER, RESERVA_SEDE_1, reservaDeps({ rol: 'super_admin', sede_id: null }));
  assert.equal(authz.ok, true);
  assert.equal(authz.access, 'admin');
});

test('reservas: reserva inexistente devuelve 404', async () => {
  const authz = await authorizeReservaWrite(USER, null, reservaDeps({ rol: 'super_admin', sede_id: null }));
  assert.equal(authz.ok, false);
  assert.equal(authz.status, 404);
});

test('reservas: sede_id adulterado en body no modifica el scope real', async () => {
  // El scope se decide contra reserva.sede_id persistido; el body no participa.
  const authz = await authorizeReservaWrite(USER, RESERVA_SEDE_2, reservaDeps({ rol: 'admin_club', sede_id: 1 }));
  assert.equal(authz.ok, false);
  assert.equal(authz.status, 403);

  // Y aunque el acceso sea válido (su propia sede), un admin_club no puede
  // reasignar la reserva a otra sede vía body.
  const updates = buildAdminReservaPutUpdates(
    { sede_id: 99, sede: 'Otra Sede', nombre: 'Nuevo Nombre' },
    { allowSedeReassign: false },
  );
  assert.equal(updates.sede_id, undefined);
  assert.equal(updates.sede, undefined);
  assert.equal(updates.nombre, 'Nuevo Nombre');
});

test('reservas: super_admin conserva la reasignación de sede', () => {
  const updates = buildAdminReservaPutUpdates({ sede_id: 99 }, { allowSedeReassign: true });
  assert.equal(updates.sede_id, 99);
});

test('reservas: rol no autorizado recibe 403', async () => {
  const authz = await authorizeReservaWrite(USER, RESERVA_SEDE_1, reservaDeps({ rol: 'empleado', sede_id: 1 }));
  assert.equal(authz.ok, false);
  assert.equal(authz.status, 403);
});

test('reservas: empleado conserva solo su alcance actual (owner de su propia reserva)', async () => {
  const propia = { ...RESERVA_SEDE_1, user_id: USER.id };
  const { access } = await resolveReservaAccessContext(USER, propia, reservaDeps({ rol: 'empleado', sede_id: 1 }));
  assert.equal(access, 'owner');
});

test('reservas: jugador (owner) no puede tocar campos sensibles en PUT', () => {
  assert.throws(
    () => buildNormalUserReservaPutUpdates({ estado: 'cancelada' }),
    /No tenés permiso/,
  );
  assert.deepEqual(buildNormalUserReservaPutUpdates({ nombre: 'Juan' }), { nombre: 'Juan' });
});

// ===== TORNEOS — autenticación y scope =====

test('torneos: sin JWT devuelve 401 (gate de PUT y DELETE)', async () => {
  const res = createMockRes();
  const auth = await requireAdminUser({}, res, {
    getAuthenticatedUser: noAuth,
    fetchUserRoleRowForAuthUser: async () => null,
    legacySuperAdminEmails: [],
  });
  assert.equal(auth, null);
  assert.equal(res.statusCode, 401);
});

test('torneos: admin_club de la sede puede editar y eliminar', () => {
  const auth = { user: USER, role: { rol: 'admin_club', sede_id: 3 } };
  const { allowed } = resolveTorneoAdminAccess(auth, 3);
  assert.equal(allowed, true);
});

test('torneos: admin_club de otra sede recibe 403 (editar y eliminar)', () => {
  const auth = { user: USER, role: { rol: 'admin_club', sede_id: 3 } };
  const { allowed, reason } = resolveTorneoAdminAccess(auth, 4);
  assert.equal(allowed, false);
  assert.equal(reason, TORNEO_ADMIN_ACCESS_REASON.SEDE_NO_COINCIDE);
});

test('torneos: super_admin puede editar y eliminar globalmente', () => {
  const auth = { user: USER, role: { rol: 'super_admin', sede_id: null } };
  assert.equal(resolveTorneoAdminAccess(auth, 4).allowed, true);
  assert.equal(resolveTorneoAdminAccess(auth, null).allowed, true);
});

test('torneos: torneo inexistente resuelve exists=false (la ruta responde 404)', () => {
  assert.deepEqual(resolveTorneoRowScope(null), { exists: false, sedeId: null });
  assert.deepEqual(resolveTorneoRowScope(undefined), { exists: false, sedeId: null });
});

test('torneos: el scope usa la sede persistida del torneo, no el body', () => {
  // El torneo real pertenece a la sede 7; da igual qué sede_id mande el cliente.
  const scope = resolveTorneoRowScope({ id: 5, sede_id: 7 });
  assert.deepEqual(scope, { exists: true, sedeId: 7 });

  const auth = { user: USER, role: { rol: 'admin_club', sede_id: 1 } };
  assert.equal(resolveTorneoAdminAccess(auth, scope.sedeId).allowed, false);
});

test('torneos: empleado conserva exactamente su permiso actual (sin acceso admin)', async () => {
  const { allowed, reason } = resolveTorneoAdminAccess(
    { user: USER, role: { rol: 'empleado', sede_id: 1 } },
    1,
  );
  assert.equal(allowed, false);
  assert.equal(reason, TORNEO_ADMIN_ACCESS_REASON.ROL_NO_ADMIN);

  const res = createMockRes();
  const auth = await requireAdminUser({}, res, makeRoleDeps({ role: 'empleado', sede_id: 1 }));
  assert.equal(auth, null);
  assert.equal(res.statusCode, 403);
});

test('torneos: admin_nacional respeta su alcance real (sin admin de torneos)', () => {
  const { allowed, reason } = resolveTorneoAdminAccess(
    { user: USER, role: { rol: 'admin_nacional', sede_id: null } },
    1,
  );
  assert.equal(allowed, false);
  assert.equal(reason, TORNEO_ADMIN_ACCESS_REASON.ROL_NO_ADMIN);
});

test('torneos: torneo multisede (sede null) queda fuera del alcance de admin_club', () => {
  const auth = { user: USER, role: { rol: 'admin_club', sede_id: 1 } };
  const { allowed } = resolveTorneoAdminAccess(auth, resolveTorneoRowScope({ id: 9, sede_id: null }).sedeId);
  assert.equal(allowed, false);
});

// ===== SEDES — redacción de secretos =====

const SEDE_ROW_CON_SECRETOS = {
  id: 1,
  nombre: 'Club Uno',
  direccion: 'Calle 123',
  ciudad: 'BsAs',
  metodo_pago: 'mercadopago',
  precio_60min: 10000,
  mp_access_token: 'APP_USR-super-secreto',
  mercadopago_access_token: 'APP_USR-super-secreto-2',
  mp_client_secret: 'client-secret',
  mp_public_key: 'APP_PUB-key',
  stripe_secret_key: 'sk_live_123',
  stripe_account_id: 'acct_123',
  webhook_secret: 'whsec_123',
  hero_foto_url: 'https://x/foto.jpg',
};

test('sedes: el DTO público no devuelve mp_access_token', () => {
  const dto = pickPublicSedeRow(SEDE_ROW_CON_SECRETOS);
  assert.ok(!('mp_access_token' in dto));
  assert.ok(!('mercadopago_access_token' in dto));
  assert.ok(!('mp_client_secret' in dto));
});

test('sedes: el DTO público no devuelve secretos de Stripe', () => {
  const dto = pickPublicSedeRow(SEDE_ROW_CON_SECRETOS);
  assert.ok(!('stripe_secret_key' in dto));
  assert.ok(!('stripe_account_id' in dto));
});

test('sedes: el DTO público no devuelve tokens ni secretos equivalentes', () => {
  const dto = pickPublicSedeRow(SEDE_ROW_CON_SECRETOS);
  for (const key of Object.keys(dto)) {
    assert.ok(!SEDE_SECRET_FIELD_PATTERN.test(key), `campo sensible expuesto: ${key}`);
  }
  const serialized = JSON.stringify(dto);
  assert.ok(!serialized.includes('APP_USR-super-secreto'));
  assert.ok(!serialized.includes('sk_live_123'));
  assert.ok(!serialized.includes('whsec_123'));
});

test('sedes: el whitelist SEDE_PUBLIC_COLUMNS no contiene nombres sensibles', () => {
  for (const col of SEDE_PUBLIC_COLUMNS) {
    assert.ok(!SEDE_SECRET_FIELD_PATTERN.test(col), `columna sensible en whitelist: ${col}`);
  }
});

test('sedes: PATCH acepta guardar un secreto cuando el rol tiene permiso (super_admin)', () => {
  const patch = { nombre: 'Nuevo', mp_access_token: 'APP_USR-nuevo' };
  const filtered = filterSedePatchForRole(patch, { rol: 'super_admin', sede_id: null });
  assert.equal(filtered.mp_access_token, 'APP_USR-nuevo');
});

test('sedes: admin_club no puede escribir credenciales de pago (write-only para super_admin)', () => {
  const patch = { nombre: 'Nuevo', mp_access_token: 'APP_USR-nuevo', stripe_account_id: 'acct_9' };
  const filtered = filterSedePatchForRole(patch, { rol: 'admin_club', sede_id: 1 });
  assert.ok(!('mp_access_token' in filtered));
  assert.ok(!('stripe_account_id' in filtered));
  assert.equal(filtered.nombre, 'Nuevo');
});

test('sedes: la respuesta del PATCH no devuelve el secreto guardado ni la fila cruda', () => {
  // Simula la respuesta que arma PATCH /api/sedes/:id.
  const respuesta = {
    sede: pickPublicSedeRow(SEDE_ROW_CON_SECRETOS),
    pagos: buildSedePagosIndicadores(SEDE_ROW_CON_SECRETOS),
  };
  const serialized = JSON.stringify(respuesta);
  assert.ok(!serialized.includes('APP_USR-super-secreto'));
  assert.ok(!serialized.includes('sk_live_123'));
  assert.ok(!serialized.includes('acct_123'));

  // Solo llaves del whitelist (+ hero_foto_url) — nunca la fila cruda.
  const allowed = new Set([...SEDE_PUBLIC_COLUMNS, 'hero_foto_url']);
  for (const key of Object.keys(respuesta.sede)) {
    assert.ok(allowed.has(key), `llave fuera del whitelist: ${key}`);
  }
});

test('sedes: usuario sin scope no puede modificar pagos de otra sede', async () => {
  const res = createMockRes();
  const auth = await requireSedeAdminForId({}, res, 2, makeRoleDeps({ role: 'admin_club', sede_id: 1 }));
  assert.equal(auth, null);
  assert.equal(res.statusCode, 403);
});

test('sedes: admin_club de la sede y super_admin sí pasan el gate del PATCH', async () => {
  const res1 = createMockRes();
  const ok1 = await requireSedeAdminForId({}, res1, 1, makeRoleDeps({ role: 'admin_club', sede_id: 1 }));
  assert.ok(ok1);

  const res2 = createMockRes();
  const ok2 = await requireSedeAdminForId({}, res2, 7, makeRoleDeps({ role: 'super_admin', sede_id: null }));
  assert.ok(ok2);
});

test('sedes: la respuesta indica configurado=true sin exponer el valor', () => {
  const pagos = buildSedePagosIndicadores(SEDE_ROW_CON_SECRETOS);
  assert.deepEqual(pagos, { mercadopago_configurado: true, stripe_configurado: true });

  const sinPagos = buildSedePagosIndicadores({ mp_access_token: '  ', stripe_account_id: null });
  assert.deepEqual(sinPagos, { mercadopago_configurado: false, stripe_configurado: false });
});

test('sedes: ninguna respuesta contiene campos con nombres sensibles', () => {
  const respuesta = {
    sede: pickPublicSedeRow(SEDE_ROW_CON_SECRETOS),
    pagos: buildSedePagosIndicadores(SEDE_ROW_CON_SECRETOS),
  };
  const collectKeys = (obj, acc = []) => {
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      for (const [k, v] of Object.entries(obj)) {
        acc.push(k);
        collectKeys(v, acc);
      }
    }
    return acc;
  };
  for (const key of collectKeys(respuesta)) {
    assert.ok(!SEDE_SECRET_FIELD_PATTERN.test(key), `campo sensible: ${key}`);
  }
});

test('sedes: la ficha pública sigue devolviendo los campos públicos necesarios', () => {
  const dto = pickPublicSedeRow(SEDE_ROW_CON_SECRETOS);
  assert.equal(dto.id, 1);
  assert.equal(dto.nombre, 'Club Uno');
  assert.equal(dto.direccion, 'Calle 123');
  assert.equal(dto.ciudad, 'BsAs');
  assert.equal(dto.metodo_pago, 'mercadopago');
  assert.equal(dto.precio_60min, 10000);
  assert.equal(dto.hero_foto_url, 'https://x/foto.jpg');
});
