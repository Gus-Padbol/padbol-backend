import assert from 'node:assert/strict';
import test from 'node:test';
import { configured, fixture, run, userId } from './fixtures/incentivesV4Fixture.js';

function tournamentOnly(options = {}) {
  const tables = fixture(options);
  tables.reservas = [];
  return tables;
}

function putPointMonth(tables, month, indices = null) {
  tables.scoreboard_historial_puntos.forEach((row, index) => {
    if (!indices || indices.includes(index)) row.timestamp = `2026-${month}-04T14:59:00.000Z`;
  });
  tables.scoreboard_partidos.forEach((row, index) => {
    if (!indices || indices.includes(index)) {
      row.synced_to_torneo_at = `2026-${month}-04T15:00:00.000Z`;
      row.updated_at = row.synced_to_torneo_at;
    }
  });
}

test('completed matches in an open tournament count in their event month, independently of tournament goals', async () => {
  const tables = tournamentOnly();
  tables.torneos[0].estado = 'en_curso';
  tables.torneos[0].fecha_fin = '2026-10-30';
  const { result } = await run(tables);
  assert.equal(result.metrics.jugadores_activos, 16);
  assert.equal(result.evaluation.criterios.jugadores_activos, true);
  assert.equal(result.metrics.torneos_integrales_validos, 0);
  assert.equal(result.metrics.torneos_resultados_completos, 0);
  assert.equal(result.evaluation.cumplido, false);
  assert.equal(result.evidence_notes.partidos_con_actividad_fechada_en_mes, 15);
});

test('month boundary: September group matches do not all become October activity when the final closes', async () => {
  const tables = tournamentOnly();
  tables.torneos[0].fecha_fin = '2026-10-04';
  putPointMonth(tables, '10', [14]);
  const september = (await run(tables)).result;
  const october = (await run(tables, {}, configured, '2026-10-01')).result;
  assert.equal(september.metrics.jugadores_activos, 16);
  assert.equal(september.metrics.torneos_integrales_validos, 0);
  assert.equal(october.metrics.jugadores_activos, 4);
  assert.equal(october.metrics.torneos_integrales_validos, 1);
  assert.equal(october.metrics.torneos_resultados_completos, 1);
  assert.equal(october.evaluation.criterios.jugadores_activos, false);
  assert.equal(october.evidence_notes.partidos_con_actividad_fechada_en_mes, 1);
});

test('old results cannot borrow tournament.fecha_fin or recently edited metadata as an activity date', async () => {
  const tables = tournamentOnly();
  putPointMonth(tables, '08');
  tables.partidos.forEach(row => {
    row.fecha_hora = '2026-09-04T14:00:00Z';
    row.created_at = '2026-09-04T13:00:00Z';
    row.updated_at = '2026-09-04T17:00:00Z';
  });
  const { result } = await run(tables);
  assert.equal(result.metrics.jugadores_activos, 0);
  assert.equal(result.metrics.torneos_resultados_completos, 1);
  assert.equal(result.evidence_notes.partidos_evaluados_sin_actividad_fechada_en_mes, 15);
});

test('delayed sync discovers an open tournament but credits the recorded point month, not synchronization month', async () => {
  const tables = tournamentOnly();
  tables.torneos[0].estado = 'en_curso';
  tables.scoreboard_partidos.forEach(row => { row.synced_to_torneo_at = '2026-10-01T00:05:00.000Z'; });
  assert.equal((await run(tables)).result.metrics.jugadores_activos, 16);
  assert.equal((await run(tables, {}, configured, '2026-10-01')).result.metrics.jugadores_activos, 0);
});

test('manual results without a verified sporting date stay valid results and do not invent monthly players', async () => {
  const tables = tournamentOnly({ digitalMatches: 0 });
  tables.partidos.forEach(row => {
    row.fecha_hora = '2026-09-04T14:00:00Z'; // A scheduled time is not an attendance/played-date certificate.
    row.updated_at = '2026-09-04T17:00:00Z';
  });
  const { result } = await run(tables);
  assert.equal(result.metrics.torneos_resultados_completos, 1);
  assert.equal(result.evidence[0].partidos_jugados_resultado_registrado, 15);
  assert.equal(result.metrics.jugadores_activos, 0);
});

for (const date of [null, undefined, '', 'not-a-date']) {
  test(`missing/invalid point timestamp is not credited: ${String(date)}`, async () => {
    const tables = tournamentOnly();
    tables.scoreboard_historial_puntos.forEach(row => { row.timestamp = date; });
    assert.equal((await run(tables)).result.metrics.jugadores_activos, 0);
  });
}

test('the same players count again in a later month with another actual dated match, once per month', async () => {
  const tables = tournamentOnly();
  tables.torneos[0].estado = 'en_curso';
  // The same player population, distinct recorded games in each month.
  putPointMonth(tables, '10', [4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14]);
  assert.equal((await run(tables)).result.metrics.jugadores_activos, 16);
  assert.equal((await run(tables, {}, configured, '2026-10-01')).result.metrics.jugadores_activos, 16);
  assert.equal(tables.jugadores_perfil.length, 16);
});

test('duplicate games/point rows and already-counted reservation holders do not duplicate active people', async () => {
  const tables = fixture();
  tables.partidos.push(structuredClone(tables.partidos[0]));
  tables.scoreboard_historial_puntos.push({ ...tables.scoreboard_historial_puntos[0], id: userId(9999) });
  assert.equal((await run(tables)).result.metrics.jugadores_activos, 16);
});

test('an open tournament can reach ten active people before its fixture or final is complete', async () => {
  const tables = tournamentOnly();
  tables.torneos[0].estado = 'en_curso';
  tables.partidos.slice(3).forEach(row => { row.estado = 'pendiente'; row.resultado = null; });
  const { result } = await run(tables);
  assert.equal(result.metrics.jugadores_activos, 12);
  assert.equal(result.evaluation.criterios.jugadores_activos, true);
  assert.equal(result.evaluation.criterios.torneos_integrales, false);
});

test('an active replacement scoreboard invalidates the old finished match evidence instead of selecting only old synced rows', async () => {
  const tables = tournamentOnly();
  tables.partidos = tables.partidos.slice(0, 1);
  tables.scoreboard_partidos.push({ ...tables.scoreboard_partidos[0], id: userId(5555), estado: 'en_curso',
    sync_torneo_status: null, synced_to_torneo_at: null, updated_at: '2026-09-05T15:00:00.000Z' });
  assert.equal((await run(tables)).result.metrics.jugadores_activos, 0);
});

test('an invented point in the future relative to its persisted sync cannot qualify activity', async () => {
  const tables = tournamentOnly();
  tables.scoreboard_historial_puntos.forEach(row => { row.timestamp = '2026-09-05T15:00:00.000Z'; });
  assert.equal((await run(tables)).result.metrics.jugadores_activos, 0);
});

test('venue scope still excludes activity reached through a mismatching scoreboard tournament reference', async () => {
  const tables = tournamentOnly();
  tables.torneos[0].sede_id = 99;
  assert.equal((await run(tables)).result.metrics.jugadores_activos, 0);
});

test('a date without a valid sporting result, account or real participant does not count', async () => {
  for (const mutate of [
    t => t.partidos.forEach(row => { row.estado = 'cancelado'; }),
    t => t.partidos.forEach(row => { row.resultado = {}; }),
    t => { t.jugadores_perfil = []; },
    t => t.equipos.forEach(row => { row.inscripcion_estado = 'pendiente'; }),
  ]) {
    const tables = tournamentOnly(); mutate(tables);
    assert.equal((await run(tables)).result.metrics.jugadores_activos, 0);
  }
});

test('unavailable activity records yield unknown rather than a false zero or completed activity goal', async () => {
  const { result } = await run(tournamentOnly(), { failTable: 'scoreboard_partidos' });
  assert.equal(result.metrics.jugadores_activos, null);
  assert.equal(result.evaluation.detalle_criterios.jugadores_activos.state, 'unavailable');
  assert.equal(result.evidence_notes.actividad_mensual_datos_disponibles, false);
});

test('the monthly activity fix never enables billing or modifies 12 bookings / four joint goals', async () => {
  const { result, supabase } = await run(fixture({ digitalMatches: 1 }));
  assert.equal(result.metrics.reservas_validas, 12);
  assert(result.metrics.jugadores_activos >= 10);
  assert.equal(result.evaluation.criterios_requeridos, 4);
  assert.equal(result.evaluation.cumplido, true);
  assert.equal(result.commercial_status.projected_monthly_usd, 17);
  assert.equal(result.commercial_status.billing_enabled, false);
  assert.equal(result.credito_otorgado, false);
  assert.equal(result.persisted, false);
  assert.deepEqual(supabase.writes, []);
});

test('verified reservation holders can prove the active-player minimum despite unavailable scoreboard reads', async () => {
  const { result } = await run(fixture(), { failTable: 'scoreboard_partidos' });
  assert.equal(result.metrics.jugadores_activos, 12);
  assert.equal(result.evaluation.criterios.jugadores_activos, true);
  assert.equal(result.evidence_notes.actividad_mensual_conteo_minimo, true);
  assert.equal(result.metrics.torneos_integrales_validos, null);
  assert.equal(result.evaluation.cumplido, null);
  assert.equal(result.credito_otorgado, false);
});
