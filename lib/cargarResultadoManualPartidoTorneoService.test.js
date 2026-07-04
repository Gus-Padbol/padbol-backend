import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  cargarResultadoManualPartidoTorneo,
  parseResultadoManualPartidoTorneoBody,
} from './torneos/cargarResultadoManualPartidoTorneoService.js';

describe('parseResultadoManualPartidoTorneoBody', () => {
  it('acepta resultado best-of-3 válido', () => {
    const parsed = parseResultadoManualPartidoTorneoBody({ goles_a: 2, goles_b: 0 });
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.resultado, {
      goles_a: 2,
      goles_b: 0,
      fuente_resultado: 'manual_admin',
    });
  });

  it('rechaza empate o marcador sin ganador claro', () => {
    assert.equal(parseResultadoManualPartidoTorneoBody({ goles_a: 1, goles_b: 1 }).valid, false);
    assert.equal(parseResultadoManualPartidoTorneoBody({ goles_a: 1, goles_b: 0 }).valid, false);
  });

  it('rechaza body incompleto', () => {
    const parsed = parseResultadoManualPartidoTorneoBody({ goles_a: 2 });
    assert.equal(parsed.valid, false);
    assert.equal(parsed.code, 'RESULTADO_INCOMPLETO');
  });
});

describe('cargarResultadoManualPartidoTorneo', () => {
  it('admin carga resultado válido y encadena servicios centrales', async () => {
    let finalizeInput = null;
    let effectsInput = null;
    const tablesTouched = [];

    const supabaseAdmin = {
      from(table) {
        tablesTouched.push(table);
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            if (table === 'torneos') {
              return Promise.resolve({ data: { id: 28 }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };

    const result = await cargarResultadoManualPartidoTorneo(
      supabaseAdmin,
      {
        torneoId: 28,
        partidoId: 45,
        body: { goles_a: 2, goles_b: 0 },
        actorId: 'admin-user-1',
      },
      {
        finalizarPartidoTorneo: async (_admin, input) => {
          finalizeInput = input;
          return {
            ok: true,
            status: 'finalized',
            reason: 'finalizado',
            partido_id: 45,
            torneo_id: 28,
            resultado: { goles_a: 2, goles_b: 0, fuente_resultado: 'manual_admin' },
            ganador_equipo_id: 71,
            updated: true,
          };
        },
        onPartidoTorneoFinalizado: async (_admin, input) => {
          effectsInput = input;
          return {
            ok: true,
            partido_id: 45,
            torneo_id: 28,
            fuente: 'manual_admin',
            advance: { status: 'advanced', reason: 'ganador_avanzado', partido_id: 45, destino_partido_id: 47 },
            scoreboard: { status: 'created', reason: 'scoreboard_creado', partido_id: 47, scoreboard_id: 'sb-next' },
          };
        },
      },
    );

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.ok, true);
    assert.equal(result.body.status, 'finalized');
    assert.equal(result.body.partido_id, 45);
    assert.equal(result.body.torneo_id, 28);
    assert.equal(result.body.ganador_equipo_id, 71);
    assert.deepEqual(result.body.resultado, { goles_a: 2, goles_b: 0 });
    assert.equal(result.body.effects.advance.status, 'advanced');
    assert.equal(result.body.effects.scoreboard.scoreboard_id, 'sb-next');

    assert.equal(finalizeInput.partidoId, 45);
    assert.equal(finalizeInput.torneoId, 28);
    assert.equal(finalizeInput.context.fuente, 'manual_admin');
    assert.equal(finalizeInput.context.actor_id, 'admin-user-1');
    assert.equal(finalizeInput.context.allowOverwrite, false);

    assert.equal(effectsInput.partidoId, 45);
    assert.equal(effectsInput.fuente, 'manual_admin');

    assert.ok(tablesTouched.every((table) => table === 'torneos'));
    assert.ok(!tablesTouched.includes('tabla_puntos'));
  });

  it('resultado inválido devuelve 400', async () => {
    const result = await cargarResultadoManualPartidoTorneo(
      {},
      { torneoId: 28, partidoId: 45, body: { goles_a: 1, goles_b: 1 } },
    );

    assert.equal(result.statusCode, 400);
    assert.equal(result.body.code, 'RESULTADO_INVALIDO');
  });

  it('partido ya finalizado con resultado distinto devuelve 409', async () => {
    const supabaseAdmin = {
      from(table) {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            if (table === 'torneos') {
              return Promise.resolve({ data: { id: 28 }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };

    let effectsCalled = false;
    const result = await cargarResultadoManualPartidoTorneo(
      supabaseAdmin,
      { torneoId: 28, partidoId: 45, body: { goles_a: 2, goles_b: 0 } },
      {
        finalizarPartidoTorneo: async () => ({
          ok: false,
          status: 'rejected',
          reason: 'partido_ya_finalizado',
          partido_id: 45,
          torneo_id: 28,
        }),
        onPartidoTorneoFinalizado: async () => {
          effectsCalled = true;
          return { ok: true };
        },
      },
    );

    assert.equal(result.statusCode, 409);
    assert.equal(result.body.code, 'partido_ya_finalizado');
    assert.equal(effectsCalled, false);
  });

  it('resultado idempotente llama efectos y responde status idempotent', async () => {
    let effectsCalled = false;

    const supabaseAdmin = {
      from(table) {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            if (table === 'torneos') {
              return Promise.resolve({ data: { id: 28 }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };

    const result = await cargarResultadoManualPartidoTorneo(
      supabaseAdmin,
      { torneoId: 28, partidoId: 45, body: { goles_a: 2, goles_b: 0 } },
      {
        finalizarPartidoTorneo: async () => ({
          ok: true,
          status: 'idempotent',
          reason: 'ya_finalizado_mismo_resultado',
          partido_id: 45,
          torneo_id: 28,
          resultado: { goles_a: 2, goles_b: 0 },
          ganador_equipo_id: 71,
          updated: false,
        }),
        onPartidoTorneoFinalizado: async () => {
          effectsCalled = true;
          return {
            ok: true,
            advance: { status: 'skipped', reason: 'no_destino', partido_id: 45 },
            scoreboard: null,
          };
        },
      },
    );

    assert.equal(result.statusCode, 200);
    assert.equal(result.body.status, 'idempotent');
    assert.equal(effectsCalled, true);
    assert.equal(result.body.effects.advance.reason, 'no_destino');
  });

  it('torneo inexistente devuelve 404', async () => {
    const supabaseAdmin = {
      from() {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };

    const result = await cargarResultadoManualPartidoTorneo(
      supabaseAdmin,
      { torneoId: 999, partidoId: 45, body: { goles_a: 2, goles_b: 0 } },
    );

    assert.equal(result.statusCode, 404);
    assert.equal(result.body.code, 'torneo_no_encontrado');
  });

  it('partido inexistente devuelve 404', async () => {
    const supabaseAdmin = {
      from(table) {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            if (table === 'torneos') {
              return Promise.resolve({ data: { id: 28 }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };

    const result = await cargarResultadoManualPartidoTorneo(
      supabaseAdmin,
      { torneoId: 28, partidoId: 999, body: { goles_a: 2, goles_b: 0 } },
      {
        finalizarPartidoTorneo: async () => ({
          ok: false,
          status: 'failed',
          reason: 'partido_no_encontrado',
          partido_id: 999,
        }),
      },
    );

    assert.equal(result.statusCode, 404);
    assert.equal(result.body.code, 'partido_no_encontrado');
  });

  it('incluye historial_sets opcional en resultado persistido', async () => {
    const historial = [{ set: 1, a: 6, b: 0 }, { set: 2, a: 6, b: 0 }];
    let finalizeInput = null;

    const supabaseAdmin = {
      from(table) {
        return {
          select() { return this; },
          eq() { return this; },
          maybeSingle() {
            if (table === 'torneos') {
              return Promise.resolve({ data: { id: 28 }, error: null });
            }
            return Promise.resolve({ data: null, error: null });
          },
        };
      },
    };

    const result = await cargarResultadoManualPartidoTorneo(
      supabaseAdmin,
      {
        torneoId: 28,
        partidoId: 45,
        body: { goles_a: 2, goles_b: 0, historial_sets: historial },
      },
      {
        finalizarPartidoTorneo: async (_admin, input) => {
          finalizeInput = input;
          return {
            ok: true,
            status: 'finalized',
            partido_id: 45,
            torneo_id: 28,
            resultado: input.resultado,
            ganador_equipo_id: 71,
          };
        },
        onPartidoTorneoFinalizado: async () => ({
          ok: true,
          advance: { status: 'skipped', reason: 'fase_grupos', partido_id: 45 },
          scoreboard: null,
        }),
      },
    );

    assert.deepEqual(finalizeInput.resultado.historial_sets, historial);
    assert.deepEqual(result.body.resultado.historial_sets, historial);
  });
});

describe('cargarResultadoManualPartidoTorneo auth scope', () => {
  it('documenta que permisos admin se aplican en server.js con requireTorneoAdminByTorneoId', () => {
    assert.equal(typeof cargarResultadoManualPartidoTorneo, 'function');
  });
});
