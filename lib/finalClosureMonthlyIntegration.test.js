import assert from 'node:assert/strict';
import test from 'node:test';
import { fixture, client, schema, configured, period, timestamp } from './fixtures/incentivesV4Fixture.js';
import { evaluateSedeIncentive } from './sedeIncentivesV4.js';
import { maybeSyncTorneoAfterScoreboardTerminated } from '../routes/scoreboard.js';
import { syncScoreboardToTorneoPartido } from '../src/scoreboard/scoreboardTorneoSyncService.js';
import { completeTournamentFromFinalScoreboard, prepareTournamentUpdate } from './torneos/tournamentCompletionService.js';
import { applyHistorialPuntoSnapshot, registrarPunto } from '../utils/scoreboardLogic.js';

// Reuse the V4 schema/projection/filter adapter and synthetic Auth. Only add the
// small mutation surface needed by the real sync/closure writers; never emulate
// their sporting or commercial decisions in the adapter.
function closureClient(tables) {
  const readOnly = client(tables);
  const writes = [];
  return {
    auth: readOnly.auth,
    writes,
    from(table) {
      const read = readOnly.from(table);
      let columns = schema[table], patch, single = false;
      read.select(columns.join(','));
      const api = {
        select(raw) {
          columns = raw === '*' ? schema[table] : raw.split(',').map(x => x.trim());
          read.select(columns.join(','));
          return api;
        },
        eq(key, value) { read.eq(key, value); return api; },
        is(key, value) { read.eq(key, value); return api; },
        order(key, options) { read.order(key, options); return api; },
        limit(count) { read.range(0, count - 1); return api; },
        maybeSingle() { single = true; return api; },
        update(value) {
          assert(['partidos', 'scoreboard_partidos', 'torneos'].includes(table), `Unexpected write ${table}`);
          for (const key of Object.keys(value)) assert(schema[table].includes(key), `Unknown write ${table}.${key}`);
          patch = structuredClone(value);
          return api;
        },
        async then(resolve, reject) {
          try {
            const result = await read;
            if (result.error) return resolve(result);
            let rows = result.data;
            if (patch) {
              for (const selected of rows) {
                const stored = tables[table].find(row => row.id === selected.id);
                assert(stored, 'Mutation requires the selected real fixture row');
                Object.assign(stored, patch);
              }
              writes.push({ table, patch, count: rows.length });
              rows = rows.map(selected => {
                const stored = tables[table].find(row => row.id === selected.id);
                return Object.fromEntries(columns.map(key => [key, stored[key]]));
              });
            }
            resolve({ data: structuredClone(single ? rows[0] ?? null : rows), error: null });
          } catch (error) { reject(error); }
        },
      };
      return api;
    },
  };
}

async function monthly(tables, requestedPeriod = period) {
  const readOnly = client(tables);
  const result = await evaluateSedeIncentive(readOnly, configured, requestedPeriod);
  assert.deepEqual(readOnly.writes, []);
  assert.equal(result.commercial_status.billing_enabled, false);
  assert.equal(result.credito_otorgado, false);
  assert.equal(result.persisted, false);
  return result;
}

test('real final-point closure feeds monthly four-goal evaluation without granting money or changing month on retry', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse(timestamp) });
  const tables = fixture({ playedMatches: 15, digitalMatches: 1 });
  const tournament = tables.torneos[0];
  const final = tables.partidos.at(-1);
  const scoreboard = tables.scoreboard_partidos[0];
  const point = tables.scoreboard_historial_puntos[0];
  const manualResults = structuredClone(tables.partidos.slice(0, -1));
  assert.equal(manualResults.length, 14);
  assert(manualResults.every(row => typeof row.resultado === 'string'));
  assert.equal(tables.equipos.length, 8);
  assert.equal(tables.reservas.length, 12);
  assert.equal(tables.sede_jugadores.length, 10);

  tournament.estado = 'en_curso';
  tournament.fecha_fin = '2026-10-30'; // Scheduled/client date cannot choose the benefit month.
  tournament.updated_at = null;
  final.estado = 'en_curso';
  final.resultado = null;
  final.ganador_equipo_id = null;
  scoreboard.sync_torneo_status = null;
  scoreboard.synced_to_torneo_at = null;
  applyHistorialPuntoSnapshot(scoreboard, point);
  const admin = closureClient(tables);

  const before = await monthly(tables);
  assert.equal(before.metrics.torneos_integrales_validos, 0);
  assert.equal(before.evaluation.cumplido, false);

  // This is the actual scoring engine and post-point hook, with real sync,
  // winner advancement and automatic closure services. Only storage/Auth are fake.
  const previousState = scoreboard.estado;
  registrarPunto(scoreboard, point.equipo);
  assert.equal(scoreboard.estado, 'terminado');
  await maybeSyncTorneoAfterScoreboardTerminated(admin, scoreboard, previousState);
  assert.equal(final.estado, 'finalizado');
  assert.equal(final.ganador_equipo_id, final.equipo_a_id);
  assert.equal(tournament.estado, 'finalizado');
  assert.equal(tournament.fecha_fin, '2026-09-04');
  assert.equal(scoreboard.synced_to_torneo_at, timestamp);
  assert.deepEqual(tables.partidos.slice(0, -1), manualResults);
  assert.deepEqual(admin.writes.map(write => write.table), ['partidos', 'scoreboard_partidos', 'torneos']);

  const complete = await monthly(tables);
  assert.equal(complete.metrics.torneos_integrales_validos, 1);
  assert.equal(complete.metrics.torneos_resultados_completos, 1);
  assert.equal(complete.metrics.reservas_validas, 12);
  assert(complete.metrics.jugadores_activos >= 10);
  assert.equal(complete.evaluation.criterios_cumplidos, 4);
  assert.equal(complete.evaluation.cumplido, true);
  assert.equal(complete.evidence[0].parejas_confirmadas, 8);
  assert.equal(complete.evidence[0].partidos_jugados_resultado_registrado, 15);
  assert.equal(complete.evidence[0].partidos_jugados_sincronizados, 1);
  assert.equal(complete.evidence[0].final_marcador_verificado, true);
  assert.equal(complete.commercial_status.projected_monthly_usd, 17);

  const twelfth = tables.reservas.pop();
  const incomplete = await monthly(tables);
  assert.equal(incomplete.metrics.torneos_integrales_validos, 1);
  assert.equal(incomplete.metrics.reservas_validas, 11);
  assert.equal(incomplete.evaluation.criterios_cumplidos, 3);
  assert.equal(incomplete.evaluation.cumplido, false);
  assert.equal(incomplete.commercial_status.projected_monthly_usd, null);
  assert.equal(incomplete.commercial_status.reference_monthly_usd, 34);
  assert.equal(incomplete.commercial_status.phase, 'objectives_in_progress');
  tables.reservas.push(twelfth);

  const completedTournament = structuredClone(tournament);
  const writesBeforeRetry = admin.writes.length;
  t.mock.timers.setTime(Date.parse('2026-10-04T15:00:00.000Z'));
  assert.equal((await syncScoreboardToTorneoPartido(admin, scoreboard.id)).reason, 'ya_sincronizado');
  assert.equal((await completeTournamentFromFinalScoreboard(admin, { scoreboardId: scoreboard.id, partidoId: final.id })).status, 'idempotent');
  assert.deepEqual(tournament, completedTournament);
  assert.equal(scoreboard.synced_to_torneo_at, timestamp);
  assert.equal(admin.writes.length, writesBeforeRetry);
  assert.equal((await monthly(tables)).evaluation.cumplido, true);
  const october = await monthly(tables, '2026-10-01');
  assert.equal(october.metrics.torneos_integrales_validos, 0);
  assert.equal(october.evaluation.cumplido, false);

  const { patch } = await prepareTournamentUpdate(admin, tournament.id, { estado: 'en_curso' });
  await admin.from('torneos').update(patch).eq('id', tournament.id);
  final.estado = 'en_curso'; // A corrected/reopened final has no sporting closure.
  const reopened = await monthly(tables);
  assert.equal(reopened.metrics.torneos_integrales_validos, 0);
  assert.equal(reopened.metrics.torneos_resultados_completos, 0);
  assert.equal(reopened.evaluation.cumplido, false);
  await assert.rejects(prepareTournamentUpdate(admin, tournament.id, { estado: 'finalizado' }),
    error => error.code === 'TORNEO_CLOSURE_UNVERIFIED');
  assert(admin.writes.every(write => ['partidos', 'scoreboard_partidos', 'torneos'].includes(write.table)));
});
