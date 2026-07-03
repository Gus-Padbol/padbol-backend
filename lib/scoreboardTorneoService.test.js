import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildControlLinks,
  buildDisplayLinks,
  buildLiveCanchaDisplayPath,
  getPublicWebBase,
} from '../src/scoreboard/scoreboardLinks.js';
import {
  generarScoreboardsForTorneo,
  isPartidoEstadoJugable,
  mapJugadoresForScoreboard,
  parseGenerarScoreboardsOptions,
  resolveCanchaForPartidoIndex,
} from '../src/scoreboard/scoreboardTorneoService.js';

describe('scoreboardLinks', () => {
  it('buildLiveCanchaDisplayPath codifica cancha', () => {
    assert.equal(
      buildLiveCanchaDisplayPath(1, 'Cancha 1'),
      '/live/cancha/1/Cancha%201',
    );
  });

  it('buildDisplayLinks arma url pública', () => {
    const prev = process.env.PUBLIC_WEB_BASE;
    process.env.PUBLIC_WEB_BASE = 'https://padbolmatch.com';
    const links = buildDisplayLinks(1, 'Cancha 2');
    assert.equal(links.display_path, '/live/cancha/1/Cancha%202');
    assert.equal(links.display_url, 'https://padbolmatch.com/live/cancha/1/Cancha%202');
    if (prev == null) delete process.env.PUBLIC_WEB_BASE;
    else process.env.PUBLIC_WEB_BASE = prev;
  });

  it('buildControlLinks null sin token', () => {
    assert.deepEqual(buildControlLinks(null), {
      control_path: null,
      control_url: null,
    });
  });
});

describe('parseGenerarScoreboardsOptions', () => {
  it('defaults emitir_tokens true y reemitir_tokens false', () => {
    const opts = parseGenerarScoreboardsOptions({});
    assert.equal(opts.emitir_tokens, true);
    assert.equal(opts.reemitir_tokens, false);
    assert.equal(opts.cancha_default, null);
    assert.deepEqual(opts.canchas_rotacion, []);
  });

  it('respeta flags y rotación', () => {
    const opts = parseGenerarScoreboardsOptions({
      emitir_tokens: false,
      reemitir_tokens: true,
      cancha_default: 'Cancha 1',
      canchas_rotacion: ['A', 'B'],
    });
    assert.equal(opts.emitir_tokens, false);
    assert.equal(opts.reemitir_tokens, true);
    assert.equal(opts.cancha_default, 'Cancha 1');
    assert.deepEqual(opts.canchas_rotacion, ['A', 'B']);
  });
});

describe('resolveCanchaForPartidoIndex', () => {
  const options = parseGenerarScoreboardsOptions({
    cancha_default: 'Cancha 1',
    canchas_rotacion: ['Cancha 2', 'Cancha 3'],
  });

  it('prioriza cancha del partido', () => {
    assert.equal(
      resolveCanchaForPartidoIndex({ cancha: 'VIP' }, 0, options),
      'VIP',
    );
  });

  it('usa rotación si partido no tiene cancha', () => {
    assert.equal(resolveCanchaForPartidoIndex({}, 0, options), 'Cancha 2');
    assert.equal(resolveCanchaForPartidoIndex({}, 1, options), 'Cancha 3');
    assert.equal(resolveCanchaForPartidoIndex({}, 2, options), 'Cancha 2');
  });
});

describe('mapJugadoresForScoreboard', () => {
  it('normaliza nombres y jerseys', () => {
    const out = mapJugadoresForScoreboard([
      { nombre: 'Ana', numero: 7 },
      { name: 'Bruno' },
    ]);
    assert.equal(out[0].nombre, 'Ana');
    assert.equal(out[0].jersey, 7);
    assert.equal(out[1].nombre, 'Bruno');
    assert.equal(out[1].jersey, 2);
  });
});

describe('generarScoreboardsForTorneo', () => {
  it('crea scoreboards, emite tokens y es idempotente en existing', async () => {
    const torneo = { id: 23, nombre: 'Demo Torneo', sede_id: 1 };
    const partidos = [
      {
        id: 401,
        torneo_id: 23,
        sede_id: 1,
        cancha: 'Cancha 1',
        fecha_hora: '2026-06-25T15:00:00',
        equipo_a_id: 1,
        equipo_b_id: 2,
      },
      {
        id: 402,
        torneo_id: 23,
        sede_id: 1,
        cancha: null,
        fecha_hora: null,
        equipo_a_id: null,
        equipo_b_id: 2,
      },
    ];
    const equipos = [
      { id: 1, nombre: 'Equipo A', jugadores: [{ nombre: 'J1' }] },
      { id: 2, nombre: 'Equipo B', jugadores: [] },
    ];

    const scoreboardsByPartido = new Map();
    let insertCount = 0;
    let tokenUpdateCount = 0;

    const supabaseAdmin = {
      from(table) {
        const api = {
          eq(_col, val) {
            this._eq = { col: _col, val };
            return api;
          },
          in(_col, vals) {
            this._in = vals;
            return api;
          },
          not() { return api; },
          order() { return api; },
          select(_cols) {
            this._select = true;
            return api;
          },
          single() {
            return Promise.resolve({ data: torneo, error: null });
          },
          limit() { return api; },
          insert(row) {
            insertCount += 1;
            const created = {
              id: `sb-${row.partido_torneo_id}`,
              sede_id: row.sede_id,
              torneo_id: row.torneo_id,
              torneo_nombre: row.torneo_nombre,
              cancha: row.cancha,
              partido_torneo_id: row.partido_torneo_id,
              equipo_a_nombre: row.equipo_a_nombre,
              equipo_b_nombre: row.equipo_b_nombre,
              estado: 'pendiente',
            };
            scoreboardsByPartido.set(Number(row.partido_torneo_id), created);
            return {
              select: () => ({
                limit: () => Promise.resolve({ data: [created], error: null }),
              }),
            };
          },
          update(patch) {
            tokenUpdateCount += 1;
            return {
              eq: (_c, scoreboardId) => Promise.resolve({ error: null, _scoreboardId: scoreboardId, patch }),
            };
          },
          then(resolve, reject) {
            try {
              if (table === 'torneos') {
                resolve({ data: torneo, error: null });
                return;
              }
              if (table === 'partidos') {
                resolve({ data: partidos, error: null });
                return;
              }
              if (table === 'equipos') {
                resolve({ data: equipos, error: null });
                return;
              }
              if (table === 'scoreboard_partidos' && this._in) {
                const rows = [...scoreboardsByPartido.values()].filter((r) =>
                  this._in.includes(r.partido_torneo_id),
                );
                resolve({ data: rows, error: null });
                return;
              }
              resolve({ data: null, error: null });
            } catch (err) {
              reject(err);
            }
          },
        };
        return api;
      },
    };

    const first = await generarScoreboardsForTorneo(supabaseAdmin, 23, {
      emitir_tokens: true,
    });

    assert.equal(first.ok, true);
    assert.equal(first.created, 1);
    assert.equal(first.skipped, 1);
    assert.equal(first.items.length, 2);
    assert.equal(first.items[0].status, 'created');
    assert.equal(first.items[0].scoreboard_id, 'sb-401');
    assert.ok(first.items[0].control_token);
    assert.ok(first.items[0].control_url?.includes('/scoreboard/control/'));
    assert.equal(first.items[1].status, 'skipped');
    assert.equal(first.items[1].skip_reason, 'missing_teams');
    assert.equal(insertCount, 1);
    assert.equal(tokenUpdateCount, 1);

    insertCount = 0;
    tokenUpdateCount = 0;

    const second = await generarScoreboardsForTorneo(supabaseAdmin, 23, {
      emitir_tokens: true,
      reemitir_tokens: false,
    });

    assert.equal(second.created, 0);
    assert.equal(second.skipped, 1);
    assert.equal(second.items[0].status, 'existing');
    assert.equal(second.items[0].control_token, null);
    assert.equal(second.items[0].existing_note, 'scoreboard_already_exists');
    assert.equal(insertCount, 0);
    assert.equal(tokenUpdateCount, 0);
  });
});

function buildSupabaseMock({ torneo, partidos, equipos, initialScoreboards = [] }) {
  const scoreboardsByPartido = new Map(
    initialScoreboards.map((sb) => [Number(sb.partido_torneo_id), sb]),
  );
  const state = { insertCount: 0, tokenUpdateCount: 0, insertedPartidoIds: [] };

  const supabaseAdmin = {
    from(table) {
      const api = {
        eq(_col, val) { this._eq = { col: _col, val }; return api; },
        in(_col, vals) { this._in = vals; return api; },
        not() { return api; },
        order() { return api; },
        select() { this._select = true; return api; },
        single() { return Promise.resolve({ data: torneo, error: null }); },
        limit() { return api; },
        insert(row) {
          state.insertCount += 1;
          state.insertedPartidoIds.push(Number(row.partido_torneo_id));
          const created = {
            id: `sb-${row.partido_torneo_id}`,
            sede_id: row.sede_id,
            torneo_id: row.torneo_id,
            torneo_nombre: row.torneo_nombre,
            cancha: row.cancha,
            partido_torneo_id: row.partido_torneo_id,
            equipo_a_nombre: row.equipo_a_nombre,
            equipo_b_nombre: row.equipo_b_nombre,
            estado: 'pendiente',
          };
          scoreboardsByPartido.set(Number(row.partido_torneo_id), created);
          return {
            select: () => ({
              limit: () => Promise.resolve({ data: [created], error: null }),
            }),
          };
        },
        update(patch) {
          state.tokenUpdateCount += 1;
          return {
            eq: (_c, scoreboardId) => Promise.resolve({ error: null, _scoreboardId: scoreboardId, patch }),
          };
        },
        then(resolve, reject) {
          try {
            if (table === 'torneos') { resolve({ data: torneo, error: null }); return; }
            if (table === 'partidos') { resolve({ data: partidos, error: null }); return; }
            if (table === 'equipos') { resolve({ data: equipos, error: null }); return; }
            if (table === 'scoreboard_partidos' && this._in) {
              const rows = [...scoreboardsByPartido.values()].filter((r) =>
                this._in.includes(r.partido_torneo_id),
              );
              resolve({ data: rows, error: null });
              return;
            }
            resolve({ data: null, error: null });
          } catch (err) {
            reject(err);
          }
        },
      };
      return api;
    },
  };

  return { supabaseAdmin, state };
}

const TORNEO = { id: 23, nombre: 'Demo Torneo', sede_id: 1 };
const EQUIPOS = [
  { id: 1, nombre: 'Equipo A', jugadores: [{ nombre: 'J1' }] },
  { id: 2, nombre: 'Equipo B', jugadores: [] },
];

function partidoBase(overrides = {}) {
  return {
    id: 500,
    torneo_id: 23,
    sede_id: 1,
    cancha: 'Cancha 1',
    fecha_hora: null,
    equipo_a_id: 1,
    equipo_b_id: 2,
    estado: 'pendiente',
    ...overrides,
  };
}

describe('isPartidoEstadoJugable', () => {
  it('pendiente/en_curso/programado/ausente son jugables', () => {
    assert.equal(isPartidoEstadoJugable('pendiente'), true);
    assert.equal(isPartidoEstadoJugable('programado'), true);
    assert.equal(isPartidoEstadoJugable('en_curso'), true);
    assert.equal(isPartidoEstadoJugable(null), true);
    assert.equal(isPartidoEstadoJugable(undefined), true);
  });

  it('finalizado/terminado/cancelado NO son jugables', () => {
    assert.equal(isPartidoEstadoJugable('finalizado'), false);
    assert.equal(isPartidoEstadoJugable('FINALIZADO'), false);
    assert.equal(isPartidoEstadoJugable(' terminado '), false);
    assert.equal(isPartidoEstadoJugable('cancelado'), false);
  });
});

describe('generarScoreboardsForTorneo — filtro por estado de partido', () => {
  it('partido pendiente con ambos equipos → crea scoreboard', async () => {
    const partidos = [partidoBase({ id: 501, estado: 'pendiente' })];
    const { supabaseAdmin, state } = buildSupabaseMock({ torneo: TORNEO, partidos, equipos: EQUIPOS });

    const res = await generarScoreboardsForTorneo(supabaseAdmin, 23, { emitir_tokens: true });

    assert.equal(res.created, 1);
    assert.equal(res.skipped, 0);
    assert.equal(res.items[0].status, 'created');
    assert.equal(state.insertCount, 1);
  });

  it('partido finalizado con ambos equipos → NO crea scoreboard', async () => {
    const partidos = [partidoBase({ id: 502, estado: 'finalizado' })];
    const { supabaseAdmin, state } = buildSupabaseMock({ torneo: TORNEO, partidos, equipos: EQUIPOS });

    const res = await generarScoreboardsForTorneo(supabaseAdmin, 23, { emitir_tokens: true });

    assert.equal(res.created, 0);
    assert.equal(res.skipped, 1);
    assert.equal(res.items[0].status, 'skipped');
    assert.equal(res.items[0].skip_reason, 'estado_no_jugable');
    assert.equal(state.insertCount, 0);
  });

  it('partidos terminado y cancelado sin scoreboard previo → siguen sin crear', async () => {
    const partidos = [
      partidoBase({ id: 503, estado: 'terminado' }),
      partidoBase({ id: 504, estado: 'cancelado' }),
    ];
    const { supabaseAdmin, state } = buildSupabaseMock({ torneo: TORNEO, partidos, equipos: EQUIPOS });

    const res = await generarScoreboardsForTorneo(supabaseAdmin, 23, { emitir_tokens: true });

    assert.equal(res.created, 0);
    assert.equal(res.skipped, 2);
    assert.ok(res.items.every((i) => i.status === 'skipped' && i.skip_reason === 'estado_no_jugable'));
    assert.equal(state.insertCount, 0);
  });

  it('partido pendiente con scoreboard existente → no duplica', async () => {
    const partidos = [partidoBase({ id: 505, estado: 'pendiente' })];
    const initialScoreboards = [{
      id: 'sb-505', partido_torneo_id: 505, sede_id: 1, cancha: 'Cancha 1',
      equipo_a_nombre: 'Equipo A', equipo_b_nombre: 'Equipo B', estado: 'pendiente',
    }];
    const { supabaseAdmin, state } = buildSupabaseMock({ torneo: TORNEO, partidos, equipos: EQUIPOS, initialScoreboards });

    const res = await generarScoreboardsForTorneo(supabaseAdmin, 23, { emitir_tokens: true });

    assert.equal(res.created, 0);
    assert.equal(res.items[0].status, 'existing');
    assert.equal(state.insertCount, 0);
  });

  it('partido con equipo faltante → no crea (missing_teams)', async () => {
    const partidos = [partidoBase({ id: 506, estado: 'pendiente', equipo_a_id: null })];
    const { supabaseAdmin, state } = buildSupabaseMock({ torneo: TORNEO, partidos, equipos: EQUIPOS });

    const res = await generarScoreboardsForTorneo(supabaseAdmin, 23, { emitir_tokens: true });

    assert.equal(res.created, 0);
    assert.equal(res.items[0].status, 'skipped');
    assert.equal(res.items[0].skip_reason, 'missing_teams');
    assert.equal(state.insertCount, 0);
  });

  it('final knockout pendiente completa → sigue creando', async () => {
    const partidos = [partidoBase({ id: 507, estado: 'pendiente', grupo: null, ronda: 2 })];
    const { supabaseAdmin, state } = buildSupabaseMock({ torneo: TORNEO, partidos, equipos: EQUIPOS });

    const res = await generarScoreboardsForTorneo(supabaseAdmin, 23, { emitir_tokens: true });

    assert.equal(res.created, 1);
    assert.equal(res.items[0].status, 'created');
    assert.equal(state.insertCount, 1);
  });

  it('mezcla: crea solo el jugable y saltea el finalizado', async () => {
    const partidos = [
      partidoBase({ id: 508, estado: 'pendiente' }),
      partidoBase({ id: 509, estado: 'finalizado' }),
    ];
    const { supabaseAdmin, state } = buildSupabaseMock({ torneo: TORNEO, partidos, equipos: EQUIPOS });

    const res = await generarScoreboardsForTorneo(supabaseAdmin, 23, { emitir_tokens: true });

    assert.equal(res.created, 1);
    assert.equal(res.skipped, 1);
    assert.deepEqual(state.insertedPartidoIds, [508]);
  });
});

describe('getPublicWebBase', () => {
  it('elimina slash final', () => {
    const prev = process.env.PUBLIC_WEB_BASE;
    process.env.PUBLIC_WEB_BASE = 'https://example.com/';
    assert.equal(getPublicWebBase(), 'https://example.com');
    if (prev == null) delete process.env.PUBLIC_WEB_BASE;
    else process.env.PUBLIC_WEB_BASE = prev;
  });
});
