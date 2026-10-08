import assert from 'node:assert/strict';
import { registerSedeIncentiveRoutes } from '../sedeIncentivesV4.js';
import { configured, fixture, client } from './incentivesV4Fixture.js';

export function routeFixture({ tables = fixture(), programs = [{ ...configured, codigo: 'padbol_pro_renovable', estado: 'borrador' }], scope = { superA: false }, denied = false, superAdmin = true, insertConflict = false, stripeSubscription = null, metricsFailure } = {}) {
  const metrics = client(tables, { failTable: metricsFailure });
  const storage = { sede_programas_beneficios: structuredClone(programs), sede_beneficio_progreso: [], sedes: [{ id: 7, stripe_subscription_id: stripeSubscription }] };
  const writes = [], reads = [], authorization = [], handlers = new Map();
  const supabase = { ...metrics, from(table) {
    if (!Object.hasOwn(storage, table)) return metrics.from(table);
    let mutation, payload, projection = '*', limit;
    const filters = [];
    const query = {
      select(columns) { projection = columns; return query; },
      eq(key, value) { filters.push(row => row[key] === value); return query; },
      in(key, values) { filters.push(row => values.includes(row[key])); return query; },
      order() { return query; }, limit(value) { limit = value; return query; },
      insert(value) { mutation = 'insert'; payload = value; return query; },
      update(value) { mutation = 'update'; payload = value; return query; },
      upsert() { throw new Error('No upserts permitted'); },
      then(resolve, reject) { return execute(false).then(resolve, reject); },
      maybeSingle() { return execute(true); }, single() { return execute(true); },
    };
    async function execute(single) {
      let rows = storage[table].filter(row => filters.every(fn => fn(row)));
      if (mutation === 'insert') {
        assert.equal(table, 'sede_programas_beneficios');
        if (insertConflict || storage[table].some(row => row.sede_id === payload.sede_id && row.codigo === payload.codigo)) return { data: null, error: { code: '23505' } };
        const row = { id: '00000000-0000-4000-8000-999999999999', ...structuredClone(payload) };
        storage[table].push(row); rows = [row]; writes.push({ table, mutation, rows: 1 });
      } else if (mutation === 'update') {
        rows.forEach(row => Object.assign(row, structuredClone(payload)));
        if (rows.length) writes.push({ table, mutation, rows: rows.length });
      } else reads.push(table);
      if (limit) rows = rows.slice(0, limit);
      rows = rows.map(row => projection === '*' ? structuredClone(row) : Object.fromEntries(projection.split(',').map(key => key.trim()).map(key => [key, row[key]])));
      return { data: single ? rows[0] || null : rows, error: null };
    }
    return query;
  } };
  const app = Object.fromEntries(['get', 'post', 'patch'].map(method => [method, (path, handler) => handlers.set(`${method} ${path}`, handler)]));
  registerSedeIncentiveRoutes(app, {
    supabase,
    async adminListScopeFromRequest() { authorization.push('list'); return scope; },
    async assertUsuarioPuedeAdministrarSede(_req, sedeId) { authorization.push(`sede:${sedeId}`); if (denied || sedeId !== 7) throw Object.assign(new Error('No autorizado para esta sede'), { status: 403 }); return scope; },
    async assertSuperAdminReq() { authorization.push('super'); if (!superAdmin) throw Object.assign(new Error('Sólo superadmin'), { status: 403 }); },
  });
  return { storage, writes, reads, metrics, authorization, async invoke(method, path, { body = {}, query = {}, params = { sedeId: '7' } } = {}) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handlers.get(`${method} ${path}`)({ body, query, params }, res);
    return res;
  } };
}
