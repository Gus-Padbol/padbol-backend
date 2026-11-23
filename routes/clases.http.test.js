// Arnés HTTP aislado: monta los routers REALES en el orden del patch
// (`createClasesRouter` antes de `registerModuloClasesRoutes`) y prueba el
// comportamiento efectivo de Express. No usa DB ni API externas: el cliente
// Supabase es un fixture en memoria que emula el rechazo de PostgREST ante
// columnas inexistentes. El reloj de la request se inyecta para probar dos
// sedes con cambio de día y el cambio de horario de verano (DST).
import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { once } from 'node:events';
import { createClasesRouter } from './clases.js';
import { registerModuloClasesRoutes } from '../lib/moduloClases.js';

const AUTH_USER = { id: 'user-fixture', email: 'user@test.invalid' };
const TOKEN = 'Bearer fixture-token';

const BA = 'America/Argentina/Buenos_Aires';
const KIRITIMATI = 'Pacific/Kiritimati';
const NY = 'America/New_York';
const CLOCK_DIA = new Date('2026-11-22T02:30:00.000Z'); // BA sábado 23:30 / Kiritimati domingo 16:30
const CLOCK_DST = new Date('2026-10-31T12:00:00.000Z'); // NY sábado 08:00 EDT / DST termina 2026-11-01

const COLUMNAS_HORARIO_RECURRENTE = ['id', 'clase_id', 'dia_semana', 'hora_inicio', 'hora_fin'];
const COLUMNAS_HORARIO_LEGACY = ['id', 'clase_id', 'fecha', 'hora'];
const TABLAS_HORARIOS = new Set(['clases_horarios', 'clases_disponibilidad']);

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function errorColumna(columna) {
  return { message: `column ${columna} does not exist`, code: '42703' };
}

function createFakeSupabase(seed = {}) {
  const fallas = seed.fallas || {};
  const tables = {
    clases: clone(seed.clases || []),
    clases_horarios: clone(seed.horarios || []),
    clases_reservas: clone(seed.reservas || []),
  };
  const queries = [];
  let nextReservaId = 900;

  function columnasSeleccionadas(columns) {
    if (!columns || columns === '*') return null;
    const texto = String(columns);
    // Joins de PostgREST (`profesores (...)`): el fixture no los valida.
    if (texto.includes('(')) return null;
    return texto.split(',').map((c) => c.trim()).filter(Boolean);
  }

  function validar(state) {
    if (!TABLAS_HORARIOS.has(state.table)) return null;
    const declaradas = seed.columnas?.[state.table];
    if (!Array.isArray(declaradas)) {
      return {
        message: `Could not find the table 'public.${state.table}' in the schema cache`,
        code: 'PGRST205',
      };
    }

    const columnas = columnasSeleccionadas(state.columns);
    if (columnas) {
      const faltante = columnas.find((columna) => !declaradas.includes(columna));
      if (faltante) return errorColumna(faltante);
    }
    for (const [op, columna] of state.filters) {
      if (!declaradas.includes(columna)) return errorColumna(columna);
    }
    return null;
  }

  function matches(row, filters) {
    return filters.every(([op, col, value]) => {
      if (String(col).includes('.')) return true;
      const current = row?.[col];
      if (op === 'eq') return String(current) === String(value);
      if (op === 'in') return (value || []).map(String).includes(String(current));
      if (op === 'gte') return String(current ?? '') >= String(value);
      if (op === 'ilike') return String(current ?? '').toLowerCase() === String(value || '').replaceAll('%', '').toLowerCase();
      return true;
    });
  }

  function from(table) {
    const state = { table, mode: 'select', columns: null, filters: [], options: null, inserted: null, single: false };

    async function run() {
      tables[state.table] ??= [];
      queries.push({
        table: state.table,
        mode: state.mode,
        columns: state.columns,
        filters: state.filters.map(([op, col, value]) => [op, col, value]),
      });

      if (TABLAS_HORARIOS.has(state.table) && state.mode === 'select') {
        const esSonda = state.columns !== '*';
        if (fallas.deteccion && esSonda) {
          return { data: null, error: { code: 'ETIMEDOUT', message: 'timeout de detección' } };
        }
        if (fallas.lectura && !esSonda) {
          return { data: null, error: { code: '57P01', message: 'connection terminated' } };
        }
      }

      const invalida = validar(state);
      if (invalida) return { data: null, error: invalida };

      if (state.mode === 'insert') {
        const rows = state.inserted.map((row) => ({ id: nextReservaId++, ...row }));
        tables[state.table].push(...rows);
        return { data: state.single ? rows[0] || null : rows, error: null };
      }
      const rows = tables[state.table].filter((row) => matches(row, state.filters));
      if (state.options?.head) return { data: null, error: null, count: rows.length };
      return { data: state.single ? rows[0] || null : rows, error: null };
    }

    const api = {
      select(columns, options) { state.columns = columns; state.options = options || null; return api; },
      insert(rows) { state.mode = 'insert'; state.inserted = Array.isArray(rows) ? rows : [rows]; return api; },
      eq(col, value) { state.filters.push(['eq', col, value]); return api; },
      in(col, values) { state.filters.push(['in', col, values]); return api; },
      gte(col, value) { state.filters.push(['gte', col, value]); return api; },
      ilike(col, value) { state.filters.push(['ilike', col, value]); return api; },
      order() { return api; },
      limit() { return api; },
      maybeSingle() { state.single = true; return api; },
      single() { state.single = true; return api; },
      then(resolve, reject) { return run().then(resolve, reject); },
    };
    return api;
  }

  return { from, tables, queries, fallas };
}

async function getAuthenticatedUser(req) {
  if (req.headers.authorization !== TOKEN) {
    return { user: null, status: 401, error: 'Se requiere Authorization Bearer token' };
  }
  return { user: { ...AUTH_USER }, status: null, error: null };
}

async function authUserFromBearer(req) {
  return req.headers.authorization === TOKEN ? { ...AUTH_USER } : null;
}

const PROFESOR_FIXTURE = {
  id: 11,
  nombre: 'Profesor Fixture',
  bio: 'Bio fixture',
  foto_url: null,
  certificaciones: ['FIPA'],
  aprobado: true,
  activo: true,
  certificado_estado: 'aprobado',
  deportes: ['padbol'],
};

const SEDE_BA = { id: 1, nombre: 'Sede Buenos Aires', moneda: 'ARS', timezone: BA };
const SEDE_KIR = { id: 2, nombre: 'Sede Kiritimati', moneda: 'USD', timezone: KIRITIMATI };
const SEDE_NY = { id: 3, nombre: 'Sede Nueva York', moneda: 'USD', timezone: NY };
const SEDE_TZ_INVALIDA = { id: 4, nombre: 'Sede TZ inválida', moneda: 'ARS', timezone: 'Marte/Olympus' };
const SEDE_TZ_AUSENTE = { id: 5, nombre: 'Sede sin timezone', moneda: 'ARS', timezone: null };

function claseFixture({ id, sede, titulo, cupo = 4, reservas = [], created = '2026-11-01T10:00:00.000Z' }) {
  return {
    id,
    sede_id: sede.id,
    profesor_id: 11,
    cancha_id: 3,
    deporte: 'padbol',
    titulo,
    descripcion: 'Fixture',
    tipo: 'grupal',
    cupo_maximo: cupo,
    duracion_minutos: 60,
    precio: 1000,
    activo: true,
    created_at: created,
    horas_cancelacion: 24,
    profesores: PROFESOR_FIXTURE,
    sedes: sede,
    clases_reservas: reservas,
  };
}

// Seed principal: DDL efectivo `clases_horarios(dia_semana, hora_inicio, hora_fin)`
// con tres sedes de zonas distintas y una clase sin horario (no debe listarse).
function seedRecurrente() {
  return {
    columnas: { clases_horarios: [...COLUMNAS_HORARIO_RECURRENTE] },
    clases: [
      claseFixture({ id: 7, sede: SEDE_BA, titulo: 'Clase BA' }),
      claseFixture({ id: 8, sede: SEDE_BA, titulo: 'Clase BA completa', cupo: 1, reservas: [{ id: 81 }] }),
      claseFixture({ id: 9, sede: SEDE_KIR, titulo: 'Clase Kiritimati' }),
      claseFixture({ id: 10, sede: SEDE_NY, titulo: 'Clase Nueva York' }),
      claseFixture({ id: 11, sede: SEDE_BA, titulo: 'Clase sin horario', created: '2030-01-01T10:00:00.000Z' }),
    ],
    horarios: [
      { id: 101, clase_id: 7, dia_semana: 0, hora_inicio: '09:00:00', hora_fin: '10:00:00' },
      { id: 102, clase_id: 8, dia_semana: 4, hora_inicio: '18:30:00', hora_fin: '19:30:00' },
      { id: 103, clase_id: 9, dia_semana: 0, hora_inicio: '09:00:00', hora_fin: '10:00:00' },
      { id: 104, clase_id: 10, dia_semana: 0, hora_inicio: '10:00:00', hora_fin: '11:00:00' },
    ],
    reservas: [{ id: 81, clase_id: 8, user_id: 'otro-user' }],
  };
}

// Seed legacy: tabla puente fecha/hora puntual. Incluye una fila incompleta
// (sin hora) que no debe convertirse en ocurrencia.
function seedLegacy() {
  return {
    columnas: { clases_horarios: [...COLUMNAS_HORARIO_LEGACY] },
    clases: [
      claseFixture({ id: 7, sede: SEDE_BA, titulo: 'Clase legacy' }),
      claseFixture({ id: 11, sede: SEDE_BA, titulo: 'Clase sin fila', created: '2030-01-01T10:00:00.000Z' }),
      claseFixture({ id: 12, sede: SEDE_KIR, titulo: 'Clase fila incompleta' }),
    ],
    horarios: [
      { id: 101, clase_id: 7, fecha: '2030-01-10', hora: '18:30:00' },
      { id: 102, clase_id: 12, fecha: '2030-01-11', hora: null },
    ],
    reservas: [],
  };
}

function legacyDeps(fake) {
  return {
    supabase: fake,
    supabaseAdmin: fake,
    authUserFromBearer,
    adminListScopeFromRequest: async () => null,
    assertUsuarioPuedeAdministrarSede: async () => ({}),
    assertSuperAdminReq: async () => ({}),
    canchasConNumeroReserva: (rows) => rows,
    assertReservaSinSolapeBackend: async () => {},
  };
}

async function startHarness(t, { legacyFirst = false, seed = seedRecurrente(), clock = CLOCK_DIA } = {}) {
  const fake = createFakeSupabase(seed);
  const app = express();
  app.use(express.json());
  const mountCompat = () => app.use('/api/clases', createClasesRouter({
    supabaseAdmin: fake,
    getAuthenticatedUser,
    now: () => new Date(clock),
  }));
  const mountLegacy = () => registerModuloClasesRoutes(app, legacyDeps(fake));

  if (legacyFirst) {
    mountLegacy();
    mountCompat();
  } else {
    mountCompat();
    mountLegacy();
  }

  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => {
    server.close(resolve);
    server.closeAllConnections?.();
  }));

  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(path, { method = 'GET', token = TOKEN, body, headers = {} } = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {
        ...(token ? { authorization: token } : {}),
        ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
        ...headers,
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    return { status: response.status, body: await response.json().catch(() => ({})) };
  }
  return { request, fake };
}

function porId(body) {
  return Object.fromEntries(body.map((row) => [row.id, row]));
}

test('orden del patch: GET /api/clases/disponibles responde 200 y no cae en /:id', async (t) => {
  const { request } = await startHarness(t);
  const response = await request('/api/clases/disponibles');
  assert.equal(response.status, 200);
  assert.ok(Array.isArray(response.body), 'debe devolver un array, no { error: "ID inválido" }');
  assert.deepEqual(response.body.map((row) => row.id).sort((a, b) => a - b), [7, 9, 10]);
  assert.equal(response.body.length, 3, 'clase 8 completa y clase 11 sin horario no se listan');
  assert.ok(response.body.every((row) => row.fecha), 'toda fila listada tiene fecha resuelta');
});

test('timezone por sede: mismo turno, dos sedes con cambio de día', async (t) => {
  const { request, fake } = await startHarness(t);
  const response = await request('/api/clases/disponibles');
  assert.equal(response.status, 200);
  const filas = porId(response.body);

  // Sede BA: sábado 23:30 local -> domingo 2026-11-22 09:00.
  assert.equal(filas[7].fecha, '2026-11-22');
  assert.equal(filas[7].hora, '09:00');
  assert.equal(filas[7].zona_horaria, BA);
  // Sede Kiritimati: domingo 16:30 local, las 09:00 ya pasaron -> 2026-11-29.
  assert.equal(filas[9].fecha, '2026-11-29');
  assert.equal(filas[9].hora, '09:00');
  assert.equal(filas[9].zona_horaria, KIRITIMATI);
  // Sede NY: sábado 21:30 local -> domingo 2026-11-22 10:00.
  assert.equal(filas[10].fecha, '2026-11-22');
  assert.equal(filas[10].hora, '10:00');
  assert.equal(filas[10].zona_horaria, NY);
  assert.equal(filas[7].recurrente, true);
  assert.equal(filas[7].dia_semana, 0);

  // La zona enviada por el cliente NO debe cambiar el resultado.
  const conZonaCliente = await request(
    '/api/clases/disponibles?timezone=Pacific/Kiritimati&tz=UTC',
    { headers: { 'x-timezone': 'Pacific/Kiritimati', 'x-client-timezone': 'UTC' } },
  );
  assert.equal(conZonaCliente.status, 200);
  assert.deepEqual(
    conZonaCliente.body.map((row) => [row.id, row.fecha, row.hora, row.zona_horaria]),
    response.body.map((row) => [row.id, row.fecha, row.hora, row.zona_horaria]),
  );

  // Evidencia: la detección sondeó dia_semana/hora_inicio/hora_fin y el fetch
  // de horarios no filtró por fecha (columna inexistente en el DDL real).
  const deteccion = fake.queries.find(
    (q) => q.table === 'clases_horarios' && String(q.columns || '').includes('dia_semana'),
  );
  assert.ok(deteccion, 'debe sondear las columnas recurrentes');
  const fetchHorarios = fake.queries.filter(
    (q) => q.table === 'clases_horarios' && q.mode === 'select' && q.columns === '*',
  );
  assert.ok(fetchHorarios.length > 0, 'debe consultar los horarios de las clases');
  assert.ok(
    fetchHorarios.every((q) => !q.filters.some(([op, col]) => op === 'gte' && col === 'fecha')),
    'no debe filtrar por fecha contra una tabla sin columna fecha',
  );
});

test('DST: la ocurrencia usa el calendario local de la sede (Nueva York)', async (t) => {
  const { request } = await startHarness(t, { clock: CLOCK_DST });
  const response = await request('/api/clases/disponibles');
  assert.equal(response.status, 200);
  const filas = porId(response.body);
  // 2026-11-01 termina el DST en NY; la hora de pared del turno sigue siendo 10:00.
  assert.equal(filas[10].fecha, '2026-11-01');
  assert.equal(filas[10].hora, '10:00');
  assert.equal(filas[10].zona_horaria, NY);
  // BA y Kiritimati: mismo día calendario, distinto reloj local.
  assert.equal(filas[7].fecha, '2026-11-01');
  assert.equal(filas[7].hora, '09:00');
  assert.equal(filas[9].fecha, '2026-11-01');
  assert.equal(filas[9].hora, '09:00');
});

test('legacy: sólo filas fecha/hora reales; sin falso éxito desde created_at', async (t) => {
  const { request } = await startHarness(t, { seed: seedLegacy() });
  const response = await request('/api/clases/disponibles');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body.map((row) => row.id), [7]);
  const fila = response.body[0];
  assert.equal(fila.fecha, '2030-01-10');
  assert.equal(fila.hora, '18:30');
  assert.equal(fila.recurrente, false);
  assert.equal(fila.zona_horaria, BA);
  assert.ok(!response.body.some((row) => row.id === 11), 'clase sin fila no se inventa desde created_at');
  assert.ok(!response.body.some((row) => row.id === 12), 'fila legacy incompleta no se publica');
});

test('ausencia real de tablas de horarios: 200 con lista vacía, nunca fechas fabricadas', async (t) => {
  const seed = seedRecurrente();
  delete seed.columnas;
  seed.horarios = [];
  const { request } = await startHarness(t, { seed });
  const response = await request('/api/clases/disponibles');
  assert.equal(response.status, 200);
  assert.deepEqual(response.body, []);
});

test('fallo técnico de detección: 503 con código estable, no 200[]', async (t) => {
  const seed = seedRecurrente();
  seed.fallas = { deteccion: true };
  const { request } = await startHarness(t, { seed });
  const response = await request('/api/clases/disponibles');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'CLASES_HORARIOS_UNAVAILABLE');
  assert.equal(response.body.retry, true);
  assert.ok(!Array.isArray(response.body), 'un fallo técnico no se convierte en vacío');
});

test('recuperación tras fallo transitorio de detección (cache reseteado)', async (t) => {
  const seed = seedRecurrente();
  seed.fallas = { deteccion: true };
  const { request, fake } = await startHarness(t, { seed });

  const fallo = await request('/api/clases/disponibles');
  assert.equal(fallo.status, 503);
  const sondasAntes = fake.queries.filter(
    (q) => q.table === 'clases_horarios' && q.columns && q.columns !== '*',
  ).length;

  fake.fallas.deteccion = false;

  const ok = await request('/api/clases/disponibles');
  assert.equal(ok.status, 200);
  assert.ok(Array.isArray(ok.body));
  assert.deepEqual(ok.body.map((row) => row.id).sort((a, b) => a - b), [7, 9, 10]);
  const sondasDespues = fake.queries.filter(
    (q) => q.table === 'clases_horarios' && q.columns && q.columns !== '*',
  ).length;
  assert.ok(sondasDespues > sondasAntes, 'debe reintentar la detección tras el fallo');
});

test('fallo técnico de lectura de horarios: 503 y recuperación, no vacío', async (t) => {
  const seed = seedRecurrente();
  seed.fallas = { lectura: true };
  const { request, fake } = await startHarness(t, { seed });

  const fallo = await request('/api/clases/disponibles');
  assert.equal(fallo.status, 503);
  assert.equal(fallo.body.code, 'CLASES_HORARIOS_UNAVAILABLE');
  assert.equal(fallo.body.retry, true);
  assert.ok(!Array.isArray(fallo.body));

  fake.fallas.lectura = false;
  const ok = await request('/api/clases/disponibles');
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.body.map((row) => row.id).sort((a, b) => a - b), [7, 9, 10]);
});

test('tabla existente sin forma reconocible: 503, no 200[]', async (t) => {
  const seed = seedRecurrente();
  seed.columnas = { clases_horarios: ['id', 'clase_id'] };
  const { request } = await startHarness(t, { seed });
  const response = await request('/api/clases/disponibles');
  assert.equal(response.status, 503);
  assert.equal(response.body.code, 'CLASES_HORARIOS_UNAVAILABLE');
});

test('sede con timezone inválida o ausente: 409 con revisión, sin ocurrencia inventada', async (t) => {
  const seed = seedRecurrente();
  seed.clases.push(
    claseFixture({ id: 13, sede: SEDE_TZ_INVALIDA, titulo: 'Clase TZ inválida' }),
    claseFixture({ id: 14, sede: SEDE_TZ_AUSENTE, titulo: 'Clase sin timezone' }),
  );
  const { request } = await startHarness(t, { seed });
  const response = await request('/api/clases/disponibles');
  assert.equal(response.status, 409);
  assert.equal(response.body.code, 'CLASES_SEDE_TIMEZONE_INVALIDA');
  assert.equal(response.body.revision_requerida, true);
  assert.ok(!Array.isArray(response.body), 'no se publica una ocurrencia con zona asumida');
  assert.equal(response.body.fecha, undefined);
  const afectadas = response.body.sedes_afectadas || [];
  const invalida = afectadas.find((sede) => sede.sede_id === 4);
  const ausente = afectadas.find((sede) => sede.sede_id === 5);
  assert.deepEqual(invalida, { sede_id: 4, timezone: 'Marte/Olympus', motivo: 'invalida' });
  assert.deepEqual(ausente, { sede_id: 5, timezone: null, motivo: 'ausente' });
});

test('sede con timezone válida sigue publicando la ocurrencia por sede', async (t) => {
  const seed = seedRecurrente();
  seed.clases = seed.clases.filter((clase) => [7, 9, 10].includes(clase.id));
  const { request } = await startHarness(t, { seed });
  const response = await request('/api/clases/disponibles');
  assert.equal(response.status, 200);
  const filas = porId(response.body);
  assert.equal(filas[7].fecha, '2026-11-22');
  assert.equal(filas[9].fecha, '2026-11-29');
  assert.equal(filas[10].fecha, '2026-11-22');
});

test('GET /api/clases/disponibles sin token responde 401 del router compatible', async (t) => {
  const { request } = await startHarness(t);
  const response = await request('/api/clases/disponibles', { token: null });
  assert.equal(response.status, 401);
  assert.match(String(response.body.error), /Authorization|autorizado|token/i);
});

test('POST /api/clases/:id/reservar: 201 en alta, 409 en duplicado y 409 en clase completa', async (t) => {
  const { request, fake } = await startHarness(t);

  const alta = await request('/api/clases/7/reservar', { method: 'POST', body: {} });
  assert.equal(alta.status, 201);
  assert.equal(alta.body.success, true);
  assert.ok(alta.body.reserva_id, 'debe devolver reserva_id');
  assert.equal(alta.body.clase.id, 7);
  assert.equal(alta.body.clase.spots_disponibles, 3);
  assert.equal(alta.body.clase.zona_horaria, BA);
  assert.equal(alta.body.clase.fecha, null, 'no se fabrica fecha de clase desde created_at');
  assert.equal(alta.body.clase.hora, null, 'no se fabrica hora de clase desde created_at');
  assert.equal(fake.tables.clases_reservas.filter((row) => row.clase_id === 7).length, 1);

  const duplicado = await request('/api/clases/7/reservar', { method: 'POST', body: {} });
  assert.equal(duplicado.status, 409);
  assert.match(String(duplicado.body.error), /Ya reservaste/i);

  const completa = await request('/api/clases/8/reservar', { method: 'POST', body: {} });
  assert.equal(completa.status, 409);
  assert.match(String(completa.body.error), /completa/i);

  const invalida = await request('/api/clases/abc/reservar', { method: 'POST', body: {} });
  assert.equal(invalida.status, 400);
  assert.match(String(invalida.body.error), /inválido/i);
});

test('control negativo: con el legacy montado primero, /:id captura "disponibles" y responde 400', async (t) => {
  const { request } = await startHarness(t, { legacyFirst: true });
  const response = await request('/api/clases/disponibles');
  assert.equal(response.status, 400);
  assert.match(String(response.body.error), /ID inválido/i);
});

test('reserva rechaza IDs parciales, no positivos o inseguros sin escribir en otra clase', async (t) => {
  const { request, fake } = await startHarness(t);
  const before = clone(fake.tables.clases_reservas);
  for (const id of ['7abc', '7.5', '7e0', '+7', '07', '0', '-7', '9007199254740993']) {
    const response = await request(`/api/clases/${encodeURIComponent(id)}/reservar`, { method: 'POST', body: {} });
    assert.equal(response.status, 400, id);
    assert.match(String(response.body.error), /inválido/i);
    assert.deepEqual(fake.tables.clases_reservas, before, id);
  }
  const valid = await request('/api/clases/7/reservar', { method: 'POST', body: {} });
  assert.equal(valid.status, 201);
  assert.equal(valid.body.clase.id, 7);
});

test('compatibilidad web: /api/clases?sede_id y /api/clases/:id siguen llegando al legacy', async (t) => {
  const { request } = await startHarness(t);

  const listado = await request('/api/clases?sede_id=1');
  assert.equal(listado.status, 200);
  assert.ok(Array.isArray(listado.body));
  assert.equal(listado.body.length, 3);
  const clase7 = listado.body.find((row) => row.id === 7);
  assert.equal(clase7.profesor.nombre, 'Profesor Fixture');
  assert.ok(Array.isArray(clase7.horarios));
  assert.equal(clase7.horarios[0].dia_semana, 0);

  const detalle = await request('/api/clases/7');
  assert.equal(detalle.status, 200);
  assert.equal(detalle.body.id, 7);
  assert.equal(detalle.body.cupo_maximo, 4);
  assert.ok(Array.isArray(detalle.body.horarios));

  // POST /api/clases/inscribir tiene un solo segmento: no debe matchear /:id/reservar.
  const inscribirSinToken = await request('/api/clases/inscribir', { method: 'POST', token: null, body: {} });
  assert.equal(inscribirSinToken.status, 401, 'debe resolver el legacy, no un 404 del router nuevo');
});
