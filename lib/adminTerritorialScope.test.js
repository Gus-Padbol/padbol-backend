import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import {
  buildAdminRoleGeography,
  filterSedesByTerritorialScope,
  resolveSedesPermitidasPorScope,
} from './adminTerritorialScope.js';

const VENUES = [
  { id: 1, pais: 'Argentina', provincia: 'Córdoba', ciudad: 'San José' },
  { id: 2, pais: 'Argentina', provincia: 'Entre Ríos', ciudad: 'San José' },
  { id: 3, pais: 'España', provincia: 'Córdoba', ciudad: 'San José' },
  { id: 4, pais: 'Argentina', provincia: 'Córdoba', ciudad: 'Otra ciudad' },
  { id: 5, pais: null, provincia: 'Córdoba', ciudad: 'San José' },
  { id: 6, pais: 'Argentina', provincia: null, ciudad: 'San José' },
  { id: 7, pais: 'Argentina', provincia: 'Córdoba', ciudad: null },
  { id: 8, pais: 'Argentina', provincia: '', ciudad: 'San José' },
];
const CITY = { rol: 'admin_nacional', alcance: 'ciudad', pais: 'Argentina', provincia: 'Córdoba', ciudad: 'San José' };

function readOnlyDb() {
  const reads = [];
  return {
    reads,
    from(table) {
      reads.push(table);
      let rows = table === 'sedes' ? [...VENUES] : table === 'organizaciones' ? [{ id: 'a', estado: 'activa' }] : [
        { organizacion_id: 'a', sede_id: 1 },
        { organizacion_id: 'b', sede_id: 3 },
      ];
      const query = {
        select() { return query; },
        maybeSingle: async () => ({ data: rows[0] || null, error: null }),
        eq(key, value) { rows = rows.filter((row) => row[key] === value); return query; },
        in(key, values) { rows = rows.filter((row) => values.includes(row[key])); return query; },
        then(resolve, reject) { return Promise.resolve({ data: rows, error: null }).then(resolve, reject); },
      };
      return query;
    },
  };
}

test('ciudad requiere país y provincia; homónimos y sedes incompletas quedan fuera', async () => {
  const result = await resolveSedesPermitidasPorScope(readOnlyDb(), CITY);
  assert.deepEqual(result.sedes.map((row) => row.id), [1]);
  const normalized = { ...CITY, paisNorm: 'argentina', provinciaNorm: 'cordoba', ciudadNorm: 'san jose' };
  assert.deepEqual(filterSedesByTerritorialScope(normalized, VENUES).map((row) => row.id), [1]);
});

test('provincia exige país, sin exigir ciudad a sus sedes', async () => {
  const result = await resolveSedesPermitidasPorScope(readOnlyDb(), { ...CITY, alcance: 'provincia' });
  assert.deepEqual(result.sedes.map((row) => row.id), [1, 4, 7]);
});

test('país conserva acceso a todas sus sedes y excluye país desconocido', async () => {
  const result = await resolveSedesPermitidasPorScope(readOnlyDb(), { ...CITY, alcance: 'pais' });
  assert.deepEqual(result.sedes.map((row) => row.id), [1, 2, 4, 6, 7, 8]);
});

test('roles territoriales antiguos incompletos no consultan ni reciben sedes', async () => {
  for (const [alcance, fields] of Object.entries({ pais: ['pais'], provincia: ['pais', 'provincia'], ciudad: ['pais', 'provincia', 'ciudad'] })) {
    for (const field of fields) {
      for (const missing of [undefined, null, '', '  ', '🇦🇷', 123, {}]) {
        const db = readOnlyDb();
        const result = await resolveSedesPermitidasPorScope(db, { ...CITY, alcance, [field]: missing });
        assert.deepEqual(result.sedes, [], `${alcance} / ${field} / ${String(missing)}`);
        assert.deepEqual(db.reads, []);
      }
    }
  }
});

test('no se degrada un alcance inválido a país o ciudad', async () => {
  for (const alcance of ['desconocido', 'constructor', '__proto__']) {
    assert.deepEqual((await resolveSedesPermitidasPorScope(readOnlyDb(), { ...CITY, alcance })).sedes, []);
  }
});

test('normalización existente conserva tildes, bandera y mayúsculas equivalentes', () => {
  const scope = { ...CITY, pais: ' 🇦🇷 ARGENTINA ', provincia: ' cordoba ', ciudad: 'SAN JOSE' };
  assert.deepEqual(filterSedesByTerritorialScope(scope, VENUES).map((row) => row.id), [1]);
});

test('sedes, organizaciones, superadmin y editor mantienen sus límites', async () => {
  assert.deepEqual((await resolveSedesPermitidasPorScope(readOnlyDb(), { alcance: 'sede', sedeId: 3 })).sedes.map((row) => row.id), [3]);
  assert.deepEqual((await resolveSedesPermitidasPorScope(readOnlyDb(), { alcance: 'organizacion', organizacionId: 'a' })).sedes.map((row) => row.id), [1]);
  assert.equal((await resolveSedesPermitidasPorScope(readOnlyDb(), { superA: true })).sedes.length, VENUES.length);
  assert.deepEqual((await resolveSedesPermitidasPorScope(readOnlyDb(), { rol: 'editor_contenido', alcance: 'global' })).sedes, []);
  assert.deepEqual((await resolveSedesPermitidasPorScope(readOnlyDb(), null)).sedes, []);
});

test('guardado conserva padres y su lectura no cambia el ámbito concedido', () => {
  for (const alcance of ['pais', 'provincia', 'ciudad']) {
    const saved = buildAdminRoleGeography(alcance, CITY);
    assert.equal(saved.pais, 'Argentina');
    assert.equal(saved.provincia, alcance === 'pais' ? null : 'Córdoba');
    assert.equal(saved.ciudad, alcance === 'ciudad' ? 'San José' : null);
    assert.deepEqual(filterSedesByTerritorialScope({ alcance, ...saved }, VENUES), filterSedesByTerritorialScope({ ...CITY, alcance }, VENUES));
  }
  assert.deepEqual(buildAdminRoleGeography('sede', CITY), { pais: null, provincia: null, ciudad: null });
});

test('alta geográfica rechaza padres ausentes antes de generar un payload', () => {
  for (const [alcance, fields] of Object.entries({ pais: ['pais'], provincia: ['pais', 'provincia'], ciudad: ['pais', 'provincia', 'ciudad'] })) {
    for (const field of fields) {
      for (const value of [null, '', '🇦🇷', {}, ['Argentina']]) {
        assert.throws(() => buildAdminRoleGeography(alcance, { ...CITY, [field]: value }), (error) => error.status === 400 && error.code === 'ADMIN_TERRITORY_INCOMPLETE');
      }
    }
  }
});

// Execute the actual route/function bodies with inert dependencies, without
// importing server.js (which starts jobs, providers and network listeners).
const source = fs.readFileSync(new URL('../routes/commercialRelease.js', import.meta.url), 'utf8');
function sourceBetween(start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from);
  return source.slice(from, to);
}

test('POST roles real conserva territorio y rechaza faltantes sin escribir', async () => {
  const route = sourceBetween("app.post('/api/admin/roles',", "app.delete('/api/admin/roles/:email'");
  let handler;
  const writes = [];
  const db = { from() {
    const q = {
      select() { return q; }, eq() { return q; },
      maybeSingle: async () => ({ data: null }),
      insert(payload) { writes.push(payload); return q; },
      single: async () => ({ data: writes.at(-1), error: null }),
    };
    return q;
  } };
  vm.runInNewContext(route, { app: { post(_path, fn) { handler = fn; } }, assertSuperAdminReq: async () => {}, supabase: db, buildAdminRoleGeography, console: { error() {} } });
  for (const alcance of ['ciudad', 'provincia', 'pais']) {
    const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
    await handler({ body: { ...CITY, email: 'admin@example.test', role: 'admin_nacional', alcance } }, res);
    assert.equal(res.statusCode, 200);
    assert.deepEqual(filterSedesByTerritorialScope(res.body, VENUES).map((row) => row.id), filterSedesByTerritorialScope({ ...CITY, alcance }, VENUES).map((row) => row.id));
  }
  const before = writes.length;
  const res = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } };
  await handler({ body: { email: 'admin@example.test', role: 'admin_nacional', alcance: 'ciudad', ciudad: 'San José' } }, res);
  assert.equal(res.statusCode, 400);
  assert.equal(writes.length, before);
});

test('aceptación de invitación geo incompleta no escribe un rol', async () => {
  const body = sourceBetween('async function upsertUserRoleFromInvitacionGeo(', 'function randomTemporaryPassword()');
  const upsert = vm.runInNewContext(`(${body})`, { buildAdminRoleGeography, supabase: { from() { throw new Error('unexpected database access'); } } });
  const error = await upsert({ email: 'admin@example.test', inv: { invited_alcance: 'ciudad', ciudad: 'San José', pais: 'Argentina' } });
  assert.equal(error.code, 'ADMIN_TERRITORY_INCOMPLETE');
});

test('licencia territorial conserva padres sin inferir el país del domicilio', () => {
  const body = sourceBetween('function licenciaRoleAssignment(', 'async function upsertUserRoleLicenciaAsignada(');
  const assign = vm.runInNewContext(`(${body})`, { buildAdminRoleGeography });
  const city = assign({ tipo_licencia: 'master_ciudad', pais_representa: 'Argentina', provincia_representa: 'Córdoba', ciudad_representa: 'San José' }, null);
  assert.deepEqual(filterSedesByTerritorialScope(city, VENUES).map((row) => row.id), [1]);
  assert.throws(() => assign({ tipo_licencia: 'master_ciudad', licenciatario_pais: 'Argentina', provincia_representa: 'Córdoba', ciudad_representa: 'San José' }, null), (error) => error.code === 'ADMIN_TERRITORY_INCOMPLETE');
});
