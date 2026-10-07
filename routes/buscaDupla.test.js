import test from 'node:test';
import assert from 'node:assert/strict';
import { mountBuscaDuplaRoutes, registeredPlayerIds, tournamentAllowsPartnerSearch } from './buscaDupla.js';

test('T-04 registra todas las rutas y protege hasta el listado', async () => {
  const routes = [];
  const app = {};
  for (const method of ['get', 'post', 'delete']) app[method] = (path, handler) => routes.push({ method, path, handler });
  mountBuscaDuplaRoutes(app, { supabaseAdmin: {}, getAuthenticatedUser: async () => ({ user: null, status: 401 }) });
  assert.equal(routes.length, 9);
  assert(routes.some((r) => r.method === 'post' && r.path.endsWith('/invitaciones/:invId/aceptar')));
  const listing = routes.find((r) => r.method === 'get' && r.path === '/api/torneos/:id/busca-dupla');
  const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } };
  await listing.handler({ params: { id: 1 } }, response);
  assert.equal(response.statusCode, 401);
});

test('torneo permite búsqueda sólo antes de iniciar', () => {
  const now = new Date('2026-10-07T12:00:00Z');
  assert.equal(tournamentAllowsPartnerSearch({ estado: 'inscripcion', fecha_inicio: '2026-10-08' }, now), true);
  assert.equal(tournamentAllowsPartnerSearch({ estado: 'en_curso', fecha_inicio: '2026-10-08' }, now), false);
  assert.equal(tournamentAllowsPartnerSearch({ estado: 'inscripcion', fecha_inicio: '2026-10-06' }, now), false);
});

test('limpieza sólo considera jugadores confirmados y UUID válidos', () => {
  assert.deepEqual(registeredPlayerIds({ jugadores: [
    { id: '11111111-1111-4111-8111-111111111111', estado: 'confirmado' },
    { id: '22222222-2222-4222-8222-222222222222', estado: 'pendiente' },
    { id: 'no-uuid', estado: 'confirmado' },
  ] }), ['11111111-1111-4111-8111-111111111111']);
});
