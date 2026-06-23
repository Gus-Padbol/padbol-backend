import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  DEFAULT_EQUIPO1_NOMBRE,
  DEFAULT_EQUIPO2_NOMBRE,
  EquiposPartidoError,
  buildManualEquiposAsignacion,
  buildSorteoEquiposAsignacion,
  normalizeEquipoUserIds,
  procesarActualizarNombresEquiposPartido,
  procesarDefinirEquiposPartido,
  resolveEquipoNombres,
  resolveEquiposPartido,
  resolveUserEquipoKey,
  sanitizeEquipoNombre,
  validateEquipoNombreInput,
  validateEquiposAsignacion,
} from '../src/partidos/equiposService.js';
import { resolveCapitanesPartido } from '../src/partidos/resultadoService.js';

const CAPITAN = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const P3 = '33333333-3333-3333-3333-333333333333';
const P4 = '44444444-4444-4444-4444-444444444444';
const OUTSIDER = '99999999-9999-9999-9999-999999999999';

const ALL = [CAPITAN, P2, P3, P4];

function rowsFromIds(ids) {
  return ids.map((user_id, index) => ({
    user_id,
    email: `${user_id.slice(0, 8)}@test.com`,
    joined_at: `2026-06-01T19:0${index}:00.000Z`,
  }));
}

function createSupabaseMock(handlers = {}) {
  let pendingUpdate = null;
  let pendingUpdateTable = null;
  let pendingUpdateEq = null;

  function makeChain(table, resolveQuery) {
    const chain = {
      select() {
        return chain;
      },
      eq(_field, value) {
        pendingUpdateEq = value;
        return chain;
      },
      not() {
        return chain;
      },
      order() {
        return chain;
      },
      limit() {
        return chain;
      },
      update(payload) {
        pendingUpdate = payload;
        pendingUpdateTable = table;
        return chain;
      },
      maybeSingle: async () => {
        if (pendingUpdate && handlers.onUpdate) {
          const result = await handlers.onUpdate(pendingUpdate, {
            table: pendingUpdateTable,
            eq: pendingUpdateEq,
          });
          pendingUpdate = null;
          pendingUpdateTable = null;
          pendingUpdateEq = null;
          return result;
        }
        if (handlers.select) {
          return handlers.select();
        }
        return { data: null, error: null };
      },
      then(resolve, reject) {
        Promise.resolve(resolveQuery(table)).then(resolve, reject);
        return undefined;
      },
    };

    return chain;
  }

  return {
    from(table) {
      return makeChain(table, async (name) => {
        if (name === 'partidos_abiertos_jugadores') {
          return { data: handlers.jugadoresRows ?? [], error: null };
        }
        if (name === 'scoreboard_partidos') {
          if (pendingUpdate && handlers.onScoreboardUpdate) {
            await handlers.onScoreboardUpdate(pendingUpdate, {
              eq: pendingUpdateEq,
            });
            pendingUpdate = null;
            pendingUpdateEq = null;
            return { data: null, error: null };
          }
          return { data: handlers.scoreboardRows ?? [], error: null };
        }
        return { data: null, error: null };
      });
    },
  };
}

function createPgPoolMock(handlers = {}) {
  const calls = [];
  return {
    calls,
    query: async (sql, params = []) => {
      calls.push({ sql, params });
      if (/DELETE FROM partido_resumenes/i.test(sql)) {
        handlers.onDeleteSummaries?.(params);
        return { rowCount: handlers.deletedSummaries ?? 1, rows: [] };
      }
      return { rows: [], rowCount: 0 };
    },
  };
}

function buildPartidoSelectData(existing, overrides = {}) {
  return {
    id: 42,
    capitan_user_id: CAPITAN,
    capitan_email: 'cap@test.com',
    estado: 'completo',
    jugadores_requeridos: 4,
    equipos_asignacion: existing,
    ...overrides,
  };
}

describe('partidos equipos migration SQL', () => {
  const sql = readFileSync('docs/sql/partidos_equipos_migration.sql', 'utf8');

  it('contiene equipos_asignacion JSONB', () => {
    assert.match(sql, /equipos_asignacion JSONB/i);
    assert.match(sql, /partidos_abiertos/i);
  });
});

describe('equiposService helpers', () => {
  it('manual OK asigna 2 y 2', () => {
    const asignacion = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
      jugadoresRequeridos: 4,
    });

    assert.equal(asignacion.modo, 'manual');
    assert.equal(asignacion.bloqueado, true);
    assert.equal(asignacion.definido_por, CAPITAN);
    assert.equal(asignacion.equipo1_nombre, DEFAULT_EQUIPO1_NOMBRE);
    assert.equal(asignacion.equipo2_nombre, DEFAULT_EQUIPO2_NOMBRE);
    assert.deepEqual(asignacion.equipo1, normalizeEquipoUserIds([CAPITAN, P2]));
    assert.deepEqual(asignacion.equipo2, normalizeEquipoUserIds([P3, P4]));
  });

  it('manual acepta nombres personalizados', () => {
    const asignacion = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
      equipo1Nombre: 'Los Pibes',
      equipo2Nombre: 'La Meca Team',
    });

    assert.equal(asignacion.equipo1_nombre, 'Los Pibes');
    assert.equal(asignacion.equipo2_nombre, 'La Meca Team');
  });

  it('sorteo OK reparte equilibrado', () => {
    const asignacion = buildSorteoEquiposAsignacion({
      participantUserIds: ALL,
      capitanUserId: CAPITAN,
      jugadoresRequeridos: 4,
      randomFn: () => 0,
    });

    assert.equal(asignacion.modo, 'sorteo');
    assert.equal(asignacion.equipo1_nombre, DEFAULT_EQUIPO1_NOMBRE);
    assert.equal(asignacion.equipo2_nombre, DEFAULT_EQUIPO2_NOMBRE);
    assert.equal(asignacion.equipo1.length, 2);
    assert.equal(asignacion.equipo2.length, 2);
    assert.equal(
      new Set([...asignacion.equipo1, ...asignacion.equipo2]).size,
      4,
    );
  });

  it('resolveEquipoNombres usa defaults para partidos viejos', () => {
    const asignacion = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });
    delete asignacion.equipo1_nombre;
    delete asignacion.equipo2_nombre;

    assert.deepEqual(resolveEquipoNombres(asignacion), {
      equipo1_nombre: DEFAULT_EQUIPO1_NOMBRE,
      equipo2_nombre: DEFAULT_EQUIPO2_NOMBRE,
    });
    assert.deepEqual(resolveEquipoNombres(null), {
      equipo1_nombre: DEFAULT_EQUIPO1_NOMBRE,
      equipo2_nombre: DEFAULT_EQUIPO2_NOMBRE,
    });
  });

  it('sanitizeEquipoNombre recorta y sanea', () => {
    assert.equal(sanitizeEquipoNombre('  Los Pibes  '), 'Los Pibes');
    assert.equal(sanitizeEquipoNombre('   ', DEFAULT_EQUIPO2_NOMBRE), DEFAULT_EQUIPO2_NOMBRE);
    assert.equal(sanitizeEquipoNombre('A<b>c'), 'Abc');
  });

  it('validateEquipoNombreInput valida longitud, emails e insultos', () => {
    assert.equal(validateEquipoNombreInput('Los Gauchos'), 'Los Gauchos');
    assert.throws(
      () => validateEquipoNombreInput('A'),
      (err) => err instanceof EquiposPartidoError && err.code === 'EQUIPO_NOMBRE_DEMASIADO_CORTO',
    );
    assert.throws(
      () => validateEquipoNombreInput('a@test.com'),
      (err) => err instanceof EquiposPartidoError && err.code === 'EQUIPO_NOMBRE_EMAIL',
    );
    assert.throws(
      () => validateEquipoNombreInput('pelotudo team'),
      (err) => err instanceof EquiposPartidoError && err.code === 'EQUIPO_NOMBRE_NO_PERMITIDO',
    );
  });

  it('resolveUserEquipoKey detecta equipo del jugador', () => {
    const asignacion = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });
    const resolved = resolveEquiposPartido({
      jugadoresRows: rowsFromIds(ALL),
      capitanUserId: CAPITAN,
      equiposAsignacion: asignacion,
    });

    assert.equal(resolveUserEquipoKey(resolved, P2), 'equipo1');
    assert.equal(resolveUserEquipoKey(resolved, P3), 'equipo2');
    assert.equal(resolveUserEquipoKey(resolved, OUTSIDER), null);
  });

  it('duplicado rechaza', () => {
    assert.throws(
      () => buildManualEquiposAsignacion({
        equipo1: [CAPITAN, P2],
        equipo2: [P2, P4],
        capitanUserId: CAPITAN,
        participantUserIds: ALL,
      }),
      (err) => err instanceof EquiposPartidoError && /ambos equipos/i.test(err.message),
    );
  });

  it('usuario que no pertenece rechaza', () => {
    const validation = validateEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, OUTSIDER],
      participantUserIds: ALL,
    });

    assert.equal(validation.valid, false);
    assert.match(validation.error, /pertenecer al partido/i);
  });

  it('lectura usa equipos_asignacion', () => {
    const asignacion = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P4],
      equipo2: [P2, P3],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });

    const resolved = resolveEquiposPartido({
      jugadoresRows: rowsFromIds(ALL),
      capitanUserId: CAPITAN,
      equiposAsignacion: asignacion,
    });

    assert.equal(resolved.derivacion, 'capitan_manual');
    assert.deepEqual(
      resolved.equipo1Rows.map((row) => String(row.user_id).toLowerCase()),
      normalizeEquipoUserIds([CAPITAN, P4]),
    );
    assert.deepEqual(
      resolved.equipo2Rows.map((row) => String(row.user_id).toLowerCase()),
      normalizeEquipoUserIds([P2, P3]),
    );
  });

  it('fallback joined_at_split sigue funcionando', () => {
    const resolved = resolveEquiposPartido({
      jugadoresRows: rowsFromIds(ALL),
      capitanUserId: CAPITAN,
      capitanEmail: 'cap@test.com',
      equiposAsignacion: null,
    });

    assert.equal(resolved.derivacion, 'joined_at_split');
    assert.equal(resolved.equipo1Rows.length, 2);
    assert.equal(resolved.equipo2Rows.length, 2);
    assert.equal(String(resolved.equipo1Rows[0].user_id), CAPITAN);
  });
});

describe('procesarDefinirEquiposPartido', () => {
  it('no capitán rechaza', async () => {
    const supabaseAdmin = createSupabaseMock({
      select: () => ({
        data: {
          id: 42,
          capitan_user_id: CAPITAN,
          capitan_email: 'cap@test.com',
          estado: 'completo',
          jugadores_requeridos: 4,
          equipos_asignacion: null,
        },
        error: null,
      }),
      jugadoresRows: rowsFromIds(ALL),
      scoreboardRows: [],
    });

    await assert.rejects(
      () => procesarDefinirEquiposPartido({
        supabaseAdmin,
        partidoId: 42,
        user: { id: P2 },
        body: { modo: 'sorteo' },
      }),
      (err) => err instanceof EquiposPartidoError && err.status === 403,
    );
  });

  it('partido finalizado rechaza', async () => {
    const supabaseAdmin = createSupabaseMock({
      select: () => ({
        data: {
          id: 42,
          capitan_user_id: CAPITAN,
          estado: 'finalizado',
          jugadores_requeridos: 4,
        },
        error: null,
      }),
    });

    await assert.rejects(
      () => procesarDefinirEquiposPartido({
        supabaseAdmin,
        partidoId: 42,
        user: { id: CAPITAN },
        body: { modo: 'manual', equipo1: [CAPITAN, P2], equipo2: [P3, P4] },
      }),
      (err) => err instanceof EquiposPartidoError && err.status === 409,
    );
  });

  it('marcador activo rechaza', async () => {
    const supabaseAdmin = createSupabaseMock({
      select: () => ({
        data: {
          id: 42,
          capitan_user_id: CAPITAN,
          capitan_email: 'cap@test.com',
          estado: 'completo',
          jugadores_requeridos: 4,
        },
        error: null,
      }),
      jugadoresRows: rowsFromIds(ALL),
      scoreboardRows: [{ id: 'sb-1', estado: 'en_curso' }],
    });

    await assert.rejects(
      () => procesarDefinirEquiposPartido({
        supabaseAdmin,
        partidoId: 42,
        user: { id: CAPITAN },
        body: { modo: 'sorteo' },
      }),
      (err) => err instanceof EquiposPartidoError && err.code === 'EQUIPOS_SCOREBOARD_ACTIVO',
    );
  });

  it('manual persiste y responde equipos resueltos', async () => {
    let saved = null;
    const supabaseAdmin = createSupabaseMock({
      select: () => ({
        data: {
          id: 42,
          capitan_user_id: CAPITAN,
          capitan_email: 'cap@test.com',
          estado: 'completo',
          jugadores_requeridos: 4,
          equipos_asignacion: null,
        },
        error: null,
      }),
      onUpdate: async (payload) => {
        saved = payload.equipos_asignacion;
        return {
          data: {
            id: 42,
            capitan_user_id: CAPITAN,
            capitan_email: 'cap@test.com',
            equipos_asignacion: saved,
            jugadores_requeridos: 4,
          },
          error: null,
        };
      },
      jugadoresRows: rowsFromIds(ALL),
      scoreboardRows: [],
    });

    const result = await procesarDefinirEquiposPartido({
      supabaseAdmin,
      partidoId: 42,
      user: { id: CAPITAN },
      body: { modo: 'manual', equipo1: [CAPITAN, P2], equipo2: [P3, P4] },
    });

    assert.equal(result.status, 200);
    assert.equal(result.body.success, true);
    assert.equal(result.body.equipos_derivacion, 'capitan_manual');
    assert.equal(saved.modo, 'manual');
    assert.equal(saved.equipo1_nombre, DEFAULT_EQUIPO1_NOMBRE);
    assert.equal(saved.equipo2_nombre, DEFAULT_EQUIPO2_NOMBRE);
    assert.equal(result.body.equipo1.length, 2);
    assert.equal(result.body.equipo2.length, 2);
  });

  it('manual persiste nombres personalizados', async () => {
    let saved = null;
    const supabaseAdmin = createSupabaseMock({
      select: () => ({
        data: {
          id: 42,
          capitan_user_id: CAPITAN,
          capitan_email: 'cap@test.com',
          estado: 'completo',
          jugadores_requeridos: 4,
          equipos_asignacion: null,
        },
        error: null,
      }),
      onUpdate: async (payload) => {
        saved = payload.equipos_asignacion;
        return {
          data: {
            id: 42,
            capitan_user_id: CAPITAN,
            capitan_email: 'cap@test.com',
            equipos_asignacion: saved,
            jugadores_requeridos: 4,
          },
          error: null,
        };
      },
      jugadoresRows: rowsFromIds(ALL),
      scoreboardRows: [],
    });

    await procesarDefinirEquiposPartido({
      supabaseAdmin,
      partidoId: 42,
      user: { id: CAPITAN },
      body: {
        modo: 'manual',
        equipo1: [CAPITAN, P2],
        equipo2: [P3, P4],
        equipo1_nombre: 'Los Pibes',
        equipo2_nombre: 'La Meca Team',
      },
    });

    assert.equal(saved.equipo1_nombre, 'Los Pibes');
    assert.equal(saved.equipo2_nombre, 'La Meca Team');
  });

  it('actualiza solo nombres sin cambiar jugadores', async () => {
    const existing = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });
    let saved = null;
    let scoreboardUpdate = null;

    const supabaseAdmin = createSupabaseMock({
      select: () => ({
        data: {
          id: 42,
          capitan_user_id: CAPITAN,
          capitan_email: 'cap@test.com',
          estado: 'completo',
          jugadores_requeridos: 4,
          equipos_asignacion: existing,
        },
        error: null,
      }),
      onUpdate: async (payload) => {
        saved = payload.equipos_asignacion;
        return {
          data: {
            id: 42,
            capitan_user_id: CAPITAN,
            capitan_email: 'cap@test.com',
            equipos_asignacion: saved,
            jugadores_requeridos: 4,
          },
          error: null,
        };
      },
      onScoreboardUpdate: async (payload) => {
        scoreboardUpdate = payload;
      },
      jugadoresRows: rowsFromIds(ALL),
      scoreboardRows: [{ id: 'sb-1', estado: 'en_curso' }],
    });

    const result = await procesarDefinirEquiposPartido({
      supabaseAdmin,
      partidoId: 42,
      user: { id: CAPITAN },
      body: {
        equipo1_nombre: 'Los Pibes',
        equipo2_nombre: 'La Meca Team',
      },
    });

    assert.equal(result.status, 200);
    assert.deepEqual(saved.equipo1, existing.equipo1);
    assert.deepEqual(saved.equipo2, existing.equipo2);
    assert.equal(saved.equipo1_nombre, 'Los Pibes');
    assert.equal(saved.equipo2_nombre, 'La Meca Team');
    assert.equal(scoreboardUpdate.equipo_a_nombre, 'Los Pibes');
    assert.equal(scoreboardUpdate.equipo_b_nombre, 'La Meca Team');
  });

  it('actualizar nombres rechaza partido finalizado', async () => {
    const existing = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });

    const supabaseAdmin = createSupabaseMock({
      select: () => ({
        data: {
          id: 42,
          capitan_user_id: CAPITAN,
          estado: 'finalizado',
          jugadores_requeridos: 4,
          equipos_asignacion: existing,
        },
        error: null,
      }),
    });

    await assert.rejects(
      () => procesarDefinirEquiposPartido({
        supabaseAdmin,
        partidoId: 42,
        user: { id: CAPITAN },
        body: { equipo1_nombre: 'Los Pibes' },
      }),
      (err) => err instanceof EquiposPartidoError && err.code === 'PARTIDO_FINALIZADO',
    );
  });

  it('actualizar nombres rechaza si jugador no anotado intenta editar', async () => {
    const existing = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });

    const supabaseAdmin = createSupabaseMock({
      select: () => ({
        data: buildPartidoSelectData(existing),
        error: null,
      }),
      jugadoresRows: rowsFromIds(ALL),
    });

    await assert.rejects(
      () => procesarDefinirEquiposPartido({
        supabaseAdmin,
        partidoId: 42,
        user: { id: OUTSIDER },
        body: { equipo1_nombre: 'Los Pibes' },
      }),
      (err) => err instanceof EquiposPartidoError
        && err.status === 403
        && err.code === 'EQUIPOS_NOMBRES_NO_AUTORIZADO',
    );
  });
});

describe('procesarActualizarNombresEquiposPartido permisos', () => {
  function createNombreUpdateMock(existing, handlers = {}) {
    let saved = null;
    let scoreboardUpdate = null;

    const supabaseAdmin = createSupabaseMock({
      select: () => ({
        data: buildPartidoSelectData(existing, handlers.partidoOverrides),
        error: null,
      }),
      onUpdate: async (payload) => {
        saved = payload.equipos_asignacion;
        return {
          data: {
            id: 42,
            capitan_user_id: CAPITAN,
            capitan_email: 'cap@test.com',
            equipos_asignacion: saved,
            jugadores_requeridos: 4,
          },
          error: null,
        };
      },
      onScoreboardUpdate: async (payload) => {
        scoreboardUpdate = payload;
      },
      jugadoresRows: handlers.jugadoresRows ?? rowsFromIds(ALL),
      scoreboardRows: handlers.scoreboardRows ?? [{ id: 'sb-1', estado: 'en_curso' }],
    });

    const pgPool = handlers.pgPool ?? null;

    return {
      supabaseAdmin,
      pgPool,
      getSaved: () => saved,
      getScoreboardUpdate: () => scoreboardUpdate,
    };
  }

  it('capitán edita ambos nombres', async () => {
    const existing = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });
    const { supabaseAdmin, getSaved } = createNombreUpdateMock(existing);

    const result = await procesarActualizarNombresEquiposPartido({
      supabaseAdmin,
      partidoId: 42,
      user: { id: CAPITAN },
      body: {
        equipo1_nombre: 'Los Gauchos',
        equipo2_nombre: 'Los Cedros',
      },
    });

    assert.equal(result.status, 200);
    assert.equal(getSaved().equipo1_nombre, 'Los Gauchos');
    assert.equal(getSaved().equipo2_nombre, 'Los Cedros');
  });

  it('jugador de equipo 1 edita solo equipo1_nombre', async () => {
    const existing = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });
    const { supabaseAdmin, getSaved } = createNombreUpdateMock(existing);

    const result = await procesarActualizarNombresEquiposPartido({
      supabaseAdmin,
      partidoId: 42,
      user: { id: P2 },
      body: { equipo1_nombre: 'Los Gauchos' },
    });

    assert.equal(result.status, 200);
    assert.equal(getSaved().equipo1_nombre, 'Los Gauchos');
    assert.equal(getSaved().equipo2_nombre, DEFAULT_EQUIPO2_NOMBRE);
  });

  it('jugador de equipo 2 edita solo equipo2_nombre', async () => {
    const existing = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });
    const { supabaseAdmin, getSaved } = createNombreUpdateMock(existing);

    const result = await procesarActualizarNombresEquiposPartido({
      supabaseAdmin,
      partidoId: 42,
      user: { id: P3 },
      body: { equipo2_nombre: 'Los Cedros' },
    });

    assert.equal(result.status, 200);
    assert.equal(getSaved().equipo2_nombre, 'Los Cedros');
  });

  it('jugador de equipo 1 no puede editar equipo2_nombre', async () => {
    const existing = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });
    const { supabaseAdmin } = createNombreUpdateMock(existing);

    await assert.rejects(
      () => procesarActualizarNombresEquiposPartido({
        supabaseAdmin,
        partidoId: 42,
        user: { id: P2 },
        body: { equipo2_nombre: 'Los Cedros' },
      }),
      (err) => err instanceof EquiposPartidoError
        && err.status === 403
        && err.code === 'EQUIPOS_NOMBRES_EQUIPO_INCORRECTO',
    );
  });

  it('nombre inválido falla', async () => {
    const existing = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });
    const { supabaseAdmin } = createNombreUpdateMock(existing);

    await assert.rejects(
      () => procesarActualizarNombresEquiposPartido({
        supabaseAdmin,
        partidoId: 42,
        user: { id: CAPITAN },
        body: { equipo1_nombre: 'X' },
      }),
      (err) => err instanceof EquiposPartidoError && err.code === 'EQUIPO_NOMBRE_DEMASIADO_CORTO',
    );
  });

  it('al editar nombres se borra cache de partido_resumenes', async () => {
    const existing = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });
    let deletedPartidoId = null;
    const pgPool = createPgPoolMock({
      onDeleteSummaries: (params) => {
        deletedPartidoId = params[0];
      },
    });
    const { supabaseAdmin } = createNombreUpdateMock(existing, { pgPool });

    await procesarActualizarNombresEquiposPartido({
      supabaseAdmin,
      partidoId: 42,
      user: { id: CAPITAN },
      body: { equipo1_nombre: 'Los Gauchos' },
      pgPool,
    });

    assert.equal(deletedPartidoId, 42);
    assert.equal(pgPool.calls.length, 1);
    assert.match(pgPool.calls[0].sql, /DELETE FROM partido_resumenes/i);
  });
});

describe('resolveCapitanesPartido con equipos asignados', () => {
  it('usa primer jugador del equipo2 asignado para capitan2', async () => {
    const asignacion = buildManualEquiposAsignacion({
      equipo1: [CAPITAN, P2],
      equipo2: [P3, P4],
      capitanUserId: CAPITAN,
      participantUserIds: ALL,
    });

    const supabaseAdmin = {
      from(table) {
        if (table === 'partidos_abiertos') {
          return {
            select: () => ({
              eq: () => ({
                maybeSingle: async () => ({
                  data: { equipos_asignacion: asignacion, capitan_email: 'cap@test.com' },
                  error: null,
                }),
              }),
            }),
          };
        }

        if (table === 'partidos_abiertos_jugadores') {
          return {
            select: () => ({
              eq: () => ({
                order: async () => ({
                  data: rowsFromIds(ALL),
                  error: null,
                }),
              }),
            }),
          };
        }

        return {
          select: () => ({
            eq: () => ({
              maybeSingle: async () => ({ data: null, error: null }),
            }),
          }),
        };
      },
    };

    const capitanes = await resolveCapitanesPartido(supabaseAdmin, 42, CAPITAN);

    assert.equal(capitanes.capitan1, CAPITAN);
    assert.equal(String(capitanes.capitan2).toLowerCase(), P3);
    assert.deepEqual(capitanes.capitanes, [CAPITAN, P3]);
  });
});
