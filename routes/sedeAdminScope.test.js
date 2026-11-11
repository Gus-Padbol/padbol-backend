import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {mountSedeExtrasRoutes} from './sedeExtras.js';
import {mountLigasPremiosRoutes} from './ligasPremios.js';

function fakeSupabase() {
  const sedes = {1: {id: 1, pais: 'IT'}, 2: {id: 2, pais: 'ES'}};
  return {
    from(table) {
      const filters = {};
      const api = {
        select() { return api; }, eq(k, v) { filters[k] = v; return api; },
        order() { return Promise.resolve({data: [], error: null}); },
        maybeSingle() {
          if (table === 'sedes') return Promise.resolve({data: sedes[filters.id] || null, error: null});
          return Promise.resolve({data: null, error: null});
        },
        upsert(row) { api.row = row; return api; },
        update() { return api; },
        single() { return Promise.resolve({data: api.row || {sede_id: 1, liga: 'L1', descripcion_premio: 'Premio', activo: true}, error: null}); },
      };
      return api;
    },
  };
}

async function fixture(route) {
  const app = express(); app.use(express.json());
  const opts = {
    supabaseAdmin: fakeSupabase(),
    getAuthenticatedUser: async () => ({user: {id: 'u1', email: 'u@example.invalid'}, status: 200, error: null}),
    fetchUserRoleRowForAuthUser: async () => ({role: 'admin_nacional', alcance: 'pais', pais: 'IT', sede_id: null}),
    legacySuperAdminEmails: [],
  };
  if (route === 'extras') mountSedeExtrasRoutes(app, opts); else mountLigasPremiosRoutes(app, opts);
  const server = app.listen(0); await new Promise((r) => server.once('listening', r));
  return {server, base: `http://127.0.0.1:${server.address().port}`};
}

test('admin_nacional conserva alcance/pais y administra sólo sedes de su país', async () => {
  const f = await fixture('extras');
  try {
    const own = await fetch(`${f.base}/api/sedes/1/extras-admin`);
    assert.equal(own.status, 200);
    const foreign = await fetch(`${f.base}/api/sedes/2/extras-admin`);
    assert.equal(foreign.status, 403);
  } finally { f.server.close(); }
});

test('ligasPremios acepta admin_nacional de su país y rechaza otro país', async () => {
  const f = await fixture('ligas');
  try {
    const own = await fetch(`${f.base}/api/admin/ligas-premios`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({sede_id: 1, liga: 'L1', descripcion_premio: 'Premio'})});
    assert.equal(own.status, 200);
    const foreign = await fetch(`${f.base}/api/admin/ligas-premios`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({sede_id: 2, liga: 'L1', descripcion_premio: 'Premio'})});
    assert.equal(foreign.status, 403);
  } finally { f.server.close(); }
});
