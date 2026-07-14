import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildDisplayName,
  buildPerfilSearchOrFilter,
  escapeIlike,
  mapAdminJugadorRow,
  normalizeSearchQuery,
  resolveAdminJugadoresScope,
} from './adminJugadoresService.js';

test('normalizeSearchQuery strips @ and trims', () => {
  assert.equal(normalizeSearchQuery('  @juan  '), 'juan');
});

test('escapeIlike escapes wildcards', () => {
  assert.equal(escapeIlike('a%b_c'), 'a\\%b\\_c');
});

test('buildPerfilSearchOrFilter requires min length', () => {
  assert.equal(buildPerfilSearchOrFilter('a'), null);
  const f = buildPerfilSearchOrFilter('garcia');
  assert.match(f, /nombre\.ilike/);
  assert.match(f, /email\.ilike/);
  assert.match(f, /telefono\.ilike/);
});

test('buildPerfilSearchOrFilter includes digits for phone', () => {
  const f = buildPerfilSearchOrFilter('11 5555-1234');
  assert.match(f, /1155551234/);
});

test('resolveAdminJugadoresScope clubs cannot query other sedes', () => {
  const denied = resolveAdminJugadoresScope({ rol: 'admin_club', sede_id: 5 }, 9);
  assert.equal(denied.ok, false);
  assert.equal(denied.status, 403);

  const ok = resolveAdminJugadoresScope({ rol: 'admin_club', sede_id: 5 }, null);
  assert.equal(ok.ok, true);
  assert.equal(ok.sedeId, 5);
});

test('resolveAdminJugadoresScope super can pick sede', () => {
  const ok = resolveAdminJugadoresScope({ rol: 'super_admin', sede_id: null }, 12);
  assert.equal(ok.ok, true);
  assert.equal(ok.sedeId, 12);
});

test('mapAdminJugadorRow hides empty optional fields safely', () => {
  const row = mapAdminJugadorRow({
    user_id: 'u1',
    nombre: 'Ana',
    apellido: 'Lopez',
    username: '@ana',
    email: 'ANA@TEST.COM',
    telefono: '111',
  });
  assert.equal(row.display_name, 'Ana Lopez');
  assert.equal(row.username, 'ana');
  assert.equal(row.email, 'ana@test.com');
  assert.equal(row.vinculacion, 'sin_historial');
});

test('buildDisplayName prefers nombre+apellido', () => {
  assert.equal(buildDisplayName({ nombre: 'A', apellido: 'B', username: 'x' }), 'A B');
});
