import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import {
  EquiposPartidoError,
  buildManualEquiposAsignacion,
  buildSorteoEquiposAsignacion,
  normalizeEquipoUserIds,
  procesarDefinirEquiposPartido,
  resolveEquiposPartido,
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

  function makeChain(table, resolveQuery) {
    const chain = {
      select() {
        return chain;
      },
      eq() {
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
        return chain;
      },
      maybeSingle: async () => {
        if (pendingUpdate && handlers.onUpdate) {
          const result = await handlers.onUpdate(pendingUpdate);
          pendingUpdate = null;
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
          return { data: handlers.scoreboardRows ?? [], error: null };
        }
        return { data: null, error: null };
      });
    },
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
    assert.deepEqual(asignacion.equipo1, normalizeEquipoUserIds([CAPITAN, P2]));
    assert.deepEqual(asignacion.equipo2, normalizeEquipoUserIds([P3, P4]));
  });

  it('sorteo OK reparte equilibrado', () => {
    const asignacion = buildSorteoEquiposAsignacion({
      participantUserIds: ALL,
      capitanUserId: CAPITAN,
      jugadoresRequeridos: 4,
      randomFn: () => 0,
    });

    assert.equal(asignacion.modo, 'sorteo');
    assert.equal(asignacion.equipo1.length, 2);
    assert.equal(asignacion.equipo2.length, 2);
    assert.equal(
      new Set([...asignacion.equipo1, ...asignacion.equipo2]).size,
      4,
    );
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
    assert.equal(result.body.equipo1.length, 2);
    assert.equal(result.body.equipo2.length, 2);
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
