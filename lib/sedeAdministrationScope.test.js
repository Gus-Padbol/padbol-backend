import test from 'node:test';
import assert from 'node:assert/strict';
import {canAdministerSede, assertCanAdministerSede, normalizeCountry} from './sedeAdministrationScope.js';

const sede = (id, pais) => ({id, pais});
const fetchFrom = (map) => async (id) => map[id] || null;

test('superadministrador administra cualquier sede sin consultar la base', async () => {
  let calls = 0;
  const result = await assertCanAdministerSede({role: {rol: 'super_admin'}, sedeId: 9, fetchSede: async () => { calls += 1; return null; }});
  assert.deepEqual(result, {id: 9});
  assert.equal(calls, 0);
});

test('admin de club solo administra su sede asignada', async () => {
  const role = {rol: 'admin_club', sede_id: 1};
  assert.deepEqual(await assertCanAdministerSede({role, sedeId: 1}), {id: 1});
  await assert.rejects(assertCanAdministerSede({role, sedeId: 2}), (e) => e.status === 403);
  await assert.rejects(assertCanAdministerSede({role: {rol: 'admin_club', sede_id: null}, sedeId: 1}), (e) => e.status === 403);
});

test('coordinador nacional administra solo sedes de su país', async () => {
  const role = {rol: 'admin_nacional', alcance: 'pais', pais: 'Italia'};
  const fetchSede = fetchFrom({3: sede(3, 'Italia')});
  assert.deepEqual(await assertCanAdministerSede({role, sedeId: 3, fetchSede}), {id: 3, pais: 'Italia'});
  const otra = fetchFrom({1: sede(1, 'Argentina')});
  await assert.rejects(assertCanAdministerSede({role, sedeId: 1, fetchSede: otra}), (e) => e.status === 403);
});

test('no hay acceso cruzado entre países', async () => {
  const italia = {rol: 'admin_nacional', alcance: 'pais', pais: 'Italia'};
  const argentina = {rol: 'admin_nacional', alcance: 'pais', pais: 'Argentina'};
  const fetchSede = fetchFrom({1: sede(1, 'Argentina'), 3: sede(3, 'Italia')});
  await assert.rejects(assertCanAdministerSede({role: italia, sedeId: 1, fetchSede}), (e) => e.status === 403);
  await assert.rejects(assertCanAdministerSede({role: argentina, sedeId: 3, fetchSede}), (e) => e.status === 403);
  assert.equal((await assertCanAdministerSede({role: argentina, sedeId: 1, fetchSede})).id, 1);
});

test('el país se compara sin distinguir mayúsculas, acentos ni espacios', () => {
  assert.equal(normalizeCountry('  ITALIA '), 'italia');
  assert.equal(normalizeCountry('Perú'), 'peru');
  assert.ok(canAdministerSede({role: {rol: 'admin_nacional', alcance: 'pais', pais: 'PERÚ'}, sede: {id: 5, pais: 'peru'}}));
});

test('un coordinador sin alcance país, sin país o con alcance global no administra', async () => {
  const fetchSede = fetchFrom({3: sede(3, 'Italia')});
  await assert.rejects(assertCanAdministerSede({role: {rol: 'admin_nacional', alcance: 'global', pais: 'Italia'}, sedeId: 3, fetchSede}), (e) => e.status === 403);
  await assert.rejects(assertCanAdministerSede({role: {rol: 'admin_nacional', alcance: 'pais', pais: null}, sedeId: 3, fetchSede}), (e) => e.status === 403);
  await assert.rejects(assertCanAdministerSede({role: {rol: 'admin_nacional', alcance: 'provincia', pais: 'Italia'}, sedeId: 3, fetchSede}), (e) => e.status === 403);
});

test('una sede inexistente no habilita el alcance territorial', async () => {
  await assert.rejects(assertCanAdministerSede({role: {rol: 'admin_nacional', alcance: 'pais', pais: 'Italia'}, sedeId: 99, fetchSede: async () => null}), (e) => e.status === 403);
});

test('roles ajenos a la administración de sedes quedan fuera', async () => {
  for (const rol of ['editor_contenido', 'jugador', '', null]) {
    await assert.rejects(assertCanAdministerSede({role: {rol}, sedeId: 1}), (e) => e.status === 403);
  }
  await assert.rejects(assertCanAdministerSede({}), (e) => e.status === 403);
});
